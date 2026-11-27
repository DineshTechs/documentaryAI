'use strict';
// Fonts: free (OFL) Google Fonts are downloaded once into data/fonts on first start, with system fonts as fallback.
const fs = require('fs');
const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');

const GF = 'https://raw.githubusercontent.com/google/fonts/main';
// file name -> URL (Google Fonts repository; checked addresses)
const DOWNLOADS = [
  ['SpecialElite-Regular.ttf', `${GF}/apache/specialelite/SpecialElite-Regular.ttf`],
  ['Oswald.ttf', `${GF}/ofl/oswald/Oswald%5Bwght%5D.ttf`],
  ['Anton-Regular.ttf', `${GF}/ofl/anton/Anton-Regular.ttf`],
  ['CrimsonText-Regular.ttf', `${GF}/ofl/crimsontext/CrimsonText-Regular.ttf`],
  ['CrimsonText-Bold.ttf', `${GF}/ofl/crimsontext/CrimsonText-Bold.ttf`],
  ['PlayfairDisplay.ttf', `${GF}/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf`],
  ['Caveat.ttf', `${GF}/ofl/caveat/Caveat%5Bwght%5D.ttf`],
  ['CourierPrime-Regular.ttf', `${GF}/ofl/courierprime/CourierPrime-Regular.ttf`],
  ['Inter.ttf', `${GF}/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf`],
  // Devanagari (Hindi, Marathi…): used automatically for those letters inside any font stack
  ['Hind-Regular.ttf', `${GF}/ofl/hind/Hind-Regular.ttf`],
  ['Hind-Bold.ttf', `${GF}/ofl/hind/Hind-Bold.ttf`],
  ['NotoSerifDevanagari.ttf', `${GF}/ofl/notoserifdevanagari/NotoSerifDevanagari%5Bwdth%2Cwght%5D.ttf`],
  ['YatraOne-Regular.ttf', `${GF}/ofl/yatraone/YatraOne-Regular.ttf`],
];

// Font stacks used by the looks (first available wins).
// Each stack names a Devanagari font right after the Latin ones: the renderer falls back letter by letter, so English
// keeps its style and Hindi letters come from the Devanagari font (no empty boxes). "Nirmala UI"/"Mangal" are the
// Windows system fonts, used if the download failed.
const DEVA_SANS = '"Hind", "Noto Sans Devanagari", "Nirmala UI", "Mangal"';
const DEVA_SERIF = '"Noto Serif Devanagari", "Hind", "Nirmala UI", "Mangal"';
const STACKS = {
  display: `"Oswald", "Anton", "Bebas Neue", "Archivo Black", "Yatra One", ${DEVA_SANS}, "DejaVu Sans Condensed", "DejaVu Sans", sans-serif`,
  serif: `"Crimson Text", "Libre Baskerville", "Playfair Display", ${DEVA_SERIF}, "Liberation Serif", "DejaVu Serif", serif`,
  headline: `"Playfair Display", "Crimson Text", ${DEVA_SERIF}, "Liberation Serif", "DejaVu Serif", serif`,
  type: `"Special Elite", "Courier Prime", "Courier 10 Pitch", "Courier", ${DEVA_SANS}, "Liberation Mono", "DejaVu Sans Mono", monospace`,
  hand: `"Caveat", "Comic Relief", "Yatra One", ${DEVA_SANS}, "Liberation Sans", "DejaVu Sans", sans-serif`,
  sans: `"Inter", "Fira Sans", ${DEVA_SANS}, "Liberation Sans", "DejaVu Sans", sans-serif`,
};

let registered = false;

function registerAll(dirs) {
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      try { GlobalFonts.loadFontsFromDir(d); } catch (_) { /* ignore broken fonts */ }
    }
  }
  registered = true;
}

function ensureRegistered(dataFontsDir) {
  if (!registered) registerAll([dataFontsDir, path.resolve(__dirname, '..', '..', 'fonts')]);
}

async function downloadFonts(dataFontsDir, log = () => {}) {
  fs.mkdirSync(dataFontsDir, { recursive: true });
  let got = 0;
  for (const [file, url] of DOWNLOADS) {
    const dest = path.join(dataFontsDir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) throw new Error('empty');
      fs.writeFileSync(dest, buf);
      got++;
    } catch (e) {
      log(`font ${file}: ${e.message} (system fallback will be used)`);
    }
  }
  if (got) registerAll([dataFontsDir]);
  return got;
}

function families() {
  return GlobalFonts.families.map((f) => f.family);
}

function font(role, px, weight = '') {
  return `${weight ? weight + ' ' : ''}${Math.max(1, Math.round(px))}px ${STACKS[role] || STACKS.sans}`;
}

module.exports = { ensureRegistered, downloadFonts, families, font, STACKS };
