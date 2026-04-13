/**
 * MOTHERSHIP — Audio Adapter
 *
 * Transcribes audio from video or audio files using OpenAI Whisper.
 * Swappable — replace with local whisper.cpp later by keeping the same
 * transcribe(filePath) interface.
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const media = require('./media');

const MODEL = process.env.AUDIO_MODEL || 'whisper-1';

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set (required for audio transcription)');
  // maxRetries is 0 because the SDK can't rewind a consumed ReadStream —
  // we do our own retry loop below and hand it a fresh stream each time.
  client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 });
  return client;
}

function isTransientConnectionError(err) {
  const code = err?.code || err?.cause?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EPIPE' || code === 'ECONNABORTED') return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('connection error') ||
         msg.includes('econnreset') ||
         msg.includes('socket hang up') ||
         msg.includes('fetch failed') ||
         msg.includes('network error');
}

async function transcribeAudioFile(audioPath) {
  const c = getClient();
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await c.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: MODEL
      });
      logUsage(audioPath, result.text?.length || 0);
      return result.text || '';
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isTransientConnectionError(err)) throw err;
      const delay = 1000 * Math.pow(2, attempt - 1);
      console.log(`  ↻ Whisper upload attempt ${attempt}/${maxAttempts} failed (${err.cause?.code || err.code || err.message}); retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function transcribeVideo(videoPath) {
  const audioPath = await media.extractAudio(videoPath);
  return transcribeAudioFile(audioPath);
}

function logUsage(file, chars) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), file: path.basename(file), chars }) + '\n';
    fs.appendFileSync(path.join(dir, 'audio-usage.jsonl'), line);
  } catch { /* never break on logging */ }
}

module.exports = { transcribeAudioFile, transcribeVideo };
