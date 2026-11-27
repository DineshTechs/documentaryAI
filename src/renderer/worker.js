'use strict';
// Runs one render job in a separate process so the web app stays responsive.
const r = require('./render');

process.on('message', async (job) => {
  const progress = (done, total, label) => process.send({ type: 'progress', done, total, label });
  try {
    let result;
    if (job.cmd === 'film') result = await r.renderFilm(job.dir, { ...job.opts, onProgress: progress });
    else if (job.cmd === 'stills') result = await r.renderStills(job.dir, job.opts.times, job.opts);
    else if (job.cmd === 'contact') result = await r.contactSheet(job.dir, job.opts);
    else if (job.cmd === 'inspect') result = await r.inspect(job.dir);
    else if (job.cmd === 'thumbnails') result = await require('./thumbnail').renderThumbnails(job.dir, job.opts.specs || []);
    else throw new Error(`unknown job ${job.cmd}`);
    process.send({ type: 'done', result }, () => process.exit(0));
  } catch (e) {
    process.send({ type: 'error', error: e.message || String(e) }, () => process.exit(1));
  }
});
