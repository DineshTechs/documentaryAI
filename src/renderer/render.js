'use strict';
// The film renderer: film.json + images + narration -> MP4 (+ SRT, chapters).
// Each scene is encoded to its own segment and cached, so an interrupted render resumes where it stopped,
// and changing one scene only re-renders that scene.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ff = require('./ffmpeg');
const fonts = require('./fonts');
const { getLook, tileCanvas, vignetteCanvas, boardCanvas, grainFrame, BOARD } = require('./looks');
const E = require('./elements');
const { buildTimeline } = require('./timeline');
const { buildAudio, captionCues, writeSrt } = require('./audio');
const { clamp, lerp, ease, noise1, wrap, fmtTime } = require('./util');
const config = require('../config');

fonts.ensureRegistered(config.FONTS_DIR);

// ------------------------------------------------------------------ assets
const imageCache = new Map();
async function image(dir, rel) {
  const abs = path.join(dir, rel);
  const st = fs.statSync(abs);
  const key = `${abs}:${st.mtimeMs}`;
  if (!imageCache.has(key)) {
    if (imageCache.size > 60) imageCache.clear();
    imageCache.set(key, await loadImage(fs.readFileSync(abs)));
  }
  return imageCache.get(key);
}

// ------------------------------------------------------------------ camera
function cameraKeys(sc) {
  const cam = sc.camera;
  let keys = Array.isArray(cam) ? cam : cam && Array.isArray(cam.keys) ? cam.keys : null;
  if (!keys && cam && (cam.from || cam.to)) keys = [{ at: 0, ...(cam.from || {}) }, { at: 'end', ...(cam.to || {}) }];
  if (!keys || !keys.length) keys = [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 'end', x: 0.5, y: 0.5, zoom: 1.06 }];
  let prev = { x: 0.5, y: 0.5, zoom: 1, rotate: 0 };
  return keys.map((k) => {
    const out = { t: sc.resolveAt(k.at ?? k.t ?? 0), x: k.x ?? prev.x, y: k.y ?? prev.y, zoom: k.zoom ?? prev.zoom,
      rotate: k.rotate ?? prev.rotate, ease: k.ease || 'inOut' };
    prev = out;
    return out;
  }).sort((a, b) => a.t - b.t);
}

function cameraAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const k = ease(b.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), zoom: lerp(a.zoom, b.zoom, k), rotate: lerp(a.rotate, b.rotate, k) };
    }
  }
  return keys[keys.length - 1];
}

// ------------------------------------------------------------------ per-scene preparation
async function prepareScene(tl, sc, F) {
  const keys = cameraKeys(sc);
  const maxZoom = clamp(Math.max(...keys.map((k) => k.zoom)), 1, 2.6);
  const sprites = new Map();
  for (const el of sc.elements || []) {
    if (!E.SPRITE_TYPES.has(el.type)) continue;
    const pxW = Math.max(16, Math.round(el.w * F.W * maxZoom));
    const img = el.src ? await image(tl.dir, el.src) : null;
    let spr;
    if (el.type === 'photo') spr = E.buildPhoto(el, img, pxW, F.look);
    else if (el.type === 'clipping') spr = E.buildClipping(el, img, pxW, F.look);
    else if (el.type === 'document') spr = E.buildDocument(el, img, pxW, F.look);
    else if (el.type === 'note') spr = E.buildNote(el, pxW, F.look);
    else spr = E.buildStamp(el, pxW, F.look);
    sprites.set(el.id, spr);
  }
  let bg = sc.background || F.look.background;
  let bgImage = null, bgTone = null;
  if (bg && typeof bg === 'object' && bg.image) {
    const img = await image(tl.dir, bg.image);
    bgImage = E.toneImage(img, bg.tone || 'none', Math.max(F.W, F.H) * maxZoom * 1.25);
    bgTone = bg;
    bg = bg.base || 'black';
  }
  const bgKind = typeof bg === 'string' ? bg : 'black';
  const tile = tileCanvas(bgKind);
  const g0 = createCanvas(4, 4).getContext('2d');
  return {
    keys, sprites, bgImage, bgTone,
    pattern: g0.createPattern(tile, 'repeat'),
    board: boardCanvas(bgKind, F.W, F.H),
    drift: (sc.camera && sc.camera.drift != null) ? sc.camera.drift : (tl.film.drift ?? 0.35),
    byId: new Map((sc.elements || []).map((e) => [e.id, e])),
  };
}

// ------------------------------------------------------------------ frame
function drawFrame(g, tl, sc, ts, F, prep, cues) {
  const { W, H, look } = F;
  const tg = sc.start + ts;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);

  // camera
  const cam = cameraAt(prep.keys, ts);
  const d = prep.drift;
  const dx = d ? noise1(sc.id + 'x', tg * 0.6) * 0.004 * d : 0;
  const dy = d ? noise1(sc.id + 'y', tg * 0.6) * 0.004 * d : 0;
  const dr = d ? noise1(sc.id + 'r', tg * 0.4) * 0.002 * d : 0;
  g.save();
  g.translate(W / 2, H / 2);
  g.scale(cam.zoom, cam.zoom);
  g.rotate((cam.rotate || 0) * Math.PI / 180 + dr);
  g.translate(-(cam.x + dx) * W, -(cam.y + dy) * H);

  // background (board space): pre-rendered board, or a pattern fill if the camera looks past its edges
  const halfW = 0.5 / cam.zoom + 0.02, halfH = 0.5 / cam.zoom + 0.02, m = (BOARD - 1) / 2;
  const inside = (cam.x + dx) - halfW * 1.15 >= -m && (cam.x + dx) + halfW * 1.15 <= 1 + m &&
                 (cam.y + dy) - halfH * 1.15 >= -m && (cam.y + dy) + halfH * 1.15 <= 1 + m;
  if (inside) {
    g.drawImage(prep.board, -m * W, -m * H);
  } else {
    const k = W / 1920;
    g.save(); g.scale(k, k);
    g.fillStyle = prep.pattern;
    g.fillRect(-W * 3 / k, -H * 3 / k, W * 7 / k, H * 7 / k);
    g.restore();
  }
  if (prep.bgImage) {
    const im = prep.bgImage, bgo = prep.bgTone;
    const cover = Math.max((W * 1.2) / im.width, (H * 1.2) / im.height) * (bgo.scale || 1);
    const iw = im.width * cover, ih = im.height * cover;
    g.globalAlpha = bgo.opacity ?? 1;
    g.drawImage(im, W / 2 - iw / 2 + (bgo.offsetX || 0) * W, H / 2 - ih / 2 + (bgo.offsetY || 0) * H, iw, ih);
    g.globalAlpha = 1;
  }

  // elements
  // depth parallax: photos and stamps sit a little above the board, so camera moves shift them a bit more
  const par = tl.film.parallax ?? 1;
  const depthOf = (el) => el.depth ?? (E.SPRITE_TYPES.has(el.type) ? 1 + 0.05 * par : 1);
  const shift = (el) => { const k = depthOf(el) - 1; return { x: -(cam.x + dx - 0.5) * W * k * 2, y: -(cam.y + dy - 0.5) * H * k * 2 }; };
  const ctx = {
    t: ts,
    dur: sc.dur,
    resolveAt: sc.resolveAt,
    anchor: (id, which = 'pin') => {
      const el = prep.byId.get(id);
      if (!el) return null;
      const a = E.anchorOf(el, prep.sprites, F, which), o = shift(el);
      return { ...a, x: a.x + o.x, y: a.y + o.y };
    },
  };
  for (const el of sc.elements || []) {
    const st = E.animState(el, ts, sc.dur, sc.resolveAt);
    const o = shift(el), moved = o.x || o.y;
    if (moved) { g.save(); g.translate(o.x, o.y); }
    if (E.SPRITE_TYPES.has(el.type)) {
      const spr = prep.sprites.get(el.id);
      if (spr) E.drawSprite(g, el, spr, F, st, ctx);
    } else {
      E.drawLive(g, el, F, st, ctx);
    }
    if (moved) g.restore();
  }
  g.restore();

  // film finishing (screen space)
  if (look.vignette) g.drawImage(vignetteCanvas(W, H, look.vignette), 0, 0);
  if (look.grain) {
    // grain changes ~8x per second (not every frame): looks like film, keeps files small
    const step = Math.floor(tg * 8);
    const gf = grainFrame(W, H, step % 3, look.grain);
    g.drawImage(gf, -((step * 37) % 9), -((step * 53) % 9));
  }
  if (tl.letterbox) {
    const bar = Math.round(H * 0.06);
    g.fillStyle = '#000'; g.fillRect(0, 0, W, bar); g.fillRect(0, H - bar, W, bar);
  }

  // captions
  if (tl.captions && cues) {
    if (tl.captionStyle === 'animated') {
      const grp = activeGroup(tl, tg);
      if (grp) drawAnimatedCaption(g, grp, tg, F, tl);
    } else {
      const cue = cues.find((c) => tg >= c.start && tg < c.end);
      if (cue) drawCaption(g, cue.text, F, tl);
    }
  }

  // transitions (to/from black, white flash)
  const prev = tl.scenes[sc.index - 1], next = tl.scenes[sc.index + 1];
  const fadeInDur = sc.index === 0 ? 0.8 : (sc.transition === 'fade' || sc.transition === 'dip') ? 0.45 : 0;
  const fadeOutDur = !next ? 1.0 : (next.transition === 'fade' || next.transition === 'dip') ? 0.45 : 0;
  let black = 0;
  if (fadeInDur && ts < fadeInDur) black = Math.max(black, 1 - ease('inOut', ts / fadeInDur));
  if (fadeOutDur && ts > sc.dur - fadeOutDur) black = Math.max(black, ease('inOut', (ts - (sc.dur - fadeOutDur)) / fadeOutDur));
  if (black > 0) { g.globalAlpha = clamp(black); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  if (sc.transition === 'flash' && prev && ts < 0.3) { g.globalAlpha = 1 - ts / 0.3; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
}

// ---- animated captions: short groups of words, the spoken word lit up (style used by most Shorts/Reels)
// Word times are estimated inside each narration line by word length (longer words take longer to say).
function wordGroups(tl) {
  if (tl._wordGroups) return tl._wordGroups;
  const vertical = tl.H > tl.W;
  const maxWords = vertical ? 3 : 6, maxChars = vertical ? 20 : 38;
  const groups = [];
  for (const sc of tl.scenes) {
    for (const L of sc.lines) {
      const words = String(L.text || '').split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const weight = (w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2 + (/[,.;:!?—–]$/.test(w) ? 3 : 0); // pauses after punctuation
      const total = words.reduce((a, w) => a + weight(w), 0);
      let t = sc.start + L.start;
      const timed = words.map((w) => { const d = L.dur * weight(w) / total; const x = { w, start: t, end: t + d }; t += d; return x; });
      let cur = [];
      const flush = () => { if (cur.length) groups.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = []; };
      for (const x of timed) {
        const chars = cur.reduce((a, y) => a + y.w.length + 1, 0) + x.w.length;
        if (cur.length && (cur.length >= maxWords || chars > maxChars)) flush();
        cur.push(x);
        if (/[.!?;:—–]$/.test(x.w) || (/,$/.test(x.w) && cur.length >= 2)) flush(); // break groups at natural pauses
      }
      flush();
    }
  }
  // hold each group on screen through short gaps so captions don't flicker
  groups.forEach((g, i) => { const n = groups[i + 1]; g.show = n && n.start - g.end < 0.35 ? n.start : g.end + 0.15; });
  tl._wordGroups = groups;
  return groups;
}
function activeGroup(tl, t) {
  const gs = wordGroups(tl);
  for (const g of gs) if (t >= g.start && t < g.show) return g;
  return null;
}
function drawAnimatedCaption(g, grp, t, F, tl) {
  const { W, H } = F;
  const vertical = H > W;
  const px = Math.round(vertical ? W * 0.082 : H * 0.068);
  const hi = tl.captionColor || '#FFD43B';
  g.save();
  g.font = fonts.font('sans', px, 'bold');
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const space = g.measureText(' ').width * 1.35; // room for the highlighted word to grow
  // lay words out in up to 2 centred lines
  const maxW = W * (vertical ? 0.84 : 0.8);
  const lines = [[]]; let lw = 0;
  for (const x of grp.words) {
    const w = g.measureText(x.w).width;
    if (lines[lines.length - 1].length && lw + space + w > maxW) { lines.push([]); lw = 0; }
    lines[lines.length - 1].push({ ...x, width: w }); lw += (lw ? space : 0) + w;
  }
  const lh = px * 1.18;
  const cy = vertical ? H * 0.70 : H - (tl.letterbox ? H * 0.06 : 0) - H * 0.13;
  const pop = 1 + 0.08 * (1 - clamp((t - grp.start) / 0.12)); // whole group pops in slightly
  lines.forEach((line, li) => {
    const total = line.reduce((a, x) => a + x.width, 0) + space * (line.length - 1);
    let x = W / 2 - total / 2;
    const y = cy + (li - (lines.length - 1) / 2) * lh;
    for (const wd of line) {
      const active = t >= wd.start && t < wd.end;
      const spoken = t >= wd.end;
      const s = (active ? 1.06 + 0.08 * (1 - clamp((t - wd.start) / 0.1)) : 1) * pop;
      g.save();
      g.translate(x + wd.width / 2, y); g.scale(s, s);
      g.lineJoin = 'round'; g.lineWidth = px * 0.2; g.strokeStyle = 'rgba(0,0,0,0.92)';
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = px * 0.25; g.shadowOffsetY = px * 0.06;
      g.strokeText(wd.w, -wd.width / 2, 0);
      g.shadowColor = 'transparent';
      g.fillStyle = active ? hi : spoken ? '#FFFFFF' : 'rgba(255,255,255,0.92)';
      g.fillText(wd.w, -wd.width / 2, 0);
      g.restore();
      x += wd.width + space;
    }
  });
  g.restore();
}

function drawCaption(g, text, F, tl) {
  const { W, H, look } = F;
  const px = Math.round(Math.min(W, H) * 0.042);
  g.save();
  g.font = fonts.font('sans', px, '600');
  const lines = wrap(g, text, W * 0.8);
  const lh = px * 1.28;
  const bottom = H - (tl.letterbox ? H * 0.06 : 0) - H * 0.075;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = bottom - (lines.length - 1 - i) * lh;
    const tw = g.measureText(l).width;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(W / 2 - tw / 2 - px * 0.4, y - lh / 2, tw + px * 0.8, lh);
    g.fillStyle = look.caption || '#fff';
    g.fillText(l, W / 2, y + px * 0.04);
  });
  g.restore();
}

// ------------------------------------------------------------------ encoding
function encoder(file, W, H, fps, { preset, crf }) {
  const args = ['-hide_banner', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-an', '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-maxrate', '16M', '-bufsize', '32M', '-pix_fmt', 'yuv420p', '-g', String(fps * 2)];
  if (config.RENDER_THREADS && config.RENDER_THREADS !== '0') args.push('-threads', config.RENDER_THREADS);
  args.push('-movflags', '+faststart', file);
  const p = ff.spawnSafe(ff.ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let closed = null;
  p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
  p.stdin.on('error', () => { /* reported through 'close' */ });
  const done = new Promise((resolve, reject) => {
    p.on('error', (e) => { closed = e; reject(e); });
    p.on('close', (code) => {
      closed = code === 0 ? 'ok' : new Error(`ffmpeg encode failed (${code}): ${err.slice(-1200)}`);
      if (code === 0) resolve(); else reject(closed);
    });
  });
  done.catch(() => {});
  return {
    write: (buf) => {
      if (closed) return Promise.reject(closed instanceof Error ? closed : new Error('encoder closed'));
      if (p.stdin.write(buf)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onDrain = () => { p.removeListener('close', onClose); resolve(); };
        const onClose = () => { p.stdin.removeListener('drain', onDrain); reject(closed instanceof Error ? closed : new Error('encoder closed')); };
        p.stdin.once('drain', onDrain);
        p.once('close', onClose);
      });
    },
    end: async () => { p.stdin.end(); await done; },
    kill: () => p.kill('SIGKILL'),
  };
}

function sceneFrames(tl) {
  // cumulative rounding so video and audio never drift apart
  for (const sc of tl.scenes) {
    sc.f0 = Math.round(sc.start * tl.fps);
    sc.f1 = Math.round((sc.start + sc.dur) * tl.fps);
  }
  return tl.scenes.reduce((s, sc) => s + (sc.f1 - sc.f0), 0);
}

function sceneHash(tl, sc, F, extra) {
  const next = tl.scenes[sc.index + 1];
  const mt = (sc.elements || []).filter((e) => e.src).map((e) => { try { return fs.statSync(path.join(tl.dir, e.src)).mtimeMs; } catch (_) { return 0; } });
  if (sc.background && sc.background.image) { try { mt.push(fs.statSync(path.join(tl.dir, sc.background.image)).mtimeMs); } catch (_) { /* */ } }
  const data = JSON.stringify({
    v: 3, sc: { ...sc, resolveAt: undefined, frames: undefined }, look: tl.look, W: F.W, H: F.H, fps: tl.fps,
    cap: `${tl.captions}:${tl.captionStyle}:${tl.captionColor}`, lb: tl.letterbox, drift: tl.film.drift, nextT: next ? next.transition : 'END', mt, extra,
  });
  return crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
}

// Render a time range (seconds) of the film to a video-only MP4.
async function renderRange(tl, { from = 0, to = Infinity, scale = 1, outFile, preset, crf, onProgress, cache }) {
  const F = { W: even(tl.W * scale), H: even(tl.H * scale), look: getLook(tl.look) };
  const cues = captionCues(tl);
  const totalFrames = sceneFrames(tl);
  const fA = Math.max(0, Math.round(from * tl.fps)), fB = Math.min(totalFrames, Math.round(Math.min(to, tl.total) * tl.fps));
  const canvas = createCanvas(F.W, F.H);
  const g = canvas.getContext('2d');
  const segDir = path.join(tl.dir, 'out', '.segments');
  fs.mkdirSync(segDir, { recursive: true });
  const segFiles = [];
  let done = 0;
  const need = fB - fA;
  for (const sc of tl.scenes) {
    const a = Math.max(sc.f0, fA), b = Math.min(sc.f1, fB);
    if (b <= a) continue;
    const whole = a === sc.f0 && b === sc.f1;
    const hash = sceneHash(tl, sc, F, { preset, crf, a: whole ? 0 : a, b: whole ? 0 : b });
    const seg = path.join(segDir, `${String(sc.index).padStart(3, '0')}_${sc.id}_${hash}.mp4`);
    if (cache && whole && fs.existsSync(seg) && fs.statSync(seg).size > 1000) {
      done += b - a;
      onProgress && onProgress(done, need, `scene ${sc.id} (cached)`);
      segFiles.push(seg);
      continue;
    }
    const prep = await prepareScene(tl, sc, F);
    const tmp = seg + '.part.mp4';
    const enc = encoder(tmp, F.W, F.H, tl.fps, { preset, crf });
    try {
      for (let f = a; f < b; f++) {
        drawFrame(g, tl, sc, (f - sc.f0) / tl.fps, F, prep, cues);
        await enc.write(Buffer.from(canvas.data()));
        done++;
        if (onProgress && (done % 15 === 0 || done === need)) onProgress(done, need, `scene ${sc.id}`);
      }
      await enc.end();
    } catch (e) { enc.kill(); throw e; }
    fs.renameSync(tmp, seg);
    segFiles.push(seg);
  }
  if (!segFiles.length) throw new Error('Nothing to render in that time range.');
  const list = path.join(segDir, `list_${process.pid}.txt`);
  fs.writeFileSync(list, segFiles.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff.run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outFile]);
  fs.unlinkSync(list);
  return { W: F.W, H: F.H, frames: need, seconds: need / tl.fps };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function chaptersText(tl) {
  const ch = tl.scenes.filter((s) => s.chapter).map((s) => ({ t: s.start, title: s.chapter }));
  if (!ch.length) return { text: '', warnings: ['No scene has a "chapter" title, so no YouTube chapters were made.'] };
  if (ch[0].t > 0.5) ch.unshift({ t: 0, title: 'Intro' });
  ch[0].t = 0;
  const warnings = [];
  if (ch.length < 3) warnings.push('YouTube needs at least 3 chapters to show them.');
  for (let i = 1; i < ch.length; i++) if (ch[i].t - ch[i - 1].t < 10) warnings.push(`Chapter "${ch[i - 1].title}" is shorter than 10 s; YouTube may ignore chapters.`);
  return { text: ch.map((c) => `${fmtTime(c.t)} ${c.title}`).join('\n') + '\n', warnings };
}

// ------------------------------------------------------------------ public jobs
async function renderFilm(dir, { quality = 'final', from, to, onProgress } = {}) {
  const tl = await buildTimeline(dir);
  if (tl.errors.length) return { ok: false, errors: tl.errors, warnings: tl.warnings };
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const draft = quality === 'draft';
  const scale = draft ? 0.5 : quality === '720p' ? 2 / 3 : 1;
  const name = draft ? 'draft' : 'final';
  const t0 = draft ? (from || 0) : 0;
  const t1 = draft ? Math.min(tl.total, to ?? t0 + 30) : tl.total;
  const video = path.join(outDir, `.${name}_video.mp4`);
  const started = Date.now();
  const info = await renderRange(tl, {
    from: t0, to: t1, scale, outFile: video, cache: !draft,
    preset: draft ? 'ultrafast' : config.RENDER_PRESET, crf: draft ? 28 : 21, onProgress,
  });
  onProgress && onProgress(info.frames, info.frames, 'mixing audio');
  const audio = path.join(outDir, '.audio.m4a');
  await buildAudio(tl, audio);
  const out = path.join(outDir, `${name}.mp4`);
  await ff.run(['-i', video, '-ss', t0.toFixed(3), '-t', (t1 - t0).toFixed(3), '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', out]);
  fs.unlinkSync(video);
  const cues = captionCues(tl).filter((c) => c.end > t0 && c.start < t1).map((c) => ({ ...c, start: Math.max(0, c.start - t0), end: c.end - t0 }));
  writeSrt(cues, path.join(outDir, `${name}.srt`));
  const result = {
    ok: true, video: `out/${name}.mp4`, srt: `out/${name}.srt`, seconds: +(t1 - t0).toFixed(2), size: `${info.W}x${info.H}`,
    renderSeconds: Math.round((Date.now() - started) / 1000), warnings: tl.warnings,
  };
  if (!draft) {
    const ch = chaptersText(tl);
    if (ch.text) { fs.writeFileSync(path.join(outDir, 'chapters.txt'), ch.text); result.chapters = 'out/chapters.txt'; }
    result.warnings = [...tl.warnings, ...ch.warnings];
    // tidy old segments that no longer belong to the film
    const keep = new Set(fs.readdirSync(path.join(outDir, '.segments')).filter((f) => f.endsWith('.mp4')));
    const current = new Set(tl.scenes.map((sc) => `${String(sc.index).padStart(3, '0')}_${sc.id}_`));
    for (const f of keep) if (![...current].some((p) => f.startsWith(p))) fs.rmSync(path.join(outDir, '.segments', f), { force: true });
  }
  return result;
}

// Single frames at given times (seconds) -> PNG files. Times can also be "s3" (middle of scene s3) or "s3@2.5".
async function renderStills(dir, times, { scale = 0.5 } = {}) {
  const tl = await buildTimeline(dir);
  if (tl.errors.length) return { ok: false, errors: tl.errors, warnings: tl.warnings };
  const F = { W: even(tl.W * scale), H: even(tl.H * scale), look: getLook(tl.look) };
  const cues = captionCues(tl);
  sceneFrames(tl);
  const canvas = createCanvas(F.W, F.H);
  const g = canvas.getContext('2d');
  const outDir = path.join(dir, 'out', 'stills');
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const preps = new Map();
  for (const raw of (times && times.length ? times : tl.scenes.map((s) => s.id))) {
    let sc, ts;
    const m = String(raw).match(/^([A-Za-z][\w-]*)(?:@(\d+(?:\.\d+)?))?$/);
    if (m && tl.scenes.find((s) => s.id === m[1])) {
      sc = tl.scenes.find((s) => s.id === m[1]);
      ts = m[2] != null ? Math.min(+m[2], sc.dur - 0.01) : sc.dur * 0.62;
    } else {
      const t = clamp(parseFloat(raw) || 0, 0, tl.total - 0.01);
      sc = tl.scenes.find((s) => t >= s.start && t < s.start + s.dur) || tl.scenes[tl.scenes.length - 1];
      ts = t - sc.start;
    }
    if (!preps.has(sc.id)) preps.set(sc.id, await prepareScene(tl, sc, F));
    drawFrame(g, tl, sc, ts, F, preps.get(sc.id), cues);
    const name = `still_${sc.id}_${(sc.start + ts).toFixed(1)}s.png`;
    fs.writeFileSync(path.join(outDir, name), await canvas.encode('png'));
    files.push(`out/stills/${name}`);
  }
  return { ok: true, files, warnings: tl.warnings };
}

// A grid of evenly spaced frames with timestamps: a quick visual review of the whole film.
async function contactSheet(dir, { count = 12, cols = 4 } = {}) {
  const tl = await buildTimeline(dir);
  if (tl.errors.length) return { ok: false, errors: tl.errors, warnings: tl.warnings };
  const scale = 0.25;
  const F = { W: even(tl.W * scale), H: even(tl.H * scale), look: getLook(tl.look) };
  const cues = captionCues(tl);
  sceneFrames(tl);
  const rows = Math.ceil(count / cols);
  const label = 26, gap = 8;
  const sheet = createCanvas(cols * (F.W + gap) + gap, rows * (F.H + label + gap) + gap);
  const sg = sheet.getContext('2d');
  sg.fillStyle = '#151311'; sg.fillRect(0, 0, sheet.width, sheet.height);
  const frame = createCanvas(F.W, F.H);
  const g = frame.getContext('2d');
  const preps = new Map();
  for (let i = 0; i < count; i++) {
    const t = (tl.total * (i + 0.5)) / count;
    const sc = tl.scenes.find((s) => t >= s.start && t < s.start + s.dur) || tl.scenes[tl.scenes.length - 1];
    if (!preps.has(sc.id)) preps.set(sc.id, await prepareScene(tl, sc, F));
    drawFrame(g, tl, sc, t - sc.start, F, preps.get(sc.id), cues);
    const x = gap + (i % cols) * (F.W + gap), y = gap + Math.floor(i / cols) * (F.H + label + gap);
    sg.drawImage(frame, x, y);
    sg.fillStyle = '#e8dcc4'; sg.font = fonts.font('sans', 15); sg.textBaseline = 'top';
    sg.fillText(`${fmtTime(t)}  ·  ${sc.id}${sc.chapter ? ' · ' + sc.chapter : ''}`, x + 2, y + F.H + 5);
  }
  const out = path.join(dir, 'out', 'contact_sheet.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await sheet.encode('png'));
  return { ok: true, file: 'out/contact_sheet.png', seconds: +tl.total.toFixed(1), scenes: tl.scenes.length, warnings: tl.warnings };
}

async function inspect(dir) {
  const tl = await buildTimeline(dir);
  return {
    ok: !tl.errors.length, errors: tl.errors, warnings: tl.warnings, seconds: +tl.total.toFixed(2), size: `${tl.W}x${tl.H}`, fps: tl.fps,
    scenes: tl.scenes.map((s) => ({ id: s.id, start: +s.start.toFixed(2), seconds: +s.dur.toFixed(2), lines: s.lines.map((l) => l.id), chapter: s.chapter || undefined })),
  };
}

module.exports = { renderFilm, renderStills, contactSheet, inspect };
