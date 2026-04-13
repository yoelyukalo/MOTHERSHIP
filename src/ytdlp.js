/**
 * MOTHERSHIP — yt-dlp Wrapper
 *
 * Downloads videos from any yt-dlp supported site (TikTok, YouTube,
 * Instagram, X, Facebook, etc.) into the inbox folder so the media
 * processor can run vision + audio transcription on them.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const MAX_DURATION_SECONDS = parseInt(process.env.YTDLP_MAX_DURATION || '1200', 10);

class NoVideoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoVideoError';
  }
}

function run(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const combined = `${stderr}\n${stdout}`.toLowerCase();
        if (combined.includes('unsupported url') ||
            combined.includes('no video') ||
            combined.includes('does not contain a video') ||
            combined.includes('no media found')) {
          reject(new NoVideoError(stderr.trim() || stdout.trim() || 'no video at URL'));
        } else {
          reject(new Error(`yt-dlp exited ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      }
    });
  });
}

async function getInfo(url) {
  const { stdout } = await run(['--dump-single-json', '--no-playlist', '--no-warnings', url]);
  return JSON.parse(stdout);
}

async function downloadVideo(targetUrl, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const info = await getInfo(targetUrl);
  if (info.duration && info.duration > MAX_DURATION_SECONDS) {
    throw new Error(`video too long (${Math.round(info.duration)}s > ${MAX_DURATION_SECONDS}s cap)`);
  }

  const stamp = Date.now();
  const outTemplate = path.join(outDir, `yt-${stamp}-%(id)s.%(ext)s`);
  await run([
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--restrict-filenames',
    '-f', 'mp4/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    targetUrl
  ]);

  const downloaded = fs.readdirSync(outDir)
    .filter(f => f.startsWith(`yt-${stamp}-`))
    .map(f => path.join(outDir, f));
  if (!downloaded.length) throw new Error('yt-dlp reported success but no file found');

  const filePath = downloaded.find(f => /\.(mp4|mkv|webm|mov)$/i.test(f)) || downloaded[0];
  return {
    filePath,
    meta: {
      source_url: info.webpage_url || targetUrl,
      title: info.title || '',
      uploader: info.uploader || info.channel || '',
      duration: info.duration || null,
      description: info.description || '',
      extractor: info.extractor_key || info.extractor || ''
    }
  };
}

module.exports = { downloadVideo, getInfo, NoVideoError };
