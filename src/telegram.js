/**
 * MOTHERSHIP — Telegram Bot Integration
 *
 * Receives messages from Telegram. Text is stored directly. Photos and
 * videos are downloaded to the inbox; the bot asks the user how to
 * process the media (on-screen / audio transcript / both), then runs
 * the processor.
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const processor = require('./processor');
const url = require('./url');
const ytdlp = require('./ytdlp');
const conversation = require('./conversation');
const hooks = require('./conversation-hooks');

// Helper: send a Mothership reply, chunked to Telegram's 4096-char limit,
// and persist it as a 'mothership' source row so conversation history sees it.
async function sendMothershipReply(chatId, replyToId, text, baseMeta = {}) {
  if (!text) return;
  const replyId = db.addMessage(text, 'mothership', 'reply', { ...baseMeta, in_reply_to: replyToId });
  // Fire-and-forget post-response synthesis. Errors are logged inside the hook.
  hooks.postResponse({
    userText: baseMeta._userText || '',
    assistantText: text,
    sourceId: replyId
  }).catch(() => {});
  const CHUNK = 3900;
  for (let i = 0; i < text.length; i += CHUNK) {
    const chunk = text.slice(i, i + CHUNK);
    try {
      await bot.sendMessage(chatId, chunk, i === 0 ? { reply_to_message_id: replyToId } : {});
    } catch (err) {
      console.error('  ⚠ Telegram sendMothershipReply failed:', err.message);
      break;
    }
  }
}

let bot = null;

// In-memory map of pending media awaiting a processing-mode choice.
// key: `${chatId}:${messageId}` → { filePath, kind, baseMeta }
const pending = new Map();

function isTransientConnectionError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') return true;
  return msg.includes('connection error') ||
         msg.includes('econnreset') ||
         msg.includes('etimedout') ||
         msg.includes('socket hang up') ||
         msg.includes('network error') ||
         msg.includes('fetch failed');
}

async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    console.log(`  ↻ Transient error in ${label}, retrying once: ${err.message}`);
    await new Promise(r => setTimeout(r, 1500));
    return fn();
  }
}

const MODE_BUTTONS = {
  reply_markup: {
    inline_keyboard: [[
      { text: '👁 On-screen', callback_data: 'mode:vision' },
      { text: '🎧 Audio only', callback_data: 'mode:audio' },
      { text: '📦 Both', callback_data: 'mode:both' }
    ]]
  }
};

async function downloadToInbox(fileId, suggestedName) {
  const inboxPath = path.resolve(process.env.DROP_FOLDER || './inbox');
  if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true });

  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  const buffer = Buffer.from(await res.arrayBuffer());

  const ext = path.extname(new URL(fileLink).pathname) || path.extname(suggestedName || '') || '.bin';
  const filename = `tg-${Date.now()}-${fileId.slice(-6)}${ext}`;
  const filePath = path.join(inboxPath, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'your_bot_token_here') return false;

  bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const from = msg.from?.first_name || 'Unknown';
    const baseMeta = {
      telegram_chat_id: chatId,
      telegram_from: from,
      telegram_message_id: msg.message_id,
      telegram_date: msg.date
    };

    // Slash commands — dispatch BEFORE photo/video/text branches
    if (msg.text && msg.text.startsWith('/')) {
      const cmd = msg.text.trim().split(/\s+/)[0];
      const arg = msg.text.trim().slice(cmd.length).trim();

      if (cmd === '/export') {
        const obsidian = require('./exporters/obsidian');
        try {
          const r = await obsidian.exportAll();
          await bot.sendMessage(chatId,
            r.skipped
              ? '⚠ OBSIDIAN_VAULT_PATH not set.'
              : `✔ Exported ${r.mirror} mirror entries and ${r.wiki} wiki entries.`,
            { reply_to_message_id: msg.message_id });
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Export failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/mirror') {
        const rows = db.getMirrorEntries({ activeOnly: true, limit: 30 });
        const byCat = {};
        for (const r of rows) (byCat[r.category] ||= []).push(r);
        const lines = ['🪞 *Quantum Mirror (top 30 active)*'];
        for (const [cat, list] of Object.entries(byCat)) {
          lines.push(`\n*${cat}*`);
          for (const e of list.slice(0, 5)) {
            lines.push(`- (${e.confidence.toFixed(2)}) ${e.content}`);
          }
        }
        await bot.sendMessage(chatId, lines.join('\n').slice(0, 4000), { reply_to_message_id: msg.message_id }).catch(() => {});
        return;
      }

      if (cmd === '/briefing') {
        const retriever = require('./memory/retriever');
        const topic = arg || 'what should Yoel focus on today';
        try {
          const block = await retriever.buildContextBlock(topic, { mirrorTopK: 5, wikiTopK: 5 });
          await bot.sendMessage(chatId, block.slice(0, 4000) || '(nothing relevant found)', { reply_to_message_id: msg.message_id });
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Briefing failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/healthcheck') {
        try {
          const hc = require('./health-check');
          const r = await hc.runNow();
          await bot.sendMessage(chatId,
            `🩺 Health check: ${r.contradictions} contradictions, ${r.decayed} decayed, ${r.gaps} gaps.`,
            { reply_to_message_id: msg.message_id });
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Health check failed: ${err.message}`).catch(() => {});
        }
        return;
      }
    }

    // PHOTO — ask mode, then process
    if (msg.photo && msg.photo.length) {
      try {
        const largest = msg.photo[msg.photo.length - 1];
        const filePath = await downloadToInbox(largest.file_id, 'photo.jpg');
        const sent = await bot.sendMessage(chatId, '📸 Photo received — how should I process it?', MODE_BUTTONS);
        pending.set(`${chatId}:${sent.message_id}`, { filePath, kind: 'image', baseMeta });
      } catch (err) {
        console.error('  ⚠ Telegram photo download failed:', err.message);
        bot.sendMessage(chatId, '⚠ Failed to download photo.');
      }
      return;
    }

    // VIDEO / VIDEO_NOTE / VIDEO DOCUMENT
    const videoObj = msg.video || msg.video_note ||
      (msg.document && msg.document.mime_type?.startsWith('video/') ? msg.document : null);

    if (videoObj) {
      try {
        const filePath = await downloadToInbox(videoObj.file_id, videoObj.file_name || 'video.mp4');
        const sent = await bot.sendMessage(chatId, '🎬 Video received — how should I process it?', MODE_BUTTONS);
        pending.set(`${chatId}:${sent.message_id}`, { filePath, kind: 'video', baseMeta });
      } catch (err) {
        console.error('  ⚠ Telegram video download failed:', err.message);
        bot.sendMessage(chatId, '⚠ Failed to download video.');
      }
      return;
    }

    // TEXT — store, then either ack or process URLs
    if (msg.text) {
      const urls = url.extractUrls(msg.text);
      db.addMessage(msg.text, 'telegram', urls.length ? 'link' : 'uncategorized', {
        ...baseMeta,
        links: urls
      });
      console.log(`  💬 Telegram text from ${from}: ${msg.text.slice(0, 80)}`);

      if (!urls.length) {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
        try {
          const reply = await conversation.respond(msg.text, { contextKind: 'text' });
          await sendMothershipReply(chatId, msg.message_id, reply, { telegram_from: from, _userText: msg.text });
        } catch (err) {
          console.error('  ⚠ Conversation failed:', err.message);
          bot.sendMessage(chatId, `⚠ Mothership couldn't respond: ${err.message}`, { reply_to_message_id: msg.message_id }).catch(() => {});
        }
        return;
      }

      let sent;
      try {
        sent = await bot.sendMessage(
          chatId,
          `🔗 Processing ${urls.length === 1 ? 'link' : `${urls.length} links`}…`,
          { reply_to_message_id: msg.message_id }
        );
      } catch (err) {
        console.error('  ⚠ Telegram sendMessage failed:', err.message);
        return;
      }

      // yt-dlp downloads land in a sibling folder so the inbox watcher
      // doesn't race the Telegram handler and double-process them.
      const downloadsPath = path.resolve(process.env.DOWNLOADS_FOLDER || './downloads');
      const results = [];
      for (const u of urls) {
        // Stage 1: try yt-dlp download (covers TikTok, YouTube, IG, X, FB, etc.)
        let downloaded = null;
        try {
          downloaded = await ytdlp.downloadVideo(u, downloadsPath);
        } catch (err) {
          if (err instanceof ytdlp.NoVideoError) {
            // Expected for non-video links — fall through to URL summary.
          } else {
            console.error(`  ⚠ yt-dlp download failed for ${u}:`, err.message);
            results.push(`⚠ ${u}\nDownload failed: ${err.message}`);
            continue;
          }
        }

        if (downloaded) {
          // Stage 2: video processing (vision + audio transcription)
          bot.editMessageText(
            `⏳ Downloaded "${downloaded.meta.title || u}" — processing (vision + audio)…`,
            { chat_id: chatId, message_id: sent.message_id }
          ).catch(() => {});

          let result;
          try {
            result = await withRetry(
              () => processor.processVideo(downloaded.filePath, {
                mode: 'both',
                source: 'telegram',
                baseMeta: { ...baseMeta, ...downloaded.meta }
              }),
              'video processing'
            );
          } catch (err) {
            console.error(`  ⚠ Video processing failed for ${u}:`, err.message);
            results.push(`⚠ ${downloaded.meta.title || u}\nProcessing failed: ${err.message}`);
            continue;
          }

          if (result?.messageId) {
            const ingContent = [result?.transcript, result?.vision?.description].filter(Boolean).join('\n\n');
            if (ingContent) hooks.postIngestion({ content: ingContent, sourceId: result.messageId }).catch(() => {});
          }
          const parts = [`🎬 ${downloaded.meta.title || u}`];
          if (downloaded.meta.uploader) parts.push(`by ${downloaded.meta.uploader}`);
          if (result?.transcript) parts.push(`\n🎧 ${result.transcript.slice(0, 1500)}${result.transcript.length > 1500 ? '…' : ''}`);
          if (result?.vision?.description) parts.push(`\n👁 ${result.vision.description}`);
          results.push(parts.join('\n'));
        } else {
          // Stage 3: URL summary fallback (non-video links)
          try {
            const r = await withRetry(() => url.processUrl(u), 'URL summary');
            results.push(`🔗 ${r.title || r.url}\n${r.summary}`);
            const linkMsgId = db.addMessage(
              `[Link] ${r.title || r.url}\n\n${r.summary}`,
              'telegram',
              'link-summary',
              { ...baseMeta, source_url: r.url, title: r.title, description: r.description }
            );
            hooks.postIngestion({ content: r.summary, sourceId: linkMsgId }).catch(() => {});
          } catch (err) {
            console.error(`  ⚠ URL summary failed for ${u}:`, err.message);
            results.push(`⚠ ${u}\nLink summary failed: ${err.message}`);
          }
        }
      }

      const extracted = results.join('\n\n');
      bot.editMessageText(`✔ Ingested ${urls.length === 1 ? 'link' : `${urls.length} links`} — thinking…`, { chat_id: chatId, message_id: sent.message_id })
        .catch(() => {});

      try {
        const sourceHint = `Yoel just sent ${urls.length === 1 ? 'a link' : `${urls.length} links`}. Here is the extracted content (title, transcript, vision read, summary):`;
        const reply = await conversation.respond(extracted, { contextKind: 'link', sourceHint });
        await sendMothershipReply(chatId, msg.message_id, reply, { telegram_from: from, links: urls, _userText: msg.text });
        bot.deleteMessage(chatId, sent.message_id).catch(() => {});
      } catch (err) {
        console.error('  ⚠ Conversation (link) failed:', err.message);
        bot.editMessageText(extracted.slice(0, 4000) + `\n\n⚠ Mothership couldn't respond: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
      }
      return;
    }
  });

  // CALLBACK QUERY — user picked a processing mode
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const key = `${chatId}:${msgId}`;
    const entry = pending.get(key);

    if (!entry) {
      bot.answerCallbackQuery(query.id, { text: 'Expired — send the file again.' });
      return;
    }

    const mode = query.data.replace('mode:', '');
    pending.delete(key);

    bot.answerCallbackQuery(query.id, { text: `Processing (${mode})…` });
    bot.editMessageText(`⏳ Processing (${mode})…`, { chat_id: chatId, message_id: msgId });

    try {
      const result = await withRetry(
        () => processor.processFile(entry.filePath, {
          mode,
          source: 'telegram',
          baseMeta: entry.baseMeta
        }),
        'media processing'
      );

      // Build a summary — full content for conversation, trimmed for display fallback
      const parts = [];
      if (result?.vision?.description) parts.push(`ON-SCREEN: ${result.vision.description}`);
      if (result?.vision?.onScreenText) parts.push(`TEXT ON SCREEN: ${result.vision.onScreenText}`);
      if (result?.transcript) parts.push(`AUDIO TRANSCRIPT: ${result.transcript}`);
      if (result?.vision?.entities?.length) parts.push(`ENTITIES: ${result.vision.entities.join(', ')}`);
      if (result?.vision?.links?.length) parts.push(`LINKS: ${result.vision.links.join(', ')}`);
      const extracted = parts.join('\n\n');

      if (result?.messageId && extracted) {
        hooks.postIngestion({ content: extracted, sourceId: result.messageId }).catch(() => {});
      }

      if (!extracted) {
        bot.editMessageText('✔ Processed (no extractable content).', { chat_id: chatId, message_id: msgId });
        return;
      }

      bot.editMessageText('✔ Processed — thinking…', { chat_id: chatId, message_id: msgId }).catch(() => {});

      try {
        const sourceHint = `Yoel just sent ${entry.kind === 'video' ? 'a video' : 'an image'}. Here is what was extracted:`;
        const reply = await conversation.respond(extracted, { contextKind: entry.kind, sourceHint });
        await sendMothershipReply(chatId, entry.baseMeta.telegram_message_id, reply, { ...entry.baseMeta, _userText: extracted });
        bot.deleteMessage(chatId, msgId).catch(() => {});
      } catch (convErr) {
        console.error('  ⚠ Conversation (media) failed:', convErr.message);
        bot.editMessageText(extracted.slice(0, 4000) + `\n\n⚠ Mothership couldn't respond: ${convErr.message}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      }
    } catch (err) {
      const detail = [
        err.name || 'Error',
        err.message,
        err.status ? `status=${err.status}` : null,
        err.cause?.code ? `cause=${err.cause.code}` : null
      ].filter(Boolean).join(' | ');
      console.error('  ⚠ Telegram media processing failed:', detail);
      if (err.stack) console.error(err.stack);
      bot.editMessageText(`⚠ Processing failed: ${detail}`, { chat_id: chatId, message_id: msgId });
    }
  });

  return true;
}

module.exports = { init };
