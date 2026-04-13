/**
 * MOTHERSHIP — File Watcher
 *
 * Watches the inbox/ drop folder. Text files are read directly.
 * Images/videos dropped in are routed through the media processor
 * using the default mode from env (VISION_DEFAULT_MODE). Files
 * downloaded by the Telegram bot are prefixed with "tg-" and are
 * intentionally skipped here — the Telegram module owns that flow so
 * it can ask the user which mode to use.
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const processor = require('./processor');
const hooks = require('./conversation-hooks');

let watcher = null;

function init(folderPath) {
  watcher = chokidar.watch(folderPath, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 100
    }
  });

  watcher.on('add', async (filePath) => {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Telegram-owned files — handled by the telegram module after the
    // user picks a processing mode. Ignore here to avoid double work.
    if (filename.startsWith('tg-')) return;

    console.log(`  📁 New file: ${filename}`);

    // Media files → processor
    const kind = processor.kindFor(filePath);
    if (kind) {
      const mode = process.env.VISION_DEFAULT_MODE || 'vision';
      try {
        const result = await processor.processFile(filePath, {
          mode,
          source: 'file-drop',
          baseMeta: {
            filename,
            filepath: filePath,
            size: fs.statSync(filePath).size,
            type: ext.slice(1)
          }
        });
        console.log(`  ✔ Processed ${kind} (${mode}): ${filename}`);
        if (result?.messageId) {
          const ingContent = [result?.transcript, result?.vision?.description].filter(Boolean).join('\n\n');
          if (ingContent) hooks.postIngestion({ content: ingContent, sourceId: result.messageId }).catch(() => {});
        }
      } catch (err) {
        console.error(`  ⚠ Media processing failed for ${filename}:`, err.message);
        db.log('error', 'watcher', `Media processing failed: ${filename}`, { error: err.message });
      }
      return;
    }

    // Text files → store content directly
    const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.yml', '.yaml'];
    if (TEXT_EXTS.includes(ext)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const messageId = db.addMessage(content, 'file-drop', 'uncategorized', {
          filename,
          filepath: filePath,
          size: fs.statSync(filePath).size,
          type: ext.slice(1)
        });
        console.log(`  ✔ Stored text file: ${filename}`);
        hooks.postIngestion({ content, sourceId: messageId }).catch(() => {});
      } catch (err) {
        console.error(`  ⚠ Failed to read text file ${filename}:`, err.message);
      }
      return;
    }

    // Unknown file type — log and skip
    console.log(`  ⚠ Unknown file type, skipping: ${filename}`);
  });

  console.log(`  👁 File watcher active on ${folderPath}`);
}

module.exports = { init };
