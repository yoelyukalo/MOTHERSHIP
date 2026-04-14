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
const auth = require('./auth');
const processor = require('./processor');
const url = require('./url');
const { ingestUrl } = require('./ingest-url');
const conversation = require('./conversation');
const hooks = require('./conversation-hooks');

// Helper: send a Mothership reply, chunked to Telegram's 4096-char limit,
// and persist it as a 'mothership' source row so conversation history sees it.
async function sendMothershipReply(chatId, replyToId, text, baseMeta = {}) {
  if (!text) return;
  const ownerId = auth.getSystemOwnerId();
  if (!ownerId) { console.warn('  ⚠ sendMothershipReply: no system owner — run bootstrap first'); return; }
  const replyId = db.addMessage(text, 'mothership', 'reply', { ...baseMeta, in_reply_to: replyToId }, ownerId);
  // Fire-and-forget post-response synthesis. Errors are logged inside the hook.
  hooks.postResponse({
    userText: baseMeta._userText || '',
    assistantText: text,
    sourceId: replyId,
    userId: ownerId
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
        const ownerId = auth.getSystemOwnerId();
        if (!ownerId) {
          await bot.sendMessage(chatId, '⚠ No system owner yet — run bootstrap first.', { reply_to_message_id: msg.message_id }).catch(() => {});
          return;
        }
        const rows = db.getMirrorEntries({ activeOnly: true, limit: 30, userId: ownerId });
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

      if (cmd === '/reflect') {
        try {
          const reflection = require('./reflection');
          const ownerId = auth.getSystemOwnerId();
          if (!ownerId) {
            await bot.sendMessage(chatId, '⚠ No system owner yet — run bootstrap first.', { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          const out = await reflection.runNow({ userId: ownerId });
          if (out.status === 'already_running') {
            await bot.sendMessage(chatId, '⏳ Reflection already running — try again in a minute.', { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          if (out.status === 'failed') {
            await bot.sendMessage(chatId, `⚠ Reflection failed: ${out.error}`, { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          const latest = db.getLatestReflection({ userId: ownerId });
          if (latest) {
            await reflection.deliverBriefing({ reflection: latest, telegramBot: bot, telegramChatId: chatId });
          }
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Reflect failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/proposals') {
        try {
          const proposals = db.getPendingPromptProposals();
          if (!proposals.length) {
            await bot.sendMessage(chatId, '✔ No pending prompt proposals.', { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          for (const p of proposals) {
            const replay = p.replay_results_json;
            let replayNote;
            if (replay?.skipped) {
              replayNote = `(replay skipped: ${replay.reason})`;
            } else if (replay) {
              const pct = Math.round((replay.agreement_rate || 0) * 100);
              replayNote = `agreement: ${pct}% over ${replay.sample_size || 0} samples`;
            } else if (p.replay_error) {
              replayNote = `(replay failed: ${p.replay_error})`;
            } else {
              replayNote = '(no replay data)';
            }
            const text = `📝 *${p.prompt_name}* v${p.base_version}\n\n${p.rationale}\n\n${replayNote}`;
            await bot.sendMessage(chatId, text, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `proposal:approve:${p.id}` },
                  { text: '❌ Reject', callback_data: `proposal:reject:${p.id}` }
                ]]
              }
            }).catch(() => {});
          }
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Proposals failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (cmd === '/pending') {
        try {
          const ownerId = auth.getSystemOwnerId();
          if (!ownerId) {
            await bot.sendMessage(chatId, '⚠ No system owner yet.', { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          const pendingRows = db.getPendingActions({ userId: ownerId });
          if (!pendingRows.length) {
            await bot.sendMessage(chatId, '✔ No pending actions.', { reply_to_message_id: msg.message_id }).catch(() => {});
            return;
          }
          for (const a of pendingRows) {
            const text = `📋 *${a.kind}*: ${a.subject}\nconf ${a.confidence.toFixed(2)}`;
            await bot.sendMessage(chatId, text, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Confirm', callback_data: `action:confirm:${a.id}` },
                  { text: '❌ Reject', callback_data: `action:reject:${a.id}` }
                ]]
              }
            }).catch(() => {});
          }
        } catch (err) {
          await bot.sendMessage(chatId, `⚠ Pending failed: ${err.message}`).catch(() => {});
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

    // NON-VIDEO DOCUMENTS — PDFs, audio files, text files, images sent as documents, etc.
    // (video documents are intercepted above by the videoObj branch)
    if (msg.document) {
      const doc = msg.document;
      let sent;
      try {
        const ownerId = auth.getSystemOwnerId();
        if (!ownerId) {
          console.warn('  ⚠ Telegram document: no system owner — run bootstrap first');
          bot.sendMessage(chatId, '⚠ No system owner yet — run bootstrap first.', { reply_to_message_id: msg.message_id }).catch(() => {});
          return;
        }
        const filePath = await downloadToInbox(doc.file_id, doc.file_name || 'document.bin');
        sent = await bot.sendMessage(
          chatId,
          `📎 Received ${doc.file_name || 'document'} — processing…`,
          { reply_to_message_id: msg.message_id }
        );

        let result;
        try {
          result = await withRetry(
            () => processor.processFile(filePath, {
              source: 'telegram',
              baseMeta: { ...baseMeta, original_filename: doc.file_name, mime_type: doc.mime_type }
            }),
            'document processing'
          );
        } catch (err) {
          console.error(`  ⚠ Document processing failed for ${doc.file_name}:`, err.message);
          await bot.editMessageText(`⚠ Processing failed: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
          return;
        }

        if (!result) {
          // Unknown file type — store a stub and acknowledge
          db.addMessage(`[Unknown file] ${doc.file_name || filePath}`, 'telegram', 'unknown-file', {
            ...baseMeta,
            filepath: filePath,
            filename: doc.file_name,
            mime_type: doc.mime_type
          }, ownerId);
          await bot.editMessageText(`⚠ Unknown file type — stored raw metadata.`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
          return;
        }

        // Build extracted content based on what kind it was
        let extracted = '';
        if (result.kind === 'pdf') extracted = `PDF: ${result.title} (${result.pageCount} pages)\n\n${result.text}`;
        else if (result.kind === 'audio') extracted = `Audio: ${result.title}\n\nTranscript:\n${result.transcript}`;
        else if (result.kind === 'text') extracted = `Text file: ${result.title}\n\n${result.content}`;
        else if (result.kind === 'image') {
          const parts = [];
          if (result.vision?.description) parts.push(`ON-SCREEN: ${result.vision.description}`);
          if (result.vision?.onScreenText) parts.push(`TEXT ON SCREEN: ${result.vision.onScreenText}`);
          extracted = parts.join('\n\n');
        }

        // Post-ingestion hook (fire-and-forget)
        if (result.messageId && extracted) {
          hooks.postIngestion({ content: extracted, sourceId: result.messageId }).catch(() => {});
        }

        await bot.editMessageText('✔ Processed — thinking…', { chat_id: chatId, message_id: sent.message_id }).catch(() => {});

        try {
          const sourceHint = `Yoel just uploaded a ${result.kind}${result.title ? ` called "${result.title}"` : ''}. Here is what was extracted:`;
          const reply = await conversation.respond(extracted, { contextKind: result.kind, sourceHint, userId: ownerId });
          await sendMothershipReply(chatId, msg.message_id, reply, { ...baseMeta, _userText: extracted });
          await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
        } catch (convErr) {
          console.error('  ⚠ Conversation (document) failed:', convErr.message);
          await bot.editMessageText(
            extracted.slice(0, 4000) + `\n\n⚠ Mothership couldn't respond: ${convErr.message}`,
            { chat_id: chatId, message_id: sent.message_id }
          ).catch(() => {});
        }
      } catch (err) {
        console.error('  ⚠ Document handling failed:', err.message);
        if (sent) {
          await bot.editMessageText(`⚠ Failed: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
        } else {
          await bot.sendMessage(chatId, `⚠ Failed to handle document: ${err.message}`).catch(() => {});
        }
      }
      return;
    }

    // VOICE NOTES and AUDIO FILES — transcribe via processFile → processAudio
    if (msg.voice || msg.audio) {
      const audioObj = msg.voice || msg.audio;
      const label = msg.voice ? 'Voice note' : (msg.audio?.title || msg.audio?.file_name || 'Audio file');
      // Telegram voice notes are OGG/opus. Audio files keep their original extension.
      const suggestedName = msg.voice ? 'voice.ogg' : (msg.audio?.file_name || 'audio.mp3');

      let sent;
      try {
        const ownerId = auth.getSystemOwnerId();
        if (!ownerId) {
          console.warn('  ⚠ Telegram audio: no system owner — run bootstrap first');
          bot.sendMessage(chatId, '⚠ No system owner yet — run bootstrap first.', { reply_to_message_id: msg.message_id }).catch(() => {});
          return;
        }
        const filePath = await downloadToInbox(audioObj.file_id, suggestedName);
        sent = await bot.sendMessage(chatId, `🎧 Received ${label} — transcribing…`, { reply_to_message_id: msg.message_id });

        let result;
        try {
          result = await withRetry(
            () => processor.processFile(filePath, {
              source: 'telegram',
              baseMeta: {
                ...baseMeta,
                duration: audioObj.duration,
                mime_type: audioObj.mime_type,
                original_filename: msg.audio?.file_name,
                performer: msg.audio?.performer,
                audio_title: msg.audio?.title
              }
            }),
            'audio processing'
          );
        } catch (err) {
          console.error(`  ⚠ Audio processing failed:`, err.message);
          await bot.editMessageText(`⚠ Transcription failed: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
          return;
        }

        if (!result) {
          await bot.editMessageText(`⚠ Couldn't process audio.`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
          return;
        }

        const extracted = `${label}\n\nTranscript:\n${result.transcript || ''}`;
        if (result.messageId && result.transcript) {
          hooks.postIngestion({ content: result.transcript, sourceId: result.messageId }).catch(() => {});
        }

        await bot.editMessageText('✔ Transcribed — thinking…', { chat_id: chatId, message_id: sent.message_id }).catch(() => {});

        try {
          const sourceHint = `Yoel just sent a ${msg.voice ? 'voice note' : 'audio file'}. Transcript:`;
          const reply = await conversation.respond(extracted, { contextKind: 'audio', sourceHint, userId: ownerId });
          await sendMothershipReply(chatId, msg.message_id, reply, { ...baseMeta, _userText: extracted });
          await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
        } catch (convErr) {
          console.error('  ⚠ Conversation (audio) failed:', convErr.message);
          await bot.editMessageText(
            extracted.slice(0, 4000) + `\n\n⚠ Mothership couldn't respond: ${convErr.message}`,
            { chat_id: chatId, message_id: sent.message_id }
          ).catch(() => {});
        }
      } catch (err) {
        console.error('  ⚠ Voice/audio handling failed:', err.message);
        if (sent) {
          await bot.editMessageText(`⚠ Failed: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
        } else {
          await bot.sendMessage(chatId, `⚠ Failed to handle audio: ${err.message}`).catch(() => {});
        }
      }
      return;
    }

    // TEXT — store, then either ack or process URLs
    if (msg.text) {
      const urls = url.extractUrls(msg.text);
      const ownerId = auth.getSystemOwnerId();
      if (!ownerId) {
        console.warn('  ⚠ Telegram text: no system owner — message not stored (run bootstrap first)');
      } else {
        db.addMessage(msg.text, 'telegram', urls.length ? 'link' : 'uncategorized', {
          ...baseMeta,
          links: urls
        }, ownerId);
      }
      console.log(`  💬 Telegram text from ${from}: ${msg.text.slice(0, 80)}`);

      if (!urls.length) {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
        try {
          const reply = await conversation.respond(msg.text, { contextKind: 'text', userId: ownerId });
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

      const results = [];
      for (const u of urls) {
        try {
          bot.editMessageText(`⏳ Ingesting ${u}…`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
          const r = await ingestUrl(u, {
            source: 'telegram',
            baseMeta: { ...baseMeta, source_url: u }
          });
          results.push(r.display);
          if (r.messageId && r.content) {
            hooks.postIngestion({ content: r.content, sourceId: r.messageId }).catch(() => {});
          }
        } catch (err) {
          console.error(`  ⚠ Ingest failed for ${u}:`, err.message);
          results.push(`⚠ ${u}\n${err.message}`);
        }
      }

      const extracted = results.join('\n\n');
      bot.editMessageText(`✔ Ingested ${urls.length === 1 ? 'link' : `${urls.length} links`} — thinking…`, { chat_id: chatId, message_id: sent.message_id })
        .catch(() => {});

      try {
        const sourceHint = `Yoel just sent ${urls.length === 1 ? 'a link' : `${urls.length} links`}. Here is the extracted content (title, transcript, vision read, summary):`;
        const reply = await conversation.respond(extracted, { contextKind: 'link', sourceHint, userId: ownerId });
        await sendMothershipReply(chatId, msg.message_id, reply, { telegram_from: from, links: urls, _userText: msg.text });
        bot.deleteMessage(chatId, sent.message_id).catch(() => {});
      } catch (err) {
        console.error('  ⚠ Conversation (link) failed:', err.message);
        bot.editMessageText(extracted.slice(0, 4000) + `\n\n⚠ Mothership couldn't respond: ${err.message}`, { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
      }
      return;
    }
  });

  // CALLBACK QUERY — user picked a processing mode, or confirmed/rejected an action/proposal
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    // --- Phase 5: action confirm/reject ---
    if (query.data?.startsWith('action:')) {
      const parts = query.data.split(':');
      const verb = parts[1];
      const actionId = parts.slice(2).join(':'); // in case the id itself contains colons
      const actionLogger = require('./action-logger');
      try {
        if (verb === 'confirm') actionLogger.confirmPendingAction(actionId);
        else if (verb === 'reject') actionLogger.rejectPendingAction(actionId);
        bot.answerCallbackQuery(query.id, { text: `action ${verb}ed` }).catch(() => {});
        bot.editMessageText(`✔ ${verb}ed`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      } catch (err) {
        bot.answerCallbackQuery(query.id, { text: `failed: ${err.message}` }).catch(() => {});
      }
      return;
    }

    // --- Phase 5: proposal approve/reject ---
    if (query.data?.startsWith('proposal:')) {
      const parts = query.data.split(':');
      const verb = parts[1];
      const proposalId = parts.slice(2).join(':');
      try {
        const proposal = db.getPromptProposal(proposalId);
        if (!proposal || proposal.status !== 'pending') {
          bot.answerCallbackQuery(query.id, { text: 'already resolved' }).catch(() => {});
          return;
        }
        if (verb === 'approve') {
          const registry = require('./prompts/registry');
          registry.createVersion(proposal.prompt_name, proposal.proposed_body, {
            createdBy: 'reflection-telegram',
            parentVersion: proposal.base_version,
            activate: true
          });
          db.updatePromptProposalStatus(proposalId, 'approved');
        } else if (verb === 'reject') {
          db.updatePromptProposalStatus(proposalId, 'rejected');
        }
        bot.answerCallbackQuery(query.id, { text: `${verb}ed` }).catch(() => {});
        bot.editMessageText(`✔ ${verb}ed ${proposal.prompt_name}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      } catch (err) {
        bot.answerCallbackQuery(query.id, { text: `failed: ${err.message}` }).catch(() => {});
      }
      return;
    }

    // --- Existing media mode-picker callbacks (mode:*) — keep below ---
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
        const ownerId = auth.getSystemOwnerId();
        if (!ownerId) {
          console.warn('  ⚠ Telegram callback media: no system owner — run bootstrap first');
          bot.editMessageText('⚠ No system owner yet — run bootstrap first.', { chat_id: chatId, message_id: msgId }).catch(() => {});
          return;
        }
        const sourceHint = `Yoel just sent ${entry.kind === 'video' ? 'a video' : 'an image'}. Here is what was extracted:`;
        const reply = await conversation.respond(extracted, { contextKind: entry.kind, sourceHint, userId: ownerId });
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
