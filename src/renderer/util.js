'use strict';
// Small math/animation/text helpers for the renderer.

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

const EASE = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  bounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};
const ease = (name, t) => (EASE[name] || EASE.inOut)(clamp(t));

// Deterministic random (so re-renders and resumed renders look identical).
function rng(seed) {
  let s = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) s = (Math.imul(31, s) + str.charCodeAt(i)) | 0;
  s = s || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

// Smooth 1-D noise for camera drift / handheld feel.
function noise1(seed, t) {
  const r = rng(seed);
  const a = [r(), r(), r(), r(), r(), r()];
  return (Math.sin(t * (0.7 + a[0])) * 0.5 + Math.sin(t * (1.3 + a[1]) + a[2] * 6) * 0.3 +
          Math.sin(t * (2.1 + a[3]) + a[4] * 6) * 0.2);
}

// Word-wrap text to a max width. Returns lines.
function wrap(g, text, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (g.measureText(test).width > maxW) { out.push(line); line = words[i]; } else line = test;
    }
    out.push(line);
  }
  return out;
}

// Fit a font size so text fits in w x h (with wrapping).
function fitText(g, text, fontFn, w, h, maxPx, minPx = 8, lh = 1.2) {
  for (let px = maxPx; px >= minPx; px -= Math.max(1, Math.round(px * 0.06))) {
    g.font = fontFn(px);
    const lines = wrap(g, text, w);
    if (lines.length * px * lh <= h && lines.every((l) => g.measureText(l).width <= w)) return { px, lines };
  }
  g.font = fontFn(minPx);
  return { px: minPx, lines: wrap(g, text, w) };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

module.exports = { clamp, lerp, ease, EASE, rng, noise1, wrap, fitText, hexToRgb, rgba, fmtTime, srtTime };
