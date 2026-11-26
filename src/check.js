'use strict';
// Setup check: can this server render films, and how fast? Run with "npm run check" or from Settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

async function setupCheck({ render = true } = {}) {
  const lines = [];
  let ok = true;
  const good = (s) => lines.push(`✓ ${s}`);
  const bad = (s) => { lines.push(`✗ ${s}`); ok = false; };
  const [maj] = process.versions.node.split('.').map(Number);
  (maj >= 18 ? good : bad)(`Node.js ${process.versions.node}${maj >= 18 ? '' : ' - version 18 or newer is required'}`);
  lines.push(`  CPU cores: ${os.cpus().length}, memory: ${Math.round(os.totalmem() / 1e9)} GB, data folder: ${config.DATA_DIR}`);
  try { fs.accessSync(config.DATA_DIR, fs.constants.W_OK); good('Data folder is writable'); } catch (_) { bad(`Cannot write to ${config.DATA_DIR}`); }
  const st = require('./store').status();
  if (st.backend === 'mongodb' && st.ok) good(`Database: MongoDB connected (database "${st.db}")`);
  else if (st.backend === 'files') good('Database: local files in the data folder (set MONGODB_URI to use MongoDB)');
  else bad(`Database: MongoDB problem - ${st.error}. Check MONGODB_URI, the password, and Network Access in MongoDB Atlas (allow your server's IP).`);
  try {
    require('@napi-rs/canvas');
    good('Graphics engine (@napi-rs/canvas, Skia) loaded');
  } catch (e) { bad(`Graphics engine failed to load: ${e.message}. Run "npm install" again.`); return { ok, lines }; }
  const ff = require('./renderer/ffmpeg');
  try { good(`ffmpeg: ${ff.versionLine()}  (${ff.ffmpegPath()})`); } catch (e) { bad(e.message); return { ok, lines }; }
  const fonts = require('./renderer/fonts');
  fonts.ensureRegistered(config.FONTS_DIR);
  const fams = fonts.families();
  const want = ['Special Elite', 'Oswald', 'Libre Baskerville', 'Caveat', 'Inter'];
  const have = want.filter((f) => fams.includes(f));
  (have.length >= 3 ? good : (s) => lines.push(`! ${s}`))(`Fonts: ${have.length}/${want.length} film fonts installed (${have.join(', ') || 'none yet'}); ${fams.length} fonts in total`);
  if (render) {
    const dir = path.join(config.DATA_DIR, '_check');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify({
      title: 'Check', look: 'documentary', captions: true,
      narration: [{ id: 'l1', text: 'Render test.' }],
      scenes: [{ id: 's1', lines: ['l1'], duration: 3, camera: [{ at: 0, zoom: 1 }, { at: 'end', zoom: 1.2, x: 0.45 }],
        elements: [
          { id: 'n1', type: 'note', text: 'Render test', x: 0.35, y: 0.45, w: 0.16, rotate: -4, enter: { at: 0.2, fx: 'pop' } },
          { id: 'c1', type: 'clipping', headline: 'Server can render films', body: 'Documentary Studio test render.', x: 0.65, y: 0.45, w: 0.24, rotate: 3, enter: { at: 0.6, fx: 'drop' } },
          { type: 'string', from: 'n1', to: 'c1', enter: { at: 1.2, fx: 'draw' } },
          { type: 'stamp', text: 'OK', x: 0.66, y: 0.6, w: 0.12, rotate: -10, enter: { at: 2, fx: 'stamp' } }]}] }));
    try {
      const { runJob } = require('./renderer');
      const t0 = Date.now();
      const res = await runJob('film', dir, { quality: 'final' }).promise;
      const secs = (Date.now() - t0) / 1000;
      if (!res.ok) bad(`Test render failed: ${(res.errors || []).join('; ')}`);
      else {
        const factor = secs / res.seconds;
        good(`Test render: ${res.seconds.toFixed(1)} s of 1080p video in ${secs.toFixed(1)} s (${factor.toFixed(1)}× real time)`);
        const est = Math.round((90 * factor) / 60 * 10) / 10;
        lines.push(`  → a 90-second film takes about ${est} minutes here${factor > 12 ? '. That is slow: use 720p, shorter films, or a bigger plan.' : '.'}`);
        fs.copyFileSync(path.join(dir, 'out', 'final.mp4'), path.join(config.DATA_DIR, 'check_render.mp4'));
      }
    } catch (e) { bad(`Test render failed: ${e.message}`); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok, lines };
}

module.exports = { setupCheck };

if (require.main === module) {
  setupCheck().then((r) => { console.log(r.lines.join('\n')); console.log(r.ok ? '\nAll good.' : '\nSome checks failed.'); process.exit(r.ok ? 0 : 1); });
}
