'use strict';
// Render jobs run in a child process (fork). Returns a promise; call cancel() to stop.
const path = require('path');
const { fork } = require('child_process');

function runJob(cmd, dir, opts = {}, onProgress) {
  let child;
  const promise = new Promise((resolve, reject) => {
    // On small hosting plans keep the render process's thread count low (threads count toward the process limit)
    const low = String(process.env.RENDER_THREADS || require('../config').RENDER_THREADS || '0') !== '0';
    child = fork(path.join(__dirname, 'worker.js'), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: low ? [...process.execArgv.filter((a) => !a.startsWith('--v8-pool-size')), '--v8-pool-size=2'] : process.execArgv,
      env: low ? { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '2' } : process.env,
    });
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
