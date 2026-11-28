'use strict';
// Finds an ffmpeg binary without needing root: ffmpeg-static (npm) -> FFMPEG_PATH -> system ffmpeg.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

let cached = null;

function ffmpegPath() {
  if (cached) return cached;
  const candidates = [], tried = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); else tried.push('ffmpeg-static: no binary for this system'); }
  catch (e) { tried.push(`ffmpeg-static: not installed (${e.code || e.message})`); }
  candidates.push('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  for (const c of candidates) {
    try {
      if (c.includes('/') && !fs.existsSync(c)) { tried.push(`${c}: file missing`); continue; }
      if (c.includes('/')) { try { fs.chmodSync(c, 0o755); } catch (_) { /* may not own it */ } } // npm on some hosts drops the run permission
      const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000 });
      if (r.status === 0) { cached = c; return c; }
      tried.push(`${c}: ${r.error ? r.error.code || r.error.message : `exit ${r.status}${r.signal ? ` (${r.signal})` : ''} ${String(r.stderr || '').trim().slice(0, 150)}`}`);
    } catch (e) { tried.push(`${c}: ${e.message}`); }
  }
  throw new Error('ffmpeg not found or not runnable on this server. What was tried:\n- ' + tried.join('\n- ')
    + '\nFix: in the server terminal run  node node_modules/ffmpeg-static/install.js  (downloads ffmpeg), or set FFMPEG_PATH to an ffmpeg binary, then restart the app.');
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
