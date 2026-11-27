'use strict';
// Sound effects and background music, synthesised in code (no downloads, no licences, no copyright claims).
// Everything is written as 48 kHz stereo WAV files into the film's out/.sound folder and mixed by audio.js.
const fs = require('fs');
const path = require('path');

const SR = 48000;

// ------------------------------------------------------------------ WAV + small DSP helpers
function writeWav(file, L, R = L) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}
function normalize(arrs, peak = 0.85) {
  let m = 1e-9;
  for (const a of arrs) for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  for (const a of arrs) for (let i = 0; i < a.length; i++) a[i] *= peak / m;
}
// seeded random so the same film always gets the same sounds
function rng(seed = 1) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// state-variable band-pass, frequency can change per sample
function svf() { let lo = 0, bp = 0; return (x, f, q = 0.7) => { const F = 2 * Math.sin(Math.PI * Math.min(f, SR / 6) / SR); lo += F * bp; const hp = x - lo - q * bp; bp += F * hp; return { lo, bp, hp }; }; }
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ------------------------------------------------------------------ sound effects
const SFX = {
  // air sweeping past: noise through a band-pass that rises then falls
  whoosh(len = 0.7, seed = 3) {
    const n = Math.round(len * SR), L = new Float32Array(n), R = new Float32Array(n), r = rng(seed), f1 = svf(), f2 = svf();
    for (let i = 0; i < n; i++) {
      const t = i / n, env = Math.sin(Math.PI * Math.pow(t, 0.8)) ** 2, f = 300 + 2600 * Math.sin(Math.PI * t);
      L[i] = f1(r() * 2 - 1, f, 0.5).bp * env; R[i] = f2(r() * 2 - 1, f * 1.07, 0.5).bp * env * (0.6 + 0.4 * t);
    }
    normalize([L, R], 0.7); return [L, R];
  },
  // soft paper slide for photos and documents landing on the board
  paper(len = 0.35, seed = 5) {
    const n = Math.round(len * SR), L = new Float32Array(n), r = rng(seed), f = svf();
    for (let i = 0; i < n; i++) { const t = i / n; L[i] = f(r() * 2 - 1, 2500 + 2000 * t, 0.9).bp * Math.sin(Math.PI * t) * (1 - t * 0.5); }
    normalize([L], 0.5); return [L, L];
  },
  // rubber stamp: low thump plus a short slap
  stamp(len = 0.35, seed = 7) {
    const n = Math.round(len * SR), L = new Float32Array(n), r = rng(seed);
    for (let i = 0; i < n; i++) { const t = i / SR; L[i] = Math.sin(2 * Math.PI * (95 - 40 * t) * t) * Math.exp(-18 * t) + (r() * 2 - 1) * Math.exp(-70 * t) * 0.5; }
    normalize([L], 0.9); return [L, L];
  },
  // cinematic hit for titles and big reveals: falling sub tone, noise burst, long tail
  impact(len = 2.2, seed = 11) {
    const n = Math.round(len * SR), L = new Float32Array(n), R = new Float32Array(n), r = rng(seed), f = svf();
    for (let i = 0; i < n; i++) {
      const t = i / SR, sub = Math.sin(2 * Math.PI * (55 + 50 * Math.exp(-8 * t)) * t) * Math.exp(-2.2 * t);
      const nz = f(r() * 2 - 1, 900, 0.8).lo * Math.exp(-5 * t) * 0.6;
      L[i] = sub + nz; R[i] = sub + nz * 0.8;
    }
    normalize([L, R], 0.9); return [L, R];
  },
  // camera shutter: two sharp clicks
  shutter(len = 0.18, seed = 13) {
    const n = Math.round(len * SR), L = new Float32Array(n), r = rng(seed);
    for (let i = 0; i < n; i++) { const t = i / SR; const c = Math.exp(-350 * t) + (t > 0.07 ? 0.7 * Math.exp(-350 * (t - 0.07)) : 0); L[i] = (r() * 2 - 1) * c; }
    normalize([L], 0.6); return [L, L];
  },
  // typewriter keys for "type" text animations; len = how long the typing lasts
  typing(len = 1.5, seed = 17) {
    const n = Math.round(len * SR), L = new Float32Array(n), r = rng(seed), f = svf();
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (i >= next) { next = i + Math.round((0.055 + r() * 0.06) * SR); }
      const since = (i - (next - Math.round(0.08 * SR))) / SR;
      const k = since >= 0 && since < 0.03 ? Math.exp(-180 * since) : 0;
      L[i] = f((r() * 2 - 1) * k, 3200, 0.6).bp;
    }
    normalize([L], 0.45); return [L, L];
  },
  // clock ticks while a counter runs
  ticks(len = 1.5) {
    const n = Math.round(len * SR), L = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR, m = t % 0.08; L[i] = Math.sin(2 * Math.PI * 1900 * m) * Math.exp(-90 * m) * (1 - 0.5 * t / len); }
    normalize([L], 0.35); return [L, L];
  },
  // rising tension before a reveal
  riser(len = 1.6, seed = 19) {
    const n = Math.round(len * SR), L = new Float32Array(n), r = rng(seed), f = svf();
    for (let i = 0; i < n; i++) { const t = i / n; L[i] = (f(r() * 2 - 1, 200 + 4000 * t * t, 0.4).bp * 0.7 + Math.sin(2 * Math.PI * (120 + 500 * t * t) * i / SR) * 0.3) * t * t; }
    normalize([L], 0.6); return [L, L];
  },
};
const SFX_VOLUME = { whoosh: 0.32, paper: 0.22, stamp: 0.55, impact: 0.6, shutter: 0.3, typing: 0.22, ticks: 0.16, riser: 0.35 };

// File for one effect (cached per length), returns path
function sfxFile(dir, name, len) {
  const key = len ? `${name}_${len.toFixed(1)}` : name;
  const f = path.join(dir, 'out', '.sound', `sfx_${key}.wav`);
  if (!fs.existsSync(f)) writeWav(f, ...SFX[name](len || undefined));
  return f;
}

// Decide which effects go where, from what appears on screen. Returns [{name, at (s), len?, volume}]
function placeSfx(tl) {
  const film = tl.film;
  if (film.sfx === false) return [];
  const master = (film.sfx && typeof film.sfx === 'object' && film.sfx.volume != null) ? +film.sfx.volume : 1;
  const out = [];
  const add = (name, at, len, vol = 1) => {
    if (!SFX[name] || !(at >= 0) || at > tl.total) return;
    // don't stack the same sound: keep at least 0.3 s apart
    if (out.some((x) => x.name === name && Math.abs(x.at - at) < 0.3)) return;
    out.push({ name, at, len, volume: SFX_VOLUME[name] * vol * master });
  };
  for (const sc of tl.scenes) {
    if (sc.index > 0 && sc.transition !== 'fade' && sc.transition !== 'dip') add('whoosh', Math.max(0, sc.start - 0.32));
    for (const el of sc.elements || []) {
      const own = el.sfx;
      if (own === 'none' || own === false) continue;
      let at;
      try { at = sc.start + sc.resolveAt(el.enter && el.enter.at != null ? el.enter.at : 0); } catch (_) { continue; }
      const fx = (el.enter && el.enter.fx) || '';
      const dur = (el.enter && el.enter.dur) || (fx === 'type' ? 1.5 : 0.7);
      if (typeof own === 'string' && SFX[own]) { add(own, at, own === 'typing' || own === 'ticks' ? dur : 0); continue; }
      if (el.type === 'stamp') add('stamp', at + 0.22);
      else if (el.type === 'title') add('impact', at);
      else if (['photo', 'clipping', 'document', 'note'].includes(el.type)) add(fx === 'flash' ? 'shutter' : 'paper', at + 0.05, 0, 0.9);
      else if (fx === 'type' && ['text', 'label'].includes(el.type)) add('typing', at, Math.min(4, dur));
      else if (el.type === 'counter') add('ticks', at, Math.min(4, el.dur || 1.5));
    }
  }
  return out;
}

// ------------------------------------------------------------------ music beds
// Each mood: chord progression (MIDI notes), seconds per chord, extras. Slow, quiet, made to sit under narration.
const MOODS = {
  wonder: { chords: [[48, 55, 60, 64, 67], [45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [43, 50, 55, 59, 62]], len: 8, bells: true },
  tense: { chords: [[45, 52, 57, 60], [45, 52, 56, 60], [41, 48, 53, 56], [44, 51, 56, 59]], len: 8, pulse: 1.1 },
  sad: { chords: [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [36, 43, 48, 52, 55], [43, 50, 55, 59, 62]], len: 9 },
  epic: { chords: [[38, 45, 50, 53, 57], [34, 41, 46, 50, 53], [36, 43, 48, 52, 55], [41, 48, 53, 57, 60]], len: 6, drum: 2 },
  calm: { chords: [[48, 55, 60, 64], [53, 60, 65, 69], [50, 57, 62, 65], [55, 62, 67, 71]], len: 10, bells: true },
  mystery: { chords: [[40, 47, 52, 55], [41, 48, 53, 56], [40, 47, 52, 55], [38, 45, 50, 53]], len: 9, pulse: 1.6 },
};

function synthMusic(mood, seconds, seed = 23) {
  const M = MOODS[mood] || MOODS.wonder;
  const n = Math.round((seconds + 2) * SR);
  const L = new Float32Array(n), R = new Float32Array(n), r = rng(seed);
  const segN = Math.round(M.len * SR), fade = Math.round(1.6 * SR);
  // pads: each chord fades in/out and overlaps the next one, with slow vibrato and a few soft harmonics
  for (let c = 0; c * segN < n; c++) {
    const chord = M.chords[c % M.chords.length];
    const s0 = c * segN, s1 = Math.min(n, s0 + segN + fade);
    chord.forEach((note, k) => {
      const f = midi(note), pan = (k / Math.max(1, chord.length - 1)) - 0.5, ph = r() * 6.28;
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / SR, x = i - s0;
        const env = Math.min(1, x / fade) * Math.min(1, (s1 - i) / fade);
        const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 0.2 * t + ph);
        const w = 2 * Math.PI * f * vib * t + ph;
        const v = (Math.sin(w) + 0.32 * Math.sin(2 * w) + 0.12 * Math.sin(3 * w)) * env * (k === 0 ? 0.9 : 0.45);
        L[i] += v * (0.5 - pan * 0.5); R[i] += v * (0.5 + pan * 0.5);
      }
    });
  }
  // heartbeat pulse for tense / mystery moods
  if (M.pulse) for (let t = 0.5; t < seconds; t += M.pulse) for (const off of [0, 0.22]) {
    const i0 = Math.round((t + off) * SR);
    for (let i = 0; i < 0.25 * SR && i0 + i < n; i++) { const tt = i / SR, v = Math.sin(2 * Math.PI * 52 * tt) * Math.exp(-14 * tt) * (off ? 0.55 : 0.8) * 1.4; L[i0 + i] += v; R[i0 + i] += v; }
  }
  // slow big drum for epic
  if (M.drum) for (let t = 0.2; t < seconds; t += M.drum) {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < 0.6 * SR && i0 + i < n; i++) { const tt = i / SR, v = Math.sin(2 * Math.PI * (60 - 25 * tt) * tt) * Math.exp(-6 * tt) * 1.5 + (r() * 2 - 1) * Math.exp(-30 * tt) * 0.2; L[i0 + i] += v; R[i0 + i] += v; }
  }
  // soft bells picking chord notes, for wonder / calm
  if (M.bells) for (let t = 1; t < seconds; t += 0.75 + r() * 1.5) {
    const chord = M.chords[Math.floor(t * SR / segN) % M.chords.length];
    const f = midi(chord[Math.floor(r() * chord.length)] + 24), i0 = Math.round(t * SR), pan = r() - 0.5;
    for (let i = 0; i < 2.5 * SR && i0 + i < n; i++) { const tt = i / SR, v = (Math.sin(2 * Math.PI * f * tt) + 0.2 * Math.sin(2 * Math.PI * f * 2.76 * tt)) * Math.exp(-2.2 * tt) * 0.12; L[i0 + i] += v * (0.5 - pan); R[i0 + i] += v * (0.5 + pan); }
  }
  // low-pass to keep it warm and out of the voice's way, then a small room reverb
  for (const A of [L, R]) { let y = 0; for (let i = 0; i < n; i++) { y += 0.12 * (A[i] - y); A[i] = y; } }
  for (const [A, B, d] of [[L, R, 0.043], [R, L, 0.051]]) { const D = Math.round(d * SR); for (let i = D; i < n; i++) A[i] += B[i - D] * 0.18 + A[i - D] * 0.25; }
  normalize([L, R], 0.8);
  return [L, R];
}

function musicFile(dir, mood, seconds) {
  const f = path.join(dir, 'out', '.sound', `music_${mood}_${Math.ceil(seconds)}.wav`);
  if (!fs.existsSync(f)) writeWav(f, ...synthMusic(mood, seconds));
  return f;
}

module.exports = { SFX, MOODS, placeSfx, sfxFile, musicFile, synthMusic, writeWav };
