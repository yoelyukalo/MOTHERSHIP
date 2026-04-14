/**
 * MOTHERSHIP — Media Processor
 *
 * Central dispatcher for image/video/pdf/audio/text ingestion. Given a file
 * and a mode ('vision' | 'audio' | 'both'), it runs the right adapters,
 * writes the result to the messages table, and returns a summary.
 */

const path = require('path');
const db = require('./database');
const auth = require('./auth');
const media = require('./media');
const vision = require('./vision');
const audio = require('./audio');
const { logAction } = require('./action-logger');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
const PDF_EXTS = ['.pdf'];
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus', '.oga'];
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.htm', '.yml', '.yaml', '.srt', '.vtt'];

function kindFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (PDF_EXTS.includes(ext)) return 'pdf';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

async function processImage(filePath, { source, baseMeta = {}, userId } = {}) {
  const resolvedUserId = userId || auth.getSystemOwnerId();
  if (!resolvedUserId) throw new Error('processImage: no userId and no system owner');
  const visionResult = await vision.analyzeImage(filePath);
  const content = `[Image] ${visionResult.description || ''}${visionResult.onScreenText ? `\n\nOn-screen text:\n${visionResult.onScreenText}` : ''}`;
  const messageId = db.addMessage(content, source, 'media-image', {
    ...baseMeta,
    filepath: filePath,
    filename: path.basename(filePath),
    mode: 'vision',
    vision: visionResult,
    links: visionResult.links || []
  }, resolvedUserId);
  try {
    logAction({
      kind: 'mothership_categorize',
      subject: 'categorized as image',
      data: { detected_kind: 'image', filename: path.basename(filePath) },
      sourceType: 'ingestion',
      sourceId: messageId,
      userId: resolvedUserId
    });
  } catch {}
  return { kind: 'image', mode: 'vision', vision: visionResult, messageId };
}

async function processVideo(filePath, { mode = 'vision', source, baseMeta = {}, userId } = {}) {
  const resolvedUserId = userId || auth.getSystemOwnerId();
  if (!resolvedUserId) throw new Error('processVideo: no userId and no system owner');
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

  const messageId = db.addMessage(content, source, 'media-video', {
    ...baseMeta,
    filepath: filePath,
    filename: path.basename(filePath),
    mode,
    vision: visionResult,
    transcript,
    links,
    partial_errors: errors.length ? errors.map(e => ({ stage: e.stage, message: e.err.message, status: e.err.status, code: e.err.cause?.code })) : undefined
  }, resolvedUserId);
  try {
    logAction({
      kind: 'mothership_categorize',
      subject: 'categorized as video',
      data: { detected_kind: 'video', filename: path.basename(filePath) },
      sourceType: 'ingestion',
      sourceId: messageId,
      userId: resolvedUserId
    });
  } catch {}
  return { kind: 'video', mode, vision: visionResult, transcript, errors: errors.map(e => e.stage), messageId };
}

async function processPdf(filePath, { source, baseMeta = {}, userId } = {}) {
  const resolvedUserId = userId || auth.getSystemOwnerId();
  if (!resolvedUserId) throw new Error('processPdf: no userId and no system owner');
  const pdf = require('./pdf');
  const r = await pdf.processPdfFile(filePath, { source, baseMeta, userId: resolvedUserId });
  try {
    logAction({
      kind: 'mothership_categorize',
      subject: 'categorized as pdf',
      data: { detected_kind: 'pdf', filename: path.basename(filePath) },
      sourceType: 'ingestion',
      sourceId: r.messageId,
      userId: resolvedUserId
    });
  } catch {}
  return {
    kind: 'pdf',
    title: r.title,
    pageCount: r.pageCount,
    text: r.text,
    messageId: r.messageId,
    byteSize: r.byteSize
  };
}

async function processAudio(filePath, { source, baseMeta = {}, userId } = {}) {
  const resolvedUserId = userId || auth.getSystemOwnerId();
  if (!resolvedUserId) throw new Error('processAudio: no userId and no system owner');
  const fs = require('fs');
  const audioMod = require('./audio');
  const transcript = await audioMod.transcribeAudioFile(filePath);
  const title = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const content = `[Audio] ${title}\n\nTranscript:\n${transcript}`;
  const messageId = db.addMessage(content, source, 'audio-transcript', {
    ...baseMeta,
    filepath: filePath,
    filename: title,
    byte_size: size,
    transcript
  }, resolvedUserId);
  try {
    logAction({
      kind: 'mothership_categorize',
      subject: 'categorized as audio',
      data: { detected_kind: 'audio', filename: path.basename(filePath) },
      sourceType: 'ingestion',
      sourceId: messageId,
      userId: resolvedUserId
    });
  } catch {}
  return { kind: 'audio', title, transcript, messageId, byteSize: size };
}

async function processText(filePath, { source, baseMeta = {}, userId } = {}) {
  const resolvedUserId = userId || auth.getSystemOwnerId();
  if (!resolvedUserId) throw new Error('processText: no userId and no system owner');
  const fs = require('fs');
  const content = fs.readFileSync(filePath, 'utf-8');
  const title = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const stored = `[Text] ${title}\n\n${content.slice(0, 40000)}`;
  const truncated = content.length > 40000;
  const messageId = db.addMessage(stored, source, 'text-file', {
    ...baseMeta,
    filepath: filePath,
    filename: title,
    byte_size: size,
    text_truncated: truncated
  }, resolvedUserId);
  try {
    logAction({
      kind: 'mothership_categorize',
      subject: 'categorized as text',
      data: { detected_kind: 'text', filename: path.basename(filePath) },
      sourceType: 'ingestion',
      sourceId: messageId,
      userId: resolvedUserId
    });
  } catch {}
  return { kind: 'text', title, content, messageId, byteSize: size };
}

async function processFile(filePath, { mode = 'vision', source = 'file-drop', baseMeta = {}, userId } = {}) {
  const kind = kindFor(filePath);
  if (kind === 'image') return processImage(filePath, { source, baseMeta, userId });
  if (kind === 'video') return processVideo(filePath, { mode, source, baseMeta, userId });
  if (kind === 'pdf')   return processPdf(filePath, { source, baseMeta, userId });
  if (kind === 'audio') return processAudio(filePath, { source, baseMeta, userId });
  if (kind === 'text')  return processText(filePath, { source, baseMeta, userId });
  return null;
}

module.exports = {
  processFile, processImage, processVideo, processPdf, processAudio, processText,
  kindFor, IMAGE_EXTS, VIDEO_EXTS, PDF_EXTS, AUDIO_EXTS, TEXT_EXTS
};
