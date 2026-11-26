'use strict';
// Render jobs run in a child process (fork). Returns a promise; call cancel() to stop.
const path = require('path');
const { fork } = require('child_process');

function runJob(cmd, dir, opts = {}, onProgress) {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = fork(path.join(__dirname, 'worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let finished = false;
    child.on('message', (m) => {
      if (m.type === 'progress') onProgress && onProgress(m.done, m.total, m.label);
      else if (m.type === 'done') { finished = true; resolve(m.result); }
      else if (m.type === 'error') { finished = true; reject(new Error(m.error)); }
    });
    child.on('exit', (code, signal) => {
      if (!finished) reject(new Error(signal ? `Render stopped (${signal}).` : `Render process exited (code ${code}).`));
    });
    child.send({ cmd, dir, opts });
  });
  return { promise, cancel: () => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } } };
}

module.exports = { runJob };
