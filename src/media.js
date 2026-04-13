/**
 * MOTHERSHIP — Media utilities
 *
 * Frame extraction and audio extraction from video files using ffmpeg.
 * Uses ffmpeg-static (prebuilt binary, no native compile).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const FRAMES_DIR = path.join(__dirname, '..', 'data', 'frames');
const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hashFile(filePath) {
  return crypto.createHash('md5').update(filePath + fs.statSync(filePath).size).digest('hex').slice(0, 10);
}

function extractFrames(videoPath, { fps = 0.5, maxFrames = 30 } = {}) {
  return new Promise((resolve, reject) => {
    ensureDir(FRAMES_DIR);
    const id = hashFile(videoPath);
    const outDir = path.join(FRAMES_DIR, id);
    ensureDir(outDir);

    ffmpeg(videoPath)
      .outputOptions([`-vf fps=${fps}`, `-frames:v ${maxFrames}`])
      .output(path.join(outDir, 'frame-%03d.jpg'))
      .on('end', () => {
        const files = fs.readdirSync(outDir)
          .filter(f => f.endsWith('.jpg'))
          .sort()
          .map(f => path.join(outDir, f));
        resolve(files);
      })
      .on('error', reject)
      .run();
  });
}

function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    ensureDir(AUDIO_DIR);
    const id = hashFile(videoPath);
    const outPath = path.join(AUDIO_DIR, `${id}.mp3`);

    if (fs.existsSync(outPath)) return resolve(outPath);

    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .run();
  });
}

module.exports = { extractFrames, extractAudio };
