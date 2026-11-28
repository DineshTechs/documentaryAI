'use strict';
// Sends requests through your Cloudflare Worker relay (set up for AI Awaaz) when this server can't reach a
// service directly, e.g. shared hosting whose firewall blocks some addresses. Direct is always tried first;
// after a network failure that host goes through the relay for 30 minutes.
const store = require('./store');

// Services the relay worker will forward to (it checks the same list)
const ALLOWED = /^(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.deepseek\.com|api\.groq\.com|api\.mistral\.ai|api\.x\.ai|gen\.pollinations\.ai|text\.pollinations\.ai|api\.elevenlabs\.io|commons\.wikimedia\.org|upload\.wikimedia\.org)$/;
const blocked = new Map(); // host -> until

function info() {
  const s = store.getSetting('tts', {}) || {};
  const url = String(s.aiawaaz_relay_url || '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  const key = String(s.aiawaaz_relay_key || '').trim();
  return /^https:\/\//.test(url) && key ? { url, key } : null;
}


function viaRelay(url, init, r) {
  return fetch(`${r.url}/proxy?u=${encodeURIComponent(url)}`, { ...init, headers: { ...(init.headers || {}), 'x-relay-key': r.key } });
}

// fetch() that falls back to the relay when the direct connection fails
async function fetchSmart(url, init = {}) {
  const host = (() => { try { return new URL(url).host; } catch (_) { return ''; } })();
  const r = ALLOWED.test(host) ? info() : null;
  if (r && (blocked.get(host) || 0) > Date.now()) return viaRelay(url, init, r);
  try { return await fetch(url, init); }
  catch (e) {
    const code = String((e.cause && e.cause.code) || '');
    if (!r || !(/fetch failed/i.test(e.message) || /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT|EHOSTUNREACH|ENETUNREACH/.test(code))) throw e;
    blocked.set(host, Date.now() + 30 * 60000);
    const res = await viaRelay(url, init, r);
    if (res.status === 404 && /Not found/.test(await res.clone().text())) throw new Error(`${host} can't be reached from this server, and your relay worker is an older version without the AI relay. Update it: Settings → Narration voice → AI Awaaz → Relay → Copy relay script, paste it into the Cloudflare worker and Deploy.`);
    return res;
  }
}

module.exports = { fetchSmart, ALLOWED, info };
