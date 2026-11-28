'use strict';
// Finds an ffmpeg binary without needing root: ffmpeg-static (npm) -> FFMPEG_PATH -> system ffmpeg.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

let cached = null;

// On shared hosting (CloudLinux) the account has a limit on processes/threads. When it is reached, starting
// ffmpeg fails with EAGAIN. Keep thread counts low there, and retry for a bit when it happens.
const LOW = () => { const t = String(process.env.RENDER_THREADS || require('../config').RENDER_THREADS || '0'); return t !== '0' ? t : ''; };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LIMIT_HINT = 'EAGAIN means the hosting account hit its limit on processes/threads (shared hosting). Close old copies of the app, set NODE_OPTIONS=--v8-pool-size=2 and UV_THREADPOOL_SIZE=2 in the app\'s environment variables, keep RENDER_THREADS=1, and restart. If it continues, ask your host to raise the process (NPROC) limit.';

// spawn() that waits and retries while the process limit is reached
function spawnSafe(cmd, args, opts) {
  let p;
  for (let i = 0; i < 5; i++) {
    p = spawn(cmd, args, opts);
    if (p.pid) return p;
    p.on('error', () => {}); // the failed attempt reports its error asynchronously; ignore it
    if (i < 4) sleepSync(1500 * (i + 1));
  }
  const e = new Error(`Could not start ffmpeg: the server's process limit is reached (EAGAIN). ${LIMIT_HINT}`);
  const fake = new (require('events').EventEmitter)();
  Object.assign(fake, { stdin: null, stdout: null, stderr: new (require('stream').PassThrough)(), kill() {} });
  process.nextTick(() => fake.emit('error', e));
  return fake;
}

// Fewer ffmpeg threads on small plans (each thread counts toward the hosting process limit)
function limitThreads(args) {
  const n = LOW();
  if (!n || args.includes('-filter_threads')) return args;
  const out = ['-filter_threads', n, '-filter_complex_threads', n, ...args];
  if (!args.includes('-threads')) out.splice(out.length - 1, 0, '-threads', n);
  return out;
}

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
      let r;
      for (let i = 0; i < 5; i++) { r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000 }); if (!(r.error && r.error.code === 'EAGAIN')) break; sleepSync(2000 * (i + 1)); }
      if (r.status === 0) { cached = c; return c; }
      if (r.error && r.error.code === 'EAGAIN') { tried.push(`${c}: EAGAIN`); throw Object.assign(new Error(`ffmpeg is installed but the server refused to start it (EAGAIN).\n${LIMIT_HINT}`), { tried }); }
      tried.push(`${c}: ${r.error ? r.error.code || r.error.message : `exit ${r.status}${r.signal ? ` (${r.signal})` : ''} ${String(r.stderr || '').trim().slice(0, 150)}`}`);
    } catch (e) { if (e.tried) throw e; tried.push(`${c}: ${e.message}`); }
  }
  throw new Error('ffmpeg not found or not runnable on this server. What was tried:\n- ' + tried.join('\n- ')
    + '\nFix: in the server terminal run  node node_modules/ffmpeg-static/install.js  (downloads ffmpeg), or set FFMPEG_PATH to an ffmpeg binary, then restart the app.');
}

// Run ffmpeg, resolve with stderr text. Rejects with the tail of stderr on failure.
function run(args, { timeoutMs = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawnSafe(ffmpegPath(), ['-hide_banner', '-y', ...limitThreads(args)], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    const p = spawnSafe(ffmpegPath(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
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

module.exports = { ffmpegPath, run, duration, versionLine, spawnSafe, limitThreads };
