'use strict';
// Looks = palette + fonts + background textures + finishing (grain, vignette, letterbox).
// Backgrounds are generated procedurally (no image files needed) and cached per size.
const { createCanvas } = require('@napi-rs/canvas');
const { rng, rgba } = require('./util');

const LOOKS = {
  documentary: {
    label: 'Cork evidence wall: true crime, history, mysteries',
    background: 'cork', accent: '#c8442f', ink: '#1d1a16', paper: '#efe6d2', caption: '#f4ecdc',
    string: '#b3261e', grain: 0.07, vignette: 0.55, photoStyle: 'polaroid', tone: 'none',
    title: { bg: '#100d0a', color: '#efe6d2', role: 'display' },
  },
  archive: {
    label: 'Aged paper archive: history, biographies',
    background: 'paper', accent: '#8a2b1d', ink: '#2a2118', paper: '#f3ead4', caption: '#fff6e0',
    string: '#8a2b1d', grain: 0.08, vignette: 0.5, photoStyle: 'print', tone: 'sepia',
    title: { bg: '#1c150e', color: '#f3ead4', role: 'headline' },
  },
  blueprint: {
    label: 'Blueprint: science, engineering, inventions',
    background: 'blueprint', accent: '#ffd166', ink: '#e8f1ff', paper: '#e8f1ff', caption: '#ffffff',
    string: '#ffd166', grain: 0.04, vignette: 0.45, photoStyle: 'print', tone: 'none',
    title: { bg: '#0b2a4a', color: '#e8f1ff', role: 'display' },
  },
  night: {
    label: 'Night: tech, space, modern stories, trailers',
    background: 'night', accent: '#5ad1ff', ink: '#e9eef7', paper: '#e9eef7', caption: '#ffffff',
    string: '#5ad1ff', grain: 0.05, vignette: 0.6, photoStyle: 'plain', tone: 'none',
    title: { bg: '#05070d', color: '#e9eef7', role: 'display' },
  },
  studio: {
    label: 'Clean studio: explainers, products, brands',
    background: 'studio', accent: '#e0a447', ink: '#1b1b1f', paper: '#ffffff', caption: '#ffffff',
    string: '#e0a447', grain: 0.025, vignette: 0.25, photoStyle: 'plain', tone: 'none',
    title: { bg: '#18181c', color: '#ffffff', role: 'display' },
  },
};

const cache = new Map();

function tileCanvas(kind, size = 1024) {
  const key = `${kind}:${size}`;
  if (cache.has(key)) return cache.get(key);
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const r = rng(kind);
  const speckle = (n, colors, minR, maxR, alpha) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = rgba(colors[Math.floor(r() * colors.length)], alpha * (0.4 + r() * 0.6));
      const x = r() * size, y = r() * size, rad = minR + r() * (maxR - minR);
      g.beginPath(); g.ellipse(x, y, rad, rad * (0.5 + r()), r() * Math.PI, 0, Math.PI * 2); g.fill();
      // wrap around edges so the tile repeats seamlessly
      for (const [dx, dy] of [[size, 0], [-size, 0], [0, size], [0, -size]]) {
        if (x + dx > -maxR && x + dx < size + maxR && y + dy > -maxR && y + dy < size + maxR) {
          g.beginPath(); g.ellipse(x + dx, y + dy, rad, rad * 0.8, 0, 0, Math.PI * 2); g.fill();
        }
      }
    }
  };
  if (kind === 'cork') {
    g.fillStyle = '#a8794a'; g.fillRect(0, 0, size, size);
    speckle(9000, ['#7a5230', '#c4925e', '#8c6038', '#d3a571', '#5e3d22'], 0.6, 3.2, 0.55);
    speckle(500, ['#4d311b', '#e2b98a'], 2, 6, 0.25);
  } else if (kind === 'paper') {
    g.fillStyle = '#eadfc6'; g.fillRect(0, 0, size, size);
    speckle(4000, ['#d8c9a8', '#f4ead4', '#cdb98f'], 0.5, 2.5, 0.35);
    speckle(60, ['#b89c6a', '#c7ab78'], 20, 70, 0.06);
  } else if (kind === 'blueprint') {
    g.fillStyle = '#0f3d6e'; g.fillRect(0, 0, size, size);
    speckle(1500, ['#134a83', '#0c3460'], 1, 4, 0.4);
    g.strokeStyle = 'rgba(200,225,255,0.10)'; g.lineWidth = 1;
    for (let i = 0; i <= size; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke(); }
    g.strokeStyle = 'rgba(200,225,255,0.22)'; g.lineWidth = 1.5;
    for (let i = 0; i <= size; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke(); }
  } else if (kind === 'night') {
    g.fillStyle = '#070b16'; g.fillRect(0, 0, size, size);
    speckle(1200, ['#ffffff', '#9fd8ff'], 0.3, 1.2, 0.5);
    g.strokeStyle = 'rgba(90,209,255,0.05)'; g.lineWidth = 1;
    for (let i = 0; i <= size; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, size); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(size, i); g.stroke(); }
  } else if (kind === 'studio') {
    g.fillStyle = '#ececef'; g.fillRect(0, 0, size, size);
    speckle(800, ['#e2e2e6', '#f6f6f8'], 1, 4, 0.3);
  } else if (kind === 'black') {
    g.fillStyle = '#0b0a09'; g.fillRect(0, 0, size, size);
    speckle(600, ['#1a1714'], 1, 3, 0.5);
  } else {
    g.fillStyle = kind.startsWith('#') ? kind : '#111'; g.fillRect(0, 0, size, size);
  }
  cache.set(key, c);
  return c;
}

function grainCanvas(size = 512) {
  const key = `grain:${size}`;
  if (cache.has(key)) return cache.get(key);
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const r = rng('grain');
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(r() * 255);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

function vignetteCanvas(W, H, strength) {
  const key = `vig:${W}x${H}:${strength}`;
  if (cache.has(key)) return cache.get(key);
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, `rgba(0,0,0,${strength})`);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  cache.set(key, c);
  return c;
}

// Pre-rendered board background (1.8x the frame) - much faster to draw than a pattern fill every frame.
const BOARD = 1.8;
function boardCanvas(kind, W, H) {
  const key = `board:${kind}:${W}x${H}`;
  if (cache.has(key)) return cache.get(key);
  for (const k of cache.keys()) if (k.startsWith('board:') && cache.size > 12) cache.delete(k);
  const BW = Math.round(W * BOARD), BH = Math.round(H * BOARD);
  const c = createCanvas(BW, BH);
  const g = c.getContext('2d');
  const s = W / 1920;
  g.scale(s, s);
  g.fillStyle = g.createPattern(tileCanvas(kind), 'repeat');
  g.fillRect(0, 0, BW / s, BH / s);
  cache.set(key, c);
  return c;
}

// Full-frame film grain (transparent black/white specks): cheap to draw with normal blending.
function grainFrame(W, H, variant, strength) {
  const key = `gf:${W}x${H}:${variant}:${strength}`;
  if (cache.has(key)) return cache.get(key);
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const r = rng('grain' + variant);
  const maxA = Math.round(255 * Math.min(0.15, strength * 0.6));
  for (let i = 0; i < img.data.length; i += 4) {
    const v = r() < 0.5 ? 0 : 255;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = Math.floor(r() * maxA);
  }
  g.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

function getLook(name) {
  return LOOKS[name] || LOOKS.documentary;
}

module.exports = { LOOKS, getLook, tileCanvas, grainCanvas, vignetteCanvas, boardCanvas, grainFrame, BOARD };
