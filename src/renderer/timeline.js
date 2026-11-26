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
    scenes.push(scene);
    t += dur;
  });
  if (!scenes.length) errors.push('film.json has no scenes.');
  const unused = narration.filter((l) => !used.has(l.id)).map((l) => l.id);
  if (unused.length) warnings.push(`Narration not placed in any scene: ${unused.join(', ')}.`);
  if (film.music?.file && !fs.existsSync(path.join(dir, film.music.file))) errors.push(`Music file ${film.music.file} not found.`);

  return {
    film, dir, look, W, H, fps, scenes, total: t, audio, errors, warnings,
    captions: film.captions !== false, letterbox: !!film.letterbox,
  };
}

module.exports = { buildTimeline, readFilm, SIZES, wordsDuration };
