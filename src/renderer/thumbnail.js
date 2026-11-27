'use strict';
// Designed YouTube thumbnails (1280x720): the strongest photo, big 2-5 word text with one highlighted word,
// optional circle/arrow on the point of interest, and a small badge (e.g. a year). Built for small phone screens.
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const config = require('../config');
const fonts = require('./fonts');
const { clamp } = require('./util');

fonts.ensureRegistered(config.FONTS_DIR);

const W = 1280, H = 720;
const COLORS = { yellow: '#FFD43B', red: '#FF3B30', white: '#FFFFFF', orange: '#FF8A00', cyan: '#3DDCFF' };

// spec: { image, text, highlight, side: "left"|"right", focus: {x,y}, circle, arrow, badge, color, zoom }
async function renderThumbnail(dir, spec, outFile) {
  const c = createCanvas(W, H), g = c.getContext('2d');
  const side = spec.side === 'right' ? 'right' : 'left';
  const accent = COLORS[spec.color] || spec.color || COLORS.yellow;
  const focus = { x: clamp(spec.focus?.x ?? 0.5), y: clamp(spec.focus?.y ?? 0.45) };

  // 1. photo: fill the frame, pushed towards the focus point, punchier contrast and colour
  g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
  if (spec.image && fs.existsSync(path.join(dir, spec.image))) {
    const img = await loadImage(fs.readFileSync(path.join(dir, spec.image)));
    // put the focus point on the side opposite the text; zoom in as much as needed to get it there (max 2.2x)
    const tx = side === 'left' ? W * 0.7 : W * 0.3;
    const cover = Math.max(W / img.width, H / img.height);
    const need = Math.max(tx / Math.max(0.05, focus.x), (W - tx) / Math.max(0.05, 1 - focus.x)) / (img.width * cover);
    const zoom = clamp(Math.max(spec.zoom ?? 1.1, Math.min(2.2, need)), 1, 3);
    const s = cover * zoom;
    const iw = img.width * s, ih = img.height * s;
    const x = clamp(tx - focus.x * iw, W - iw, 0), y = clamp(H * 0.5 - focus.y * ih, H - ih, 0);
    if ('filter' in g) g.filter = 'contrast(1.18) saturate(1.25) brightness(1.03)';
    g.drawImage(img, x, y, iw, ih);
    if ('filter' in g) g.filter = 'none';
    focus.px = x + focus.x * iw; focus.py = y + focus.y * ih;
  } else { focus.px = W * 0.68; focus.py = H * 0.5; }

  // 2. dark gradient behind the text so it reads at any size
  const grad = side === 'left' ? g.createLinearGradient(0, 0, W * 0.75, 0) : g.createLinearGradient(W, 0, W * 0.25, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.88)'); grad.addColorStop(0.55, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);

  // 3. circle and arrow on the point of interest
  if (spec.circle) {
    const r = (spec.circleSize ?? 0.16) * H * 1.4;
    g.save();
    g.strokeStyle = COLORS.red; g.lineWidth = 12; g.shadowColor = 'rgba(255,40,40,0.8)'; g.shadowBlur = 24;
    g.beginPath(); g.ellipse(focus.px, focus.py, r * 1.15, r, -0.08, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  if (spec.arrow) {
    const fromX = side === 'left' ? W * 0.47 : W * 0.53, fromY = H * 0.78;
    const r = spec.circle ? (spec.circleSize ?? 0.16) * H * 1.6 : 30;
    const ang = Math.atan2(focus.py - fromY, focus.px - fromX);
    const toX = focus.px - Math.cos(ang) * r, toY = focus.py - Math.sin(ang) * r;
    g.save();
    g.strokeStyle = COLORS.red; g.fillStyle = COLORS.red; g.lineWidth = 16; g.lineCap = 'round';
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 14;
    g.beginPath(); g.moveTo(fromX, fromY);
    g.quadraticCurveTo((fromX + toX) / 2 + (side === 'left' ? -40 : 40), (fromY + toY) / 2 + 40, toX, toY); g.stroke();
    const head = 44;
    g.beginPath(); g.moveTo(toX, toY);
    g.lineTo(toX - head * Math.cos(ang - 0.45), toY - head * Math.sin(ang - 0.45));
    g.lineTo(toX - head * Math.cos(ang + 0.45), toY - head * Math.sin(ang + 0.45)); g.closePath(); g.fill();
    g.restore();
  }

  // 4. big text: 1-3 lines, fitted to ~46% of the width, one highlighted word
  const latin = /^[\x00-\x7F‘-”—]*$/.test(spec.text || '');
  const text = String(spec.text || '').trim();
  const words = (latin ? text.toUpperCase() : text).split(/\s+/).filter(Boolean);
  const hiSet = new Set(String(spec.highlight || '').split(/\s+/).filter(Boolean).map((w) => (latin ? w.toUpperCase() : w).replace(/[^\p{L}\p{N}]/gu, '')));
  const boxW = W * 0.47, boxH = H * 0.7;
  let px = 170, lines;
  const layout = (size) => {
    g.font = fonts.font('display', size, 'bold');
    const out = [[]]; let lw = 0; const sp = g.measureText(' ').width;
    for (const w of words) {
      const ww = g.measureText(w).width;
      if (out[out.length - 1].length && lw + sp + ww > boxW) { out.push([]); lw = 0; }
      out[out.length - 1].push(w); lw += (lw ? sp : 0) + ww;
    }
    return out;
  };
  for (; px > 60; px -= 6) { lines = layout(px); if (lines.length <= 3 && lines.length * px * 1.02 <= boxH && lines.every((l) => g.measureText(l.join(' ')).width <= boxW)) break; }
  g.font = fonts.font('display', px, 'bold');
  g.textBaseline = 'middle';
  const lh = px * 1.02, top = H * 0.5 - ((lines.length - 1) * lh) / 2;
  const x0 = side === 'left' ? W * 0.05 : W * 0.95;
  lines.forEach((line, i) => {
    const y = top + i * lh;
    const sp = g.measureText(' ').width, full = g.measureText(line.join(' ')).width;
    let x = side === 'left' ? x0 : x0 - full;
    for (const w of line) {
      const ww = g.measureText(w).width;
      const hi = hiSet.has(w.replace(/[^\p{L}\p{N}]/gu, ''));
      g.save();
      g.lineJoin = 'round'; g.lineWidth = px * 0.14; g.strokeStyle = '#000';
      g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = px * 0.18; g.shadowOffsetY = px * 0.05;
      g.strokeText(w, x, y);
      g.shadowColor = 'transparent';
      g.fillStyle = hi ? accent : '#FFFFFF';
      g.fillText(w, x, y);
      g.restore();
      x += ww + sp;
    }
  });

  // 5. badge (year, "TRUE STORY", …) in the top corner on the text side
  if (spec.badge) {
    g.save();
    g.font = fonts.font('display', 44, 'bold');
    const t = String(spec.badge).toUpperCase(), tw = g.measureText(t).width;
    const bx = side === 'left' ? W * 0.05 : W * 0.95 - tw - 36, by = H * 0.07;
    g.fillStyle = accent; g.fillRect(bx, by, tw + 36, 66);
    g.fillStyle = '#111'; g.textBaseline = 'middle'; g.fillText(t, bx + 18, by + 35);
    g.restore();
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, c.toBuffer('image/png'));
  return outFile;
}

// Render several variants: out/thumb_1.png, out/thumb_2.png, …
async function renderThumbnails(dir, specs) {
  const files = [];
  for (let i = 0; i < Math.min(4, specs.length); i++) {
    const rel = `out/thumb_${i + 1}.png`;
    await renderThumbnail(dir, specs[i], path.join(dir, rel));
    files.push(rel);
  }
  return { ok: true, files };
}

module.exports = { renderThumbnail, renderThumbnails, COLORS };
