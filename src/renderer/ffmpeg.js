'use strict';
// Finds an ffmpeg binary without needing root: ffmpeg-static (npm) -> FFMPEG_PATH -> system ffmpeg.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

let cached = null;

function ffmpegPath() {
  if (cached) return cached;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); } catch (_) { /* optional */ }
  candidates.push('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  for (const c of candidates) {
    try {
      if (c.includes('/') && !fs.existsSync(c)) continue;
      const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 15000 });
      if (r.status === 0) {
        try { fs.chmodSync(c, 0o755); } catch (_) { /* fine */ }
        cached = c;
        return c;
      }
    } catch (_) { /* try next */ }
  }
  throw new Error('ffmpeg not found. Run "npm install" (installs ffmpeg-static) or set FFMPEG_PATH in .env.');
}

// Run ffmpeg, resolve with stderr text. Rejects with the tail of stderr on failure.
function run(args, { timeoutMs = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onProgress) onProgress(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(-1500)}`));
    });
  });
}

// Media duration in seconds (parses ffmpeg's "Duration:" line; no ffprobe needed).
async function duration(file) {
  const out = await new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', () => resolve(err));
    p.on('error', () => resolve(''));
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`Could not read duration of ${file}`);
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function versionLine() {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-version'], { timeout: 15000 });
  return String(r.stdout || '').split('\n')[0];
}

module.exports = { ffmpegPath, run, duration, versionLine };
