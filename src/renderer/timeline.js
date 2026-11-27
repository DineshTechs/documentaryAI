'use strict';
// Loads film.json, validates it, and computes exact timing from the narration audio.
const fs = require('fs');
const path = require('path');
const { duration } = require('./ffmpeg');
const { ALL_TYPES, SPRITE_TYPES } = require('./elements');
const { LOOKS } = require('./looks');

const SIZES = {
  '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350],
};
const TRANSITIONS = new Set(['cut', 'fade', 'dip', 'flash']);
const BACKGROUNDS = new Set(['cork', 'paper', 'blueprint', 'night', 'studio', 'black']);

// Rough boxes (fractions of the frame) for text-like elements, to catch text printed on top of text and text that runs
// off the screen. Photos and documents may overlap each other on purpose (a pinned board), so they are not compared.
function textBox(el, W, H) {
  const ar = H / W;
  const est = (txt, size, maxW) => {
    const oneLine = String(txt || '').length * size * 0.55 * ar; // average glyph ≈ half the font height
    const w = Math.min(maxW, Math.max(oneLine, size * ar));
    const lines = Math.max(1, Math.ceil(oneLine / maxW));
    return [w, lines * size * 1.25];
  };
  let w, h, x = el.x ?? 0.5, y = el.y ?? 0.5;
  switch (el.type) {
    case 'text': [w, h] = est(el.text, el.size || 0.05, el.w || 0.8); if (el.align === 'left') x += w / 2; if (el.align === 'right') x -= w / 2; break;
    case 'title': [w, h] = est(el.text, el.size || 0.11, el.w || 0.8); y = el.y ?? 0.47; if (el.sub) h += (el.size || 0.11) * 0.8; break;
    case 'label': { // size is a fraction of the frame WIDTH (default 0.016), typewriter font ≈ 0.6 em per letter
      const px = el.size || 0.016;
      w = String(el.text || '').length * px * 0.62 + px * 1.2; h = px * 1.9 / ar; break;
    }
    case 'counter': { const sz = el.size || 0.12; [w, h] = est(`${el.prefix || ''}${el.to ?? ''}${el.suffix || ''}`, sz, 0.9); if (el.label) h += sz * 0.6; break; }
    case 'stamp': w = el.w || 0.22; h = w * 0.33 / ar; break;
    case 'cta': [w, h] = est(el.text, el.size || 0.05, el.w || 0.62); w += 0.06; h += 0.09; break;
    default: return null;
  }
  return { id: el.id, type: el.type, x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2, w, h };
}
function layoutWarnings(elements, W, H, camera) {
  const out = [];
  const boxes = elements.map((el) => textBox(el, W, H)).filter(Boolean);
  for (const b of boxes) {
    // camera push-ins crop a few percent at the edges, so keep text 3% inside the frame
    // where the box lands on screen at each camera keyframe (zoom around the camera centre)
    const keys = (Array.isArray(camera) && camera.length ? camera : [{}]).map((k) => ({ z: +k.zoom || 1, cx: k.x ?? 0.5 }));
    const sx0 = Math.min(...keys.map((k) => (b.x0 - k.cx) * k.z + 0.5)), sx1 = Math.max(...keys.map((k) => (b.x1 - k.cx) * k.z + 0.5));
    if (b.type !== 'stamp' && (sx0 < 0.03 || sx1 > 0.97)) out.push(`${b.id} (${b.type}) is about ${Math.round(b.w * 100)}% of the frame wide and may be cut off at the ${sx0 < 0.03 ? 'left' : 'right'} edge${keys.some((k) => k.z > 1.02) ? ' when the camera zooms in' : ''}; shorten the text, move it or lower "size".`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) continue;
    const share = (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
    if (share > 0.3) out.push(`${a.id} (${a.type}) and ${b.id} (${b.type}) are printed on top of each other; move one (give it its own x/y) or let one exit first.`);
  }
  return out;
}

// Retention: viewers leave when nothing new happens. Collect every moment something changes on screen (cut, element
// appearing, camera move) and flag long static stretches, a slow start, and Shorts that open on a title card.
function retentionWarnings(scenes, total, vertical) {
  const out = [];
  const events = [];
  for (const sc of scenes) {
    events.push(sc.start);
    for (const el of sc.elements || []) {
      try { events.push(sc.start + sc.resolveAt(el.enter && el.enter.at != null ? el.enter.at : 0)); } catch (_) { /* bad at: reported elsewhere */ }
    }
    const cam = Array.isArray(sc.camera) ? sc.camera : sc.camera && Array.isArray(sc.camera.keys) ? sc.camera.keys : [];
    cam.slice(1).forEach((k) => { try { events.push(sc.start + sc.resolveAt(k.at ?? k.t ?? 0)); } catch (_) { /* */ } });
  }
  const ev = [...new Set(events.filter((x) => x >= 0 && x <= total).map((x) => +x.toFixed(2)))].sort((a, b) => a - b);
  ev.push(total);
  const limit = vertical ? 4 : 8;
  let worst = 0;
  for (let i = 1; i < ev.length; i++) {
    const gap = ev[i] - ev[i - 1];
    const isTail = i === ev.length - 1; // the ending may hold a little longer (fade out, end screen)
    if (gap > limit + (isTail ? 3 : 0)) {
      if (worst++ < 4) out.push(`Retention: nothing new appears on screen from ${ev[i - 1].toFixed(1)} s to ${ev[i].toFixed(1)} s (${gap.toFixed(1)} s). Add a photo, a zoom to a detail, a label or a cut; ${vertical ? 'Shorts need a change every 2-4 s' : 'aim for a change every 3-6 s'}.`);
    }
  }
  if (worst > 4) out.push(`Retention: ${worst - 4} more static stretches like these.`);
  const first = scenes[0];
  if (first) {
    const firstLine = first.lines && first.lines[0];
    if (firstLine && first.start + firstLine.start > 1.5) out.push(`Retention: the narration starts at ${(first.start + firstLine.start).toFixed(1)} s. Start talking within the first second; the first 3 seconds decide whether people stay.`);
    if (vertical && (first.elements || []).some((el) => el.type === 'title' && (el.enter?.at ?? 0) === 0) && first.dur > 2)
      out.push('Retention: this Short opens on a title card. Open on the most surprising image or fact instead; put the title later or leave it out.');
  }
  return out;
}

function wordsDuration(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words / 2.55 + 0.25); // ~153 wpm narration estimate
}

async function audioDurations(dir, narration) {
  const cacheFile = path.join(dir, 'audio', '.durations.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* none */ }
  const out = {};
  let changed = false;
  for (const line of narration) {
    const rel = line.audio || `audio/${line.id}.mp3`;
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      const key = `${rel}:${st.size}:${Math.round(st.mtimeMs)}`;
      if (cache[key] == null) { cache[key] = await duration(abs); changed = true; }
      out[line.id] = { file: abs, rel, dur: cache[key], estimated: false };
    } else {
      out[line.id] = { file: null, rel, dur: wordsDuration(line.text), estimated: true };
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return out;
}

function readFilm(dir) {
  const f = path.join(dir, 'film.json');
  if (!fs.existsSync(f)) throw new Error('film.json not found. Write it first (see read_guide "film").');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`film.json is not valid JSON: ${e.message}`);
  }
}

// Turn an "at" value into seconds from scene start.
//   3.5        -> 3.5 s
//   "l4"       -> when narration line l4 starts
//   "l4+0.8"   -> 0.8 s after l4 starts;  "l4.end-0.3" -> 0.3 s before l4 ends
//   "50%"      -> half way through the scene;  "end-1.5" -> 1.5 s before the scene ends
function makeResolver(scene) {
  return (at) => {
    if (at == null) return 0;
    if (typeof at === 'number') return at;
    const s = String(at).trim();
    let m;
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)%$/))) return (parseFloat(m[1]) / 100) * scene.dur;
    if ((m = s.match(/^end\s*([+-]\s*\d+(?:\.\d+)?)?$/))) return scene.dur + (m[1] ? parseFloat(m[1].replace(/\s/g, '')) : 0);
    if ((m = s.match(/^([A-Za-z0-9_-]+?)(\.end)?\s*([+-]\s*\d+(?:\.\d+)?)?$/)) && scene.lineAt[m[1]]) {
      const L = scene.lineAt[m[1]];
      return (m[2] ? L.start + L.dur : L.start) + (m[3] ? parseFloat(m[3].replace(/\s/g, '')) : 0);
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };
}

async function buildTimeline(dir, opts = {}) {
  const film = readFilm(dir);
  const errors = [], warnings = [];
  const look = LOOKS[film.look] ? film.look : 'documentary';
  if (film.look && !LOOKS[film.look]) warnings.push(`Unknown look "${film.look}", using documentary. Looks: ${Object.keys(LOOKS).join(', ')}`);
  const [W, H] = opts.size || SIZES[film.aspect] || (Array.isArray(film.size) ? film.size : SIZES['16:9']);
  const fps = Math.max(12, Math.min(60, film.fps || 30));
  const narration = Array.isArray(film.narration) ? film.narration : [];
  const lineIds = new Set();
  for (const l of narration) {
    if (!l.id) errors.push('Every narration line needs an "id" (e.g. "l1").');
    else if (lineIds.has(l.id)) errors.push(`Duplicate narration id "${l.id}".`);
    lineIds.add(l.id);
    if (!l.text) warnings.push(`Narration line ${l.id} has no text.`);
  }
  const audio = await audioDurations(dir, narration);
  const estimated = narration.filter((l) => audio[l.id]?.estimated).map((l) => l.id);
  if (estimated.length) warnings.push(`No audio yet for ${estimated.length} line(s) (${estimated.slice(0, 6).join(', ')}${estimated.length > 6 ? '…' : ''}): timing is estimated and they will be silent. Generate them with tts_generate.`);

  const lineGap = film.lineGap ?? 0.3;
  const scenes = [];
  const used = new Set();
  let t = 0;
  const allIds = new Set();
  (film.scenes || []).forEach((sc, i) => {
    const id = sc.id || `s${i + 1}`;
    const lines = (sc.lines || []).filter((lid) => {
      if (!lineIds.has(lid)) { errors.push(`Scene ${id}: narration line "${lid}" does not exist.`); return false; }
      if (used.has(lid)) warnings.push(`Narration line ${lid} is used in more than one scene.`);
      used.add(lid); return true;
    });
    const lead = sc.lead ?? (i === 0 ? 0.6 : 0.25);
    let cursor = lead;
    const lineAt = {};
    const lineList = [];
    lines.forEach((lid, k) => {
      const d = audio[lid].dur;
      lineAt[lid] = { start: cursor, dur: d };
      lineList.push({ id: lid, start: cursor, dur: d, text: narration.find((n) => n.id === lid).text });
      cursor += d + (k < lines.length - 1 ? lineGap : 0);
    });
    const tail = sc.pad ?? 0.6;
    const dur = Math.max(sc.duration || 0, lines.length ? cursor + tail : (sc.duration || 4));
    const scene = { ...sc, id, index: i, start: t, dur, lineAt, lines: lineList, frames: Math.max(1, Math.round(dur * fps)) };
    scene.resolveAt = makeResolver(scene);
    if (sc.background && typeof sc.background === 'string' && !BACKGROUNDS.has(sc.background) && !sc.background.startsWith('#'))
      warnings.push(`Scene ${id}: background "${sc.background}" unknown; use ${[...BACKGROUNDS].join('/')}, a #color, or {"image": "images/x.jpg"}.`);
    if (sc.background && typeof sc.background === 'object' && sc.background.image && !fs.existsSync(path.join(dir, sc.background.image)))
      errors.push(`Scene ${id}: background image ${sc.background.image} not found.`);
    if (sc.transition && !TRANSITIONS.has(sc.transition)) warnings.push(`Scene ${id}: transition "${sc.transition}" unknown (cut, fade, dip, flash).`);
    const ids = new Set();
    (sc.elements || []).forEach((el, k) => {
      if (!el.id) el.id = `${id}_e${k + 1}`;
      if (ids.has(el.id)) errors.push(`Scene ${id}: duplicate element id "${el.id}".`);
      ids.add(el.id); allIds.add(el.id);
      if (!ALL_TYPES.has(el.type)) errors.push(`Scene ${id}, element ${el.id}: unknown type "${el.type}". Types: ${[...ALL_TYPES].join(', ')}.`);
      if (SPRITE_TYPES.has(el.type) && !(el.w > 0)) el.w = el.type === 'stamp' ? 0.22 : 0.28;
      if (['photo'].includes(el.type) && !el.src) errors.push(`Scene ${id}, element ${el.id}: photo needs "src".`);
      if (el.src && !fs.existsSync(path.join(dir, el.src))) errors.push(`Scene ${id}, element ${el.id}: image ${el.src} not found.`);
      if (['photo', 'clipping', 'document', 'note', 'stamp', 'text', 'label', 'marker', 'counter'].includes(el.type)) {
        if (el.x == null) el.x = 0.5;
        if (el.y == null) el.y = 0.5;
      }
    });
    (sc.elements || []).forEach((el) => {
      for (const ref of ['from', 'to', 'target']) {
        if (el[ref] && ['string', 'highlight', 'arrow'].includes(el.type) && !ids.has(el[ref]))
          errors.push(`Scene ${id}, element ${el.id}: ${ref} "${el[ref]}" is not an element id in this scene.`);
      }
    });
    layoutWarnings(sc.elements || [], W, H, sc.camera).forEach((w) => warnings.push(`Scene ${id}: ${w}`));
    scenes.push(scene);
    t += dur;
  });
  if (!scenes.length) errors.push('film.json has no scenes.');
  const unused = narration.filter((l) => !used.has(l.id)).map((l) => l.id);
  if (unused.length) warnings.push(`Narration not placed in any scene: ${unused.join(', ')}.`);
  // downloaded photos that never appear in the film
  let imgs = [];
  try { imgs = fs.readdirSync(path.join(dir, 'images')).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).map((f) => `images/${f}`); } catch (_) { /* no folder */ }
  const usedImgs = new Set();
  for (const sc of film.scenes || []) {
    if (sc.background && typeof sc.background === 'object' && sc.background.image) usedImgs.add(sc.background.image);
    for (const el of sc.elements || []) if (el.src) usedImgs.add(el.src);
  }
  const unusedImgs = imgs.filter((f) => !usedImgs.has(f));
  const photoScenes = (film.scenes || []).filter((sc) => (sc.elements || []).some((el) => el.src) || (sc.background && sc.background.image)).length;
  if (imgs.length && !usedImgs.size) {
    errors.push(`The film shows none of the ${imgs.length} images in images/ (${imgs.slice(0, 6).join(', ')}). A documentary needs its real photos: add "photo" elements (src: "images/…") or image backgrounds to the scenes. Set "noPhotos": true in film.json only if the user asked for a text-only film.`);
    if (film.noPhotos) errors.pop();
  } else if (unusedImgs.length) {
    warnings.push(`Images downloaded but not used: ${unusedImgs.join(', ')}.`);
  }
  if (imgs.length && (film.scenes || []).length >= 4 && photoScenes / film.scenes.length < 0.5 && !film.noPhotos)
    warnings.push(`Only ${photoScenes} of ${film.scenes.length} scenes show a real image. Aim for a photo, document or map in most scenes.`);
  if (film.music?.file && !fs.existsSync(path.join(dir, film.music.file))) {
    // a missing track shouldn't block the film: render without music and say so
    if (film.music.mood) warnings.push(`Music file ${film.music.file} not found, so the generated "${film.music.mood}" music is used instead.`);
    else { warnings.push(`Music file ${film.music.file} not found, so the film has no music. Upload a track (Files tab → uploads/), or use generated music: "music": {"mood": "wonder"}.`); film.music = null; }
  }

  retentionWarnings(scenes, t, H > W).forEach((w) => warnings.push(w));
  if ((film.aspect === '9:16' || opts.aspect === '9:16') && t > 180) warnings.push(`This is ${Math.round(t)} s long. YouTube only treats vertical videos up to 3 minutes (180 s) as Shorts; cut lines or scenes.`);
  return {
    film, dir, look, W, H, fps, scenes, total: t, audio, errors, warnings,
    captions: film.captions !== false,
    // "animated" (default): big words lit up as they're spoken; "classic": plain subtitle box
    captionStyle: (typeof film.captions === 'string' ? film.captions : (film.captions && film.captions.style)) === 'classic' ? 'classic' : 'animated',
    captionColor: (film.captions && film.captions.color) || null, letterbox: !!film.letterbox,
  };
}

module.exports = { buildTimeline, readFilm, SIZES, wordsDuration };
