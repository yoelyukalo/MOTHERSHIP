/**
 * MOTHERSHIP — Media Processor
 *
 * Central dispatcher for image/video ingestion. Given a file and a mode
 * ('vision' | 'audio' | 'both'), it runs the right adapters, writes the
 * result to the messages table, and returns a summary.
 */

const path = require('path');
const db = require('./database');
const media = require('./media');
const vision = require('./vision');
const audio = require('./audio');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];

function kindFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

async function processImage(filePath, { source, baseMeta = {} }) {
  const visionResult = await vision.analyzeImage(filePath);
  const content = `[Image] ${visionResult.description || ''}${visionResult.onScreenText ? `\n\nOn-screen text:\n${visionResult.onScreenText}` : ''}`;
  db.addMessage(content, source, 'media-image', {
    ...baseMeta,
    filepath: filePath,
    filename: path.basename(filePath),
    mode: 'vision',
    vision: visionResult,
    links: visionResult.links || []
  });
  return { kind: 'image', mode: 'vision', vision: visionResult };
}

async function processVideo(filePath, { mode = 'vision', source, baseMeta = {} }) {
  const fps = parseFloat(process.env.VISION_FPS || '0.5');
  const maxFrames = parseInt(process.env.VISION_MAX_FRAMES || '12', 10);

  let visionResult = null;
  let transcript = null;
  const errors = [];

  if (mode === 'vision' || mode === 'both') {
    try {
      const frames = await media.extractFrames(filePath, { fps, maxFrames });
      visionResult = await vision.analyzeFrames(frames);
    } catch (err) {
      errors.push({ stage: 'vision', err });
      console.error(`  ⚠ Vision stage failed: ${err.name || 'Error'}: ${err.message}${err.status ? ` (status ${err.status})` : ''}${err.cause?.code ? ` cause=${err.cause.code}` : ''}`);
    }
  }

  if (mode === 'audio' || mode === 'both') {
    try {
      transcript = await audio.transcribeVideo(filePath);
    } catch (err) {
      errors.push({ stage: 'audio', err });
      console.error(`  ⚠ Audio stage failed: ${err.name || 'Error'}: ${err.message}${err.status ? ` (status ${err.status})` : ''}${err.cause?.code ? ` cause=${err.cause.code}` : ''}`);
    }
  }

  if (errors.length && !visionResult && !transcript) {
    const first = errors[0];
    const err = new Error(`${first.stage} failed: ${first.err.name || 'Error'}: ${first.err.message}${first.err.status ? ` (status ${first.err.status})` : ''}${first.err.cause?.code ? ` (${first.err.cause.code})` : ''}`);
    err.cause = first.err;
    throw err;
  }

  const parts = [];
  if (transcript) parts.push(`Transcript:\n${transcript}`);
  if (visionResult?.description) parts.push(`Visual:\n${visionResult.description}`);
  if (visionResult?.onScreenText) parts.push(`On-screen text:\n${visionResult.onScreenText}`);
  const content = `[Video] ${parts.join('\n\n') || path.basename(filePath)}`;

  const links = visionResult?.links || [];

  db.addMessage(content, source, 'media-video', {
    ...baseMeta,
    filepath: filePath,
    filename: path.basename(filePath),
    mode,
    vision: visionResult,
    transcript,
    links,
    partial_errors: errors.length ? errors.map(e => ({ stage: e.stage, message: e.err.message, status: e.err.status, code: e.err.cause?.code })) : undefined
  });

  return { kind: 'video', mode, vision: visionResult, transcript, errors: errors.map(e => e.stage) };
}

async function processFile(filePath, { mode = 'vision', source = 'file-drop', baseMeta = {} } = {}) {
  const kind = kindFor(filePath);
  if (kind === 'image') return processImage(filePath, { source, baseMeta });
  if (kind === 'video') return processVideo(filePath, { mode, source, baseMeta });
  return null;
}

module.exports = { processFile, processImage, processVideo, kindFor, IMAGE_EXTS, VIDEO_EXTS };
