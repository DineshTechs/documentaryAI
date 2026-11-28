// Thread limits (must be set before anything else loads). The canvas graphics library starts one helper thread per
// CPU core; on big shared servers (e.g. 192 cores) that alone uses up the hosting account's process limit.
if (!process.env.TOKIO_WORKER_THREADS) process.env.TOKIO_WORKER_THREADS = '2';
if (!process.env.RAYON_NUM_THREADS) process.env.RAYON_NUM_THREADS = '2';
if ((process.env.RENDER_THREADS || '0') !== '0' && !process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '2';
// Shared hosting often has broken IPv6: prefer IPv4 so outgoing requests don't hang
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) { /* old Node */ }
try { require('net').setDefaultAutoSelectFamily(true); } catch (_) { /* old Node */ }
'use strict';
// Documentary Studio - entry point.
// cPanel "Setup Node.js App": set the startup file to app.js. Anywhere else: npm start
require('./src/server').listen();
