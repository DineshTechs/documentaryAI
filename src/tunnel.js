'use strict';
// The public https address made by start_tunnel.bat (Cloudflare Tunnel), so links and Telegram use it.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.ROOT, 'tunnel_url.txt');
let cache = { at: 0, url: '' };

function current() {
  if (Date.now() - cache.at < 5000) return cache.url;
  let url = '';
  try {
    // start_tunnel touches the file every 30 s; an old file means the window was closed
    if (Date.now() - fs.statSync(FILE).mtimeMs < 120000) { const t = fs.readFileSync(FILE, 'utf8').trim(); if (/^https:\/\/[\w.-]+$/.test(t)) url = t; }
  } catch (_) { /* no tunnel */ }
  cache = { at: Date.now(), url };
  return url;
}

// Calls onChange(url) when the tunnel starts or gets a new address
function watch(onChange, everyMs = 15000) {
  let last = current();
  setInterval(() => { const u = current(); if (u !== last) { last = u; if (u) onChange(u); } }, everyMs).unref();
}

module.exports = { current, watch, FILE };
