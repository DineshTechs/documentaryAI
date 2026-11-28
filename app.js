// Shared hosting often has broken IPv6: prefer IPv4 so outgoing requests don't hang
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) { /* old Node */ }
try { require('net').setDefaultAutoSelectFamily(true); } catch (_) { /* old Node */ }
'use strict';
// Documentary Studio - entry point.
// cPanel "Setup Node.js App": set the startup file to app.js. Anywhere else: npm start
require('./src/server').listen();
