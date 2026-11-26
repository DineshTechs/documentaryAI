'use strict';
// Film elements. "Sprite" elements (photo, clipping, document, note, stamp) are drawn once into an
// offscreen canvas and then moved/animated per frame, which keeps rendering fast on small servers.
// "Live" elements (text, title, label, string, route, marker, highlight, arrow, counter) are drawn every frame.
const { createCanvas } = require('@napi-rs/canvas');
const { font } = require('./fonts');
const { clamp, lerp, ease, rng, wrap, fitText, rgba } = require('./util');

const SPRITE_TYPES = new Set(['photo', 'clipping', 'document', 'note', 'stamp']);
const LIVE_TYPES = new Set(['text', 'title', 'label', 'string', 'route', 'marker', 'highlight', 'arrow', 'counter']);
const ALL_TYPES = new Set([...SPRITE_TYPES, ...LIVE_TYPES]);

// ------------------------------------------------------------------ image tone
function toneImage(img, tone, maxPx) {
  const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  if (tone && tone !== 'none' && tone !== 'color') {
    const d = g.getImageData(0, 0, w, h);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      let y = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      y = clamp((y - 128) * 1.12 + 128, 0, 255); // a touch of contrast
      if (tone === 'sepia') { a[i] = clamp(y * 1.07 + 18, 0, 255); a[i + 1] = clamp(y * 0.95 + 8, 0, 255); a[i + 2] = clamp(y * 0.78, 0, 255); }
      else if (tone === 'aged') { a[i] = clamp(a[i] * 0.9 + 25, 0, 255); a[i + 1] = clamp(a[i + 1] * 0.88 + 15, 0, 255); a[i + 2] = clamp(a[i + 2] * 0.75, 0, 255); }
      else if (tone === 'blue') { a[i] = y * 0.55; a[i + 1] = y * 0.8; a[i + 2] = clamp(y * 1.1 + 30, 0, 255); }
      else { a[i] = y; a[i + 1] = y; a[i + 2] = y; } // bw
    }
    g.putImageData(d, 0, 0);
  }
  return c;
}

// ------------------------------------------------------------------ sprite helpers
const PAD = 0.09; // shadow margin as fraction of sprite width

function withShadow(contentW, contentH, draw, { blur = 0.035, offY = 0.018, alpha = 0.45 } = {}) {
  const pad = Math.round(contentW * PAD);
  const c = createCanvas(contentW + pad * 2, contentH + pad * 2);
  const g = c.getContext('2d');
  g.save();
  g.shadowColor = `rgba(0,0,0,${alpha})`;
  g.shadowBlur = contentW * blur;
  g.shadowOffsetY = contentW * offY;
  g.translate(pad, pad);
  draw(g, true);
  g.restore();
  g.save();
  g.translate(pad, pad);
  draw(g, false);
  g.restore();
  return { canvas: c, pad, cw: contentW, ch: contentH };
}

function drawPin(g, x, y, r, color = '#c8442f') {
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.ellipse(x + r * 0.5, y + r * 0.6, r * 0.9, r * 0.6, 0, 0, Math.PI * 2); g.fill();
  const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.25, color); grd.addColorStop(1, '#3a0d08');
  g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.restore();
}

function drawTape(g, x, y, w, h, rot) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.fillStyle = 'rgba(236,228,200,0.78)'; g.fillRect(-w / 2, -h / 2, w, h);
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(-w / 2, -h / 2, w, h * 0.3);
  g.restore();
}

function paperFill(g, w, h, base, seed) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 900; i++) {
    g.fillStyle = `rgba(120,90,40,${0.03 + r() * 0.05})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
  const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(110,70,20,0.18)');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
}

// ------------------------------------------------------------------ sprite builders
function buildPhoto(el, img, pxW, look) {
  const style = el.style || look.photoStyle || 'polaroid';
  const tone = el.tone || look.tone || 'none';
  const border = style === 'polaroid' ? 0.055 : style === 'print' ? 0.035 : 0;
  const bottom = style === 'polaroid' ? (el.caption ? 0.2 : 0.14) : border;
  const innerW = Math.round(pxW * (1 - 2 * border));
  const ratio = img.height / img.width;
  const cropRatio = el.crop === 'square' ? 1 : el.aspect ? 1 / el.aspect : ratio;
  const innerH = Math.round(innerW * cropRatio);
  const W = pxW, H = Math.round(innerH + pxW * (border + bottom));
  const toned = toneImage(img, tone, Math.max(innerW, innerH) * 1.05);
  const spr = withShadow(W, H, (g, shadowPass) => {
    if (style !== 'plain') {
      g.fillStyle = style === 'polaroid' ? '#f7f3ea' : '#fbf8f2'; g.fillRect(0, 0, W, H);
      if (shadowPass) return;
    } else if (shadowPass) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); return; }
    // image, cropped to cover the inner box
    const bx = Math.round(pxW * border), by = Math.round(pxW * border);
    const s = Math.max(innerW / toned.width, innerH / toned.height);
    const sw = innerW / s, sh = innerH / s;
    const fx = clamp(el.focusX ?? 0.5), fy = clamp(el.focusY ?? 0.5);
    g.drawImage(toned, (toned.width - sw) * fx, (toned.height - sh) * fy, sw, sh, bx, by, innerW, innerH);
    if (style === 'polaroid' && el.caption) {
      g.fillStyle = '#2a2622';
      const { px, lines } = fitText(g, el.caption, (p) => font('hand', p), W * 0.86, H - innerH - by - W * 0.03, W * 0.085, 8, 1.05);
      g.font = font('hand', px); g.textAlign = 'center'; g.textBaseline = 'middle';
      const cy = by + innerH + (H - by - innerH) / 2 - ((lines.length - 1) * px) / 2;
      lines.forEach((l, i) => g.fillText(l, W / 2, cy + i * px * 1.05));
    }
  });
  return finishSprite(spr, el, look);
}

function finishSprite(spr, el, look) {
  const g = spr.canvas.getContext('2d');
  const { pad, cw, ch } = spr;
  // pin (default on the cork wall), tape, or nothing
  const fasten = el.fasten || (el.tape ? 'tape' : el.pin === false ? 'none' : el.pin === true ? 'pin'
    : look.background === 'cork' ? 'pin' : 'none');
  if (fasten === 'pin') {
    drawPin(g, pad + cw / 2, pad + cw * 0.04, cw * 0.032, el.pinColor || look.accent);
    spr.pinY = -ch / 2 + cw * 0.04;
  } else if (fasten === 'tape') {
    drawTape(g, pad + cw * 0.18, pad + 2, cw * 0.26, cw * 0.07, -0.5);
    drawTape(g, pad + cw * 0.82, pad + 2, cw * 0.26, cw * 0.07, 0.45);
    spr.pinY = -ch / 2;
  } else spr.pinY = -ch / 2;
  return spr;
}

function buildClipping(el, img, pxW, look) {
  const W = pxW;
  const m = W * 0.06;
  const meas = createCanvas(10, 10).getContext('2d');
  const headPx = W * (el.headlineSize || 0.085);
  meas.font = font('headline', headPx, 'bold');
  const headLines = wrap(meas, String(el.headline || '').toUpperCase(), W - 2 * m);
  const bodyPx = W * 0.034;
  meas.font = font('serif', bodyPx);
  const cols = W > 600 && (el.body || '').length > 220 ? 2 : 1;
  const colW = (W - 2 * m - (cols - 1) * m * 0.6) / cols;
  const bodyLines = wrap(meas, el.body || '', colW);
  const imgH = img ? (W - 2 * m) * (img.height / img.width) : 0;
  const mastH = el.paper ? W * 0.075 : 0;
  const perCol = Math.ceil(bodyLines.length / cols);
  const H = Math.round(m + mastH + (el.date ? W * 0.05 : 0) + headLines.length * headPx * 1.08 + m * 0.4 +
            (img ? imgH + m * 0.5 : 0) + perCol * bodyPx * 1.35 + m);
  const spr = withShadow(W, H, (g, shadowPass) => {
    paperFill(g, W, H, el.color || '#efe6cf', el.id || el.headline || 'clip');
    if (shadowPass) return;
    g.fillStyle = '#1c1915'; g.textBaseline = 'top';
    let y = m;
    if (el.paper) {
      g.font = font('headline', mastH * 0.75, 'bold'); g.textAlign = 'center';
      g.fillText(String(el.paper), W / 2, y); y += mastH;
      g.fillRect(m, y, W - 2 * m, Math.max(1, W * 0.004)); y += W * 0.012;
    }
    if (el.date) {
      g.font = font('serif', W * 0.03); g.textAlign = 'center'; g.fillText(String(el.date).toUpperCase(), W / 2, y);
      y += W * 0.05;
    }
    g.font = font('headline', headPx, 'bold'); g.textAlign = 'left';
    headLines.forEach((l) => { g.fillText(l, m, y); y += headPx * 1.08; });
    y += m * 0.4;
    if (img) {
      const t = toneImage(img, el.tone || 'bw', W);
      g.drawImage(t, m, y, W - 2 * m, imgH); y += imgH + m * 0.5;
    }
    g.font = font('serif', bodyPx); g.fillStyle = '#2b2620';
    for (let c = 0; c < cols; c++) {
      const x = m + c * (colW + m * 0.6);
      bodyLines.slice(c * perCol, (c + 1) * perCol).forEach((l, i) => g.fillText(l, x, y + i * bodyPx * 1.35));
    }
  });
  return finishSprite(spr, el, look);
}

function buildDocument(el, img, pxW, look) {
  const W = pxW;
  if (img) { // real scanned document image on paper
    const H = Math.round(W * (img.height / img.width));
    const spr = withShadow(W, H, (g, shadowPass) => {
      if (shadowPass) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); return; }
      g.drawImage(toneImage(img, el.tone || 'none', Math.max(W, H)), 0, 0, W, H);
    });
    return finishSprite(spr, el, look);
  }
  const m = W * 0.08;
  const meas = createCanvas(10, 10).getContext('2d');
  const bodyPx = W * 0.036;
  meas.font = font('type', bodyPx);
  const lines = wrap(meas, el.body || '', W - 2 * m);
  const titlePx = W * 0.05;
  const H = Math.round(Math.max(W * 1.15, m * 2 + (el.title ? titlePx * 2.2 : 0) + lines.length * bodyPx * 1.5 + (el.signature ? W * 0.12 : 0)));
  const spr = withShadow(W, H, (g, shadowPass) => {
    paperFill(g, W, H, el.color || '#f4efe2', el.id || 'doc');
    if (shadowPass) return;
    g.fillStyle = '#26221c'; g.textBaseline = 'top';
    let y = m;
    if (el.header) { g.font = font('type', W * 0.03); g.textAlign = 'right'; g.fillText(String(el.header), W - m, y); y += W * 0.06; }
    if (el.title) {
      g.font = font('type', titlePx, 'bold'); g.textAlign = 'center';
      g.fillText(String(el.title).toUpperCase(), W / 2, y); y += titlePx * 1.3;
      g.fillRect(W / 2 - W * 0.2, y, W * 0.4, Math.max(1, W * 0.003)); y += titlePx * 0.9;
    }
    g.font = font('type', bodyPx); g.textAlign = 'left';
    lines.forEach((l, i) => { g.globalAlpha = 0.82 + 0.18 * ((i * 7) % 5) / 5; g.fillText(l, m, y + i * bodyPx * 1.5); });
    g.globalAlpha = 1;
    if (el.signature) {
      g.font = font('hand', W * 0.07); g.fillStyle = '#1d2a5a';
      g.fillText(String(el.signature), W * 0.55, y + lines.length * bodyPx * 1.5 + W * 0.03);
    }
    if (el.redact) { // redaction bars on some lines
      const r = rng(el.id || 'red');
      g.fillStyle = '#0d0c0b';
      lines.forEach((l, i) => { if (r() < el.redact) { const lw = meas.measureText(l).width; const s = r() * lw * 0.4; g.fillRect(m + s, y + i * bodyPx * 1.5 - 1, lw * (0.3 + r() * 0.4), bodyPx * 1.1); } });
    }
  });
  return finishSprite(spr, el, look);
}

function buildNote(el, pxW, look) {
  const W = pxW, H = Math.round(pxW * (el.aspect ? 1 / el.aspect : 0.95));
  const spr = withShadow(W, H, (g, shadowPass) => {
    g.fillStyle = el.color || '#f6e27a'; g.fillRect(0, 0, W, H);
    if (shadowPass) return;
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, 'rgba(255,255,255,0.2)'); grd.addColorStop(1, 'rgba(0,0,0,0.08)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.fillStyle = el.ink || '#23201a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const { px, lines } = fitText(g, el.text || '', (p) => font('hand', p), W * 0.84, H * 0.8, W * 0.16, 8, 1.1);
    g.font = font('hand', px);
    const y0 = H / 2 - ((lines.length - 1) * px * 1.1) / 2;
    lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * px * 1.1));
  }, { blur: 0.05, offY: 0.03, alpha: 0.35 });
  return finishSprite(spr, el, look);
}

function buildStamp(el, pxW, look) {
  const meas = createCanvas(10, 10).getContext('2d');
  const text = String(el.text || 'CLASSIFIED').toUpperCase();
  let px = pxW * 0.2;
  meas.font = font('display', px, 'bold');
  const tw = meas.measureText(text).width;
  px *= Math.min(1, (pxW * 0.84) / tw);
  const W = pxW, H = Math.round(px * 1.7);
  const color = el.color === 'red' || !el.color ? '#b3261e' : el.color === 'blue' ? '#1f3f8f' : el.color === 'black' ? '#1a1a1a' : el.color;
  const pad = Math.round(W * 0.04);
  const c = createCanvas(W + pad * 2, H + pad * 2);
  const g = c.getContext('2d');
  g.translate(pad, pad);
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = Math.max(2, px * 0.1);
  g.globalAlpha = 0.85;
  g.strokeRect(g.lineWidth, g.lineWidth, W - g.lineWidth * 2, H - g.lineWidth * 2);
  g.font = font('display', px, 'bold'); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, W / 2, H / 2 + px * 0.04);
  // grunge: punch random holes so it looks inked
  g.globalCompositeOperation = 'destination-out';
  const r = rng(text);
  for (let i = 0; i < (W * H) / 120; i++) {
    g.globalAlpha = 0.25 + r() * 0.6;
    g.beginPath(); g.arc(r() * W, r() * H, 0.5 + r() * px * 0.05, 0, Math.PI * 2); g.fill();
  }
  return { canvas: c, pad, cw: W, ch: H, pinY: -H / 2 };
}

// ------------------------------------------------------------------ animation
// progress of the enter animation (0..1) and exit (1..0) at scene time t (seconds)
function animState(el, t, sceneDur, resolveAt) {
  const enter = el.enter || {};
  const exit = el.exit || null;
  const at = resolveAt(enter.at ?? 0);
  const dur = enter.dur ?? (enter.fx === 'none' ? 0 : enter.fx === 'stamp' ? 0.35 : enter.fx === 'draw' ? 1.2 : enter.fx === 'type' ? 1.5 : 0.7);
  let p = dur > 0 ? clamp((t - at) / dur) : (t >= at ? 1 : 0);
  if (t < at) p = 0;
  let q = 1;
  if (exit) {
    const eat = resolveAt(exit.at ?? 1);
    const edur = exit.dur ?? 0.5;
    q = 1 - clamp((t - eat) / Math.max(0.01, edur));
  }
  return { p, q, fx: enter.fx || 'fade', from: enter.from || 'bottom', exitFx: exit?.fx || 'fade' };
}

// ------------------------------------------------------------------ drawing
function drawSprite(g, el, spr, F, st) {
  const { W, H } = F;
  if (st.p <= 0 || st.q <= 0) return;
  const base = el.w * W / spr.cw; // board px per sprite px
  let x = el.x * W, y = el.y * H, scale = base, alpha = 1, rot = (el.rotate || 0) * Math.PI / 180;
  const e = st.p;
  switch (st.fx) {
    case 'drop': scale *= lerp(1.28, 1, ease('out', e)); alpha = clamp(e * 2.2); break;
    case 'pop': scale *= lerp(0.55, 1, ease('back', e)); alpha = clamp(e * 3); break;
    case 'stamp': scale *= lerp(2.4, 1, ease('in', e)); alpha = clamp(e * 1.5); rot += (1 - e) * 0.25; break;
    case 'slide': {
      const k = 1 - ease('out', e);
      const d = st.from;
      x += (d === 'left' ? -1 : d === 'right' ? 1 : 0) * k * W * 0.7;
      y += (d === 'top' ? -1 : d === 'bottom' ? 1 : 0) * k * H * 0.8;
      alpha = clamp(e * 3); break;
    }
    case 'none': break;
    case 'wipe': break;
    default: alpha = ease('out', e);
  }
  if (st.q < 1) alpha *= st.exitFx === 'none' ? (st.q > 0 ? 1 : 0) : st.q;
  alpha *= el.opacity ?? 1;
  if (alpha <= 0.002) return;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  g.rotate(rot);
  g.scale(scale, scale);
  const sw = spr.canvas.width, sh = spr.canvas.height;
  if (st.fx === 'wipe' && e < 1) {
    g.beginPath(); g.rect(-sw / 2, -sh / 2, sw * ease('inOut', e), sh); g.clip();
  }
  g.drawImage(spr.canvas, -sw / 2, -sh / 2);
  g.restore();
}

// anchor point of an element in board px (used by strings/highlights/arrows)
function anchorOf(el, sprites, F, which = 'pin') {
  const { W, H } = F;
  const x = el.x * W, y = el.y * H;
  const spr = sprites.get(el.id);
  if (!spr) return { x, y, r: (el.r || 0.08) * W };
  const s = el.w * W / spr.cw;
  const rot = (el.rotate || 0) * Math.PI / 180;
  const oy = which === 'pin' ? spr.pinY * s : 0;
  return { x: x - Math.sin(rot) * oy, y: y + Math.cos(rot) * oy, r: Math.max(spr.cw, spr.ch) * s * 0.58, w: spr.cw * s, h: spr.ch * s };
}

function drawLive(g, el, F, st, ctx) {
  const { W, H, look } = F;
  if (st.p <= 0 || st.q <= 0) return;
  const e = st.p;
  let alpha = (st.fx === 'draw' || st.fx === 'type' || st.fx === 'none') ? 1 : ease('out', e);
  if (st.q < 1) alpha *= st.q;
  alpha *= el.opacity ?? 1;
  g.save();
  g.globalAlpha = alpha;
  const color = el.color || look.string;
  switch (el.type) {
    case 'string': {
      const a = ctx.anchor(el.from), b = ctx.anchor(el.to);
      if (!a || !b) break;
      const reveal = st.fx === 'draw' ? ease('inOut', e) : 1;
      const sag = (el.sag ?? 0.06) * Math.hypot(b.x - a.x, b.y - a.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + sag;
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = W * 0.0035;
      strokeQuad(g, a.x + W * 0.002, a.y + W * 0.004, mx + W * 0.002, my + W * 0.006, b.x + W * 0.002, b.y + W * 0.004, reveal);
      g.strokeStyle = color; g.lineWidth = W * 0.0028;
      strokeQuad(g, a.x, a.y, mx, my, b.x, b.y, reveal);
      drawPin(g, a.x, a.y, W * 0.007, look.accent);
      if (reveal >= 1) drawPin(g, b.x, b.y, W * 0.007, look.accent);
      break;
    }
    case 'route': {
      const pts = (el.points || []).map(([px, py]) => [px * W, py * H]);
      if (pts.length < 2) break;
      const reveal = st.fx === 'draw' || !el.enter?.fx ? ease('inOut', e) : 1;
      g.strokeStyle = color; g.lineWidth = W * (el.width || 0.004); g.lineCap = 'round';
      if (el.dashed !== false) g.setLineDash([W * 0.012, W * 0.008]);
      const lens = []; let total = 0;
      for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
      let left = total * reveal;
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      let tip = pts[0], dir = [1, 0];
      for (let i = 1; i < pts.length && left > 0; i++) {
        const k = Math.min(1, left / lens[i - 1]);
        tip = [lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)];
        dir = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
        g.lineTo(tip[0], tip[1]); left -= lens[i - 1];
      }
      g.stroke(); g.setLineDash([]);
      if (el.arrow !== false && reveal > 0.02) arrowHead(g, tip[0], tip[1], Math.atan2(dir[1], dir[0]), W * 0.018, color);
      break;
    }
    case 'arrow': {
      const a = el.from ? ctx.anchor(el.from, 'center') : { x: el.x1 * W, y: el.y1 * H };
      const b = el.to ? ctx.anchor(el.to, 'center') : { x: el.x2 * W, y: el.y2 * H };
      if (!a || !b) break;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const shrink = (p) => (p.r ? p.r * 0.8 : 0);
      const ax = a.x + Math.cos(ang) * shrink(a), ay = a.y + Math.sin(ang) * shrink(a);
      const bx = b.x - Math.cos(ang) * shrink(b), by = b.y - Math.sin(ang) * shrink(b);
      const reveal = ease('inOut', e);
      const tx = lerp(ax, bx, reveal), ty = lerp(ay, by, reveal);
      g.strokeStyle = color; g.lineWidth = W * 0.004; g.lineCap = 'round';
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(tx, ty); g.stroke();
      arrowHead(g, tx, ty, ang, W * 0.016, color);
      break;
    }
    case 'marker': {
      const x = el.x * W, y = el.y * H, r = W * (el.size || 0.009);
      const pulse = (ctx.t * 1.1) % 1;
      g.strokeStyle = color; g.lineWidth = W * 0.002;
      g.globalAlpha = alpha * (1 - pulse);
      g.beginPath(); g.arc(x, y, r * (1 + pulse * 3), 0, Math.PI * 2); g.stroke();
      g.globalAlpha = alpha;
      g.fillStyle = color; g.beginPath(); g.arc(x, y, r * lerp(0.2, 1, ease('back', e)), 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r * 0.35, 0, Math.PI * 2); g.fill();
      if (el.label) labelBox(g, el.label, x + r * 1.8, y, W, look, el.labelSide);
      break;
    }
    case 'highlight': {
      const a = el.target ? ctx.anchor(el.target, 'center') : { x: el.x * W, y: el.y * H, r: (el.r || 0.08) * W };
      if (!a) break;
      const rx = (el.rx ? el.rx * W : a.w ? a.w * 0.62 : a.r), ry = (el.ry ? el.ry * W : a.h ? a.h * 0.62 : a.r * 0.8);
      const reveal = ease('inOut', e);
      g.strokeStyle = el.color || look.accent; g.lineWidth = W * 0.005; g.lineCap = 'round';
      g.beginPath();
      const start = -0.6, end = start + Math.PI * 2.15 * reveal;
      for (let k = 0; k <= 60; k++) {
        const ang = lerp(start, end, k / 60);
        const wob = 1 + Math.sin(ang * 3 + 1) * 0.03;
        const px = a.x + Math.cos(ang) * rx * wob, py = a.y + Math.sin(ang) * ry * wob;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
      break;
    }
    case 'title': {
      const x = (el.x ?? 0.5) * W, y = (el.y ?? 0.47) * H;
      const role = el.font || look.title.role;
      const px = H * (el.size || 0.11);
      g.fillStyle = el.color || look.title.color; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = font(role, px, 'bold');
      const lines = wrap(g, String(el.text || ''), W * (el.w || 0.8));
      const spacing = 1 - ease('out', e);
      if ('letterSpacing' in g) g.letterSpacing = `${(spacing * 0.25 + (el.tracking ?? 0.04)) * px}px`;
      lines.forEach((l, i) => g.fillText(l, x, y + (i - (lines.length - 1) / 2) * px * 1.05));
      if ('letterSpacing' in g) g.letterSpacing = '0px';
      if (el.sub) {
        g.globalAlpha = alpha * clamp((ctx.t - (ctx.resolveAt(el.enter?.at ?? 0) + 0.5)) / 0.8);
        g.font = font('type', px * 0.32); g.fillStyle = el.subColor || look.accent;
        g.fillText(String(el.sub), x, y + (lines.length / 2) * px * 1.05 + px * 0.45);
      }
      break;
    }
    case 'label': {
      const text = String(el.text || '');
      const shown = st.fx === 'type' ? text.slice(0, Math.ceil(text.length * e)) : text;
      labelBox(g, shown, el.x * W, el.y * H, W, look, 'center', el.size, text);
      break;
    }
    case 'text': {
      const px = H * (el.size || 0.05);
      g.font = font(el.font || 'sans', px, el.bold ? 'bold' : '');
      g.fillStyle = el.color || look.ink; g.textAlign = el.align || 'center'; g.textBaseline = 'middle';
      if (el.shadow !== false) { g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = px * 0.25; g.shadowOffsetY = px * 0.06; }
      const text = String(el.text || '');
      const lines = wrap(g, text, W * (el.w || 0.8));
      let budget = st.fx === 'type' ? Math.ceil(text.length * e) : Infinity;
      lines.forEach((l, i) => {
        const s = budget >= l.length ? l : l.slice(0, Math.max(0, budget));
        budget -= l.length + 1;
        g.fillText(s, el.x * W, el.y * H + (i - (lines.length - 1) / 2) * px * 1.25);
      });
      break;
    }
    case 'counter': {
      const v = lerp(+el.from || 0, +el.to || 0, ease('out', e));
      const txt = (el.prefix || '') + (el.decimals ? v.toFixed(el.decimals) : Math.round(v).toLocaleString('en-US')) + (el.suffix || '');
      const px = H * (el.size || 0.12);
      g.font = font(el.font || 'display', px, 'bold'); g.fillStyle = el.color || look.ink;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = px * 0.2;
      g.fillText(txt, el.x * W, el.y * H);
      if (el.label) { g.font = font('type', px * 0.28); g.fillStyle = el.labelColor || look.accent; g.fillText(String(el.label), el.x * W, el.y * H + px * 0.75); }
      break;
    }
    default: break;
  }
  g.restore();
}

function strokeQuad(g, x0, y0, cx, cy, x1, y1, reveal) {
  g.beginPath(); g.moveTo(x0, y0);
  const n = 40, m = Math.max(1, Math.round(n * reveal));
  for (let i = 1; i <= m; i++) {
    const t = (i / n);
    const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
    const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
    g.lineTo(x, y);
  }
  g.stroke();
}

function arrowHead(g, x, y, ang, s, color) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.fillStyle = color; g.beginPath(); g.moveTo(0, 0); g.lineTo(-s, -s * 0.55); g.lineTo(-s * 0.75, 0); g.lineTo(-s, s * 0.55); g.closePath(); g.fill();
  g.restore();
}

function labelBox(g, text, x, y, W, look, side = 'right', size, fullText) {
  const px = W * (size || 0.016);
  g.font = font('type', px);
  const tw = g.measureText(String(fullText ?? text)).width;
  const padX = px * 0.6, padY = px * 0.45;
  const bw = tw + padX * 2, bh = px + padY * 2;
  const bx = side === 'center' ? x - bw / 2 : side === 'left' ? x - bw : x, by = y - bh / 2;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = px * 0.5; g.shadowOffsetY = px * 0.15;
  g.fillStyle = look.background === 'night' || look.background === 'blueprint' ? 'rgba(10,15,25,0.85)' : '#f4efe2';
  g.fillRect(bx, by, bw, bh);
  g.restore();
  g.fillStyle = look.background === 'night' || look.background === 'blueprint' ? look.ink : '#1d1a16';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(String(text), bx + padX, y + px * 0.05);
}

module.exports = {
  SPRITE_TYPES, LIVE_TYPES, ALL_TYPES,
  buildPhoto, buildClipping, buildDocument, buildNote, buildStamp,
  drawSprite, drawLive, animState, anchorOf, toneImage,
};
