'use strict';
// Builds the film's soundtrack: narration lines placed at their exact times, music ducked under the voice, sound effects,
// loudness-normalised for YouTube (-14 LUFS).
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const sound = require('./sound');

async function buildAudio(tl, outFile) {
  const dir = tl.dir;
  const inputs = [];
  const filters = [];
  const placed = [];
  let nIn = 0; // ffmpeg input index (inputs[] holds raw arguments, which are not always 2 per input)
  for (const sc of tl.scenes) {
    for (const L of sc.lines) {
      const a = tl.audio[L.id];
      if (!a || !a.file) continue;
      const delay = Math.round((sc.start + L.start) * 1000);
      inputs.push('-i', a.file);
      placed.push({ idx: nIn++, delay });
    }
  }
  const total = tl.total.toFixed(3);
  // music: your uploaded track, or a generated bed in the chosen mood ("mood": "wonder" | "tense" | …)
  const m = tl.film.music || null;
  let music = m && m.file && fs.existsSync(path.join(dir, m.file)) ? path.join(dir, m.file) : null;
  if (!music && m && m.mood) music = sound.musicFile(dir, sound.MOODS[m.mood] ? m.mood : 'wonder', tl.total);
  // sound effects placed on what appears on screen
  const fx = sound.placeSfx(tl).map((x) => ({ ...x, file: sound.sfxFile(dir, x.name, x.len) }));
  if (!placed.length && !music && !fx.length) {
    await ff.run(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', total, '-c:a', 'aac', '-b:a', '160k', outFile]);
    return outFile;
  }
  placed.forEach((p, k) => {
    filters.push(`[${p.idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${p.delay}|${p.delay}[n${k}]`);
  });
  let voice = null;
  if (placed.length === 1) voice = '[n0]';
  else if (placed.length > 1) {
    filters.push(`${placed.map((_, k) => `[n${k}]`).join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0[voice]`);
    voice = '[voice]';
  }
  let last = voice;
  if (music) {
    const mIdx = nIn++;
    inputs.push('-stream_loop', '-1', '-i', music);
    const vol = m.volume ?? (m.mood && !m.file ? 0.16 : 0.22);
    const fadeOut = m.fadeOut ?? 3;
    filters.push(`[${mIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol},atrim=0:${total},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, tl.total - fadeOut).toFixed(2)}:d=${fadeOut}[mus]`);
    if (voice) {
      filters.push(`${voice}asplit=2[v1][v2]`);
      filters.push(`[mus][v2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
      filters.push(`[v1][duck]amix=inputs=2:normalize=0:duration=longest[mix]`);
      last = '[mix]';
    } else last = '[mus]';
  }
  if (fx.length) {
    fx.forEach((x, k) => {
      const idx = nIn++;
      inputs.push('-i', x.file);
      const d = Math.round(x.at * 1000);
      filters.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${x.volume.toFixed(3)},adelay=${d}|${d}[fx${k}]`);
    });
    filters.push(`${fx.map((_, k) => `[fx${k}]`).join('')}amix=inputs=${fx.length}:normalize=0:dropout_transition=0[sfx]`);
    if (last) { filters.push(`${last}[sfx]amix=inputs=2:normalize=0:duration=longest[withfx]`); last = '[withfx]'; } else last = '[sfx]';
  }
  filters.push(`${last}apad,atrim=0:${total},loudnorm=I=-14:TP=-1.5:LRA=11[out]`);
  await ff.run([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', outFile]);
  return outFile;
}

// Captions: split each narration line into readable chunks timed by their share of characters.
function captionCues(tl, maxChars = 84) {
  const cues = [];
  for (const sc of tl.scenes) {
    for (const L of sc.lines) {
      // split at sentence ends first, then into evenly sized chunks (no orphan words)
      const sentences = String(L.text || '').match(/[^.!?;]+[.!?;]*["”’)]*\s*/g) || [];
      const chunks = [];
      for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
        const words = s.split(/\s+/);
        const n = Math.max(1, Math.ceil(s.length / maxChars));
        const per = Math.ceil(words.length / n);
        for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));
      }
      // merge very short chunks into their neighbour
      for (let i = chunks.length - 1; i > 0; i--) {
        if (chunks[i].length < 18 && (chunks[i - 1].length + chunks[i].length) <= maxChars * 1.25) { chunks[i - 1] += ' ' + chunks[i]; chunks.splice(i, 1); }
      }
      const totalChars = chunks.reduce((s, c) => s + c.length, 0) || 1;
      let t = sc.start + L.start;
      for (const c of chunks) {
        const d = L.dur * (c.length / totalChars);
        cues.push({ start: t, end: t + d, text: c });
        t += d;
      }
    }
  }
  return cues;
}

function writeSrt(cues, file) {
  const { srtTime } = require('./util');
  const body = cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(c.start + 0.3, c.end - 0.02))}\n${c.text}\n`).join('\n');
  fs.writeFileSync(file, body);
}

module.exports = { buildAudio, captionCues, writeSrt };
