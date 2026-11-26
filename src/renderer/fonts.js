'use strict';
// Fonts: free (OFL) Google Fonts are downloaded once into data/fonts on first start, with system fonts as fallback.
const fs = require('fs');
const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');

const GF = 'https://github.com/google/fonts/raw/main/ofl';
// role -> [download file, url]
const DOWNLOADS = [
  ['SpecialElite-Regular.ttf', `${GF}/specialelite/SpecialElite-Regular.ttf`],
  ['Oswald.ttf', `${GF}/oswald/Oswald%5Bwght%5D.ttf`],
  ['Anton-Regular.ttf', `${GF}/anton/Anton-Regular.ttf`],
  ['LibreBaskerville-Regular.ttf', `${GF}/librebaskerville/LibreBaskerville-Regular.ttf`],
  ['LibreBaskerville-Bold.ttf', `${GF}/librebaskerville/LibreBaskerville-Bold.ttf`],
  ['PlayfairDisplay.ttf', `${GF}/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf`],
  ['Caveat.ttf', `${GF}/caveat/Caveat%5Bwght%5D.ttf`],
  ['CourierPrime-Regular.ttf', `${GF}/courierprime/CourierPrime-Regular.ttf`],
  ['Inter.ttf', `${GF}/inter/Inter%5Bopsz%2Cwght%5D.ttf`],
];

// Font stacks used by the looks (first available wins).
const STACKS = {
  display: '"Oswald", "Anton", "Bebas Neue", "Archivo Black", "DejaVu Sans Condensed", "DejaVu Sans", sans-serif',
  serif: '"Libre Baskerville", "Playfair Display", "Crimson Text", "Liberation Serif", "DejaVu Serif", serif',
  headline: '"Playfair Display", "Libre Baskerville", "Liberation Serif", "DejaVu Serif", serif',
  type: '"Special Elite", "Courier Prime", "Courier 10 Pitch", "Courier", "Liberation Mono", "DejaVu Sans Mono", monospace',
  hand: '"Caveat", "Comic Relief", "Liberation Sans", "DejaVu Sans", sans-serif',
  sans: '"Inter", "Fira Sans", "Liberation Sans", "DejaVu Sans", sans-serif',
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
