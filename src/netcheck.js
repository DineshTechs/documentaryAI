'use strict';
// Network diagnostics: checks, step by step, whether this server can reach each outside service the app uses.
// On shared hosting, outgoing connections are often blocked by the host's firewall or refused by the service's
// bot protection; this tells you which one, so you know whom to ask (your host or the service).
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const UA = 'DocumentaryStudio/2.1 (+https://github.com/DineshTechs/documentaryAI) Node.js';

const SERVICES = [
  { name: 'AI Awaaz (voice)', host: 'app.aiawaaz.io', path: '/api/mcp', method: 'POST' },
  { name: 'Anthropic (Claude)', host: 'api.anthropic.com', path: '/v1/models' },
  { name: 'Google Gemini', host: 'generativelanguage.googleapis.com', path: '/v1beta/models' },
  { name: 'OpenAI', host: 'api.openai.com', path: '/v1/models' },
  { name: 'DeepSeek', host: 'api.deepseek.com', path: '/models' },
  { name: 'OpenRouter', host: 'openrouter.ai', path: '/api/v1/models' },
  { name: 'ElevenLabs', host: 'api.elevenlabs.io', path: '/v1/models' },
  { name: 'Wikimedia Commons', host: 'commons.wikimedia.org', path: '/w/api.php?action=query&meta=siteinfo&format=json' },
  { name: 'YouTube upload', host: 'www.googleapis.com', path: '/youtube/v3/videoCategories?part=snippet&regionCode=IN' },
  { name: 'Telegram', host: 'api.telegram.org', path: '/' },
  { name: 'Fonts (GitHub)', host: 'raw.githubusercontent.com', path: '/google/fonts/main/README.md' },
];

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} timed out after ${ms / 1000} s`), { code: 'ETIMEDOUT' })), ms))]);

function tcp(ip, port, ms) {
  return withTimeout(new Promise((res, rej) => {
    const t0 = Date.now(), s = net.connect({ host: ip, port }, () => { s.destroy(); res(Date.now() - t0); });
    s.on('error', rej);
  }), ms, 'Connection');
}
function tlsHandshake(ip, host, ms) {
  return withTimeout(new Promise((res, rej) => {
    const s = tls.connect({ host: ip, servername: host, port: 443 }, () => { const c = s.getPeerCertificate(); s.destroy(); res(c && c.subject ? c.subject.CN : ''); });
    s.on('error', rej);
  }), ms, 'Secure connection');
}

// What a failure means, in plain words, and who can fix it
function explain(step, e, status, body) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  if (step === 'dns') return { why: `The server can't look up the address (${code || e.message}).`, fix: 'Ask your host (MilesWeb support) to check DNS on the server.' };
  if (step === 'tcp' && /ETIMEDOUT|timed out/i.test(code + (e && e.message))) return { why: 'The connection gets no answer: the hosting firewall is most likely blocking outgoing traffic to this address.', fix: 'Ask MilesWeb support to allow outgoing HTTPS (port 443) connections to this host.' };
  if (step === 'tcp') return { why: `The connection was refused (${code}).`, fix: 'Ask MilesWeb support whether outgoing connections to this host are blocked.' };
  if (step === 'tls') return { why: `The secure (https) connection failed (${code || e.message}). The host may be intercepting traffic or the server's certificates are out of date.`, fix: 'Ask MilesWeb support to check outgoing SSL/TLS connections from your account.' };
  if (status === 403 && /cloudflare|just a moment|attention required|cf-ray|access denied|error 1020|error 1010/i.test(body || ''))
    return { why: "The service's bot protection (Cloudflare) blocks requests from this server's IP address (common for shared hosting).", fix: "Ask the service's support to allow your server's IP address, or generate this step on your PC instead." };
  if (status === 403) return { why: 'The service refused this server (HTTP 403). It may block hosting-company IP addresses.', fix: "Contact the service's support with your server's IP address." };
  if (status === 429) return { why: 'The service is rate-limiting this server (HTTP 429).', fix: 'Wait a few minutes. On shared hosting, other sites on the same IP may be using it too.' };
  if (status >= 500) return { why: `The service had an error (HTTP ${status}).`, fix: 'Try again later.' };
  return null;
}

async function checkOne(svc, timeoutMs = 12000) {
  const out = { name: svc.name, host: svc.host, steps: [] };
  // 1. DNS (IPv4 and IPv6)
  let v4 = [], v6 = [];
  try { v4 = await withTimeout(dns.resolve4(svc.host), timeoutMs, 'DNS'); } catch (_) { /* may have only v6 */ }
  try { v6 = await withTimeout(dns.resolve6(svc.host), 4000, 'DNS'); } catch (_) { /* fine */ }
  if (!v4.length && !v6.length) {
    try { const l = await dns.lookup(svc.host); (l.family === 6 ? v6 : v4).push(l.address); }
    catch (e) { return { ...out, ok: false, failed: 'dns', ...explain('dns', e) }; }
  }
  out.steps.push(`DNS ok (${v4.length} IPv4, ${v6.length} IPv6)`);
  const ip = v4[0] || v6[0];
  // 2. TCP 443
  try { out.steps.push(`port 443 open (${await tcp(ip, 443, timeoutMs)} ms)`); }
  catch (e) {
    // try IPv6 too if IPv4 failed and v6 exists
    if (v4.length && v6.length) { try { await tcp(v6[0], 443, timeoutMs); out.steps.push('IPv4 blocked but IPv6 works'); } catch (_) { /* both failed */ } }
    if (!out.steps.some((s) => s.includes('IPv6 works'))) return { ...out, ok: false, failed: 'tcp', ...explain('tcp', e) };
  }
  // 3. TLS
  try { const cn = await tlsHandshake(ip, svc.host, timeoutMs); out.steps.push(`https ok${cn ? ` (${cn})` : ''}`); }
  catch (e) { return { ...out, ok: false, failed: 'tls', ...explain('tls', e) }; }
  // 4. HTTP request (a reply like 401 "no key" is fine: it means the service is reachable)
  try {
    const t0 = Date.now();
    const r = await fetch(`https://${svc.host}${svc.path}`, {
      method: svc.method || 'GET', headers: { 'user-agent': UA, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: svc.method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await r.text()).slice(0, 3000) + ' ' + [...r.headers.keys()].join(' ');
    out.status = r.status;
    out.steps.push(`HTTP ${r.status} in ${Date.now() - t0} ms`);
    const bad = explain('http', null, r.status, body);
    if (bad && [403, 429].includes(r.status) || r.status >= 500) return { ...out, ok: false, failed: 'http', ...bad };
    return { ...out, ok: true };
  } catch (e) {
    return { ...out, ok: false, failed: 'http', why: `The request failed: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}.`, fix: 'Try again; if it keeps failing, ask MilesWeb support about outgoing HTTPS.' };
  }
}

async function checkAll(only = null) {
  let ip = null;
  try { const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA } }); ip = (await r.json()).ip; } catch (_) { /* optional */ }
  const list = only ? (SERVICES.filter((s) => only.includes(s.host)).length ? SERVICES.filter((s) => only.includes(s.host)) : only.map((h) => ({ name: h, host: h, path: '/' }))) : SERVICES;
  const results = await Promise.all(list.map((s) => checkOne(s).catch((e) => ({ name: s.name, host: s.host, ok: false, why: e.message }))));
  return { server_ip: ip, node: process.version, results };
}

module.exports = { checkAll, checkOne, SERVICES, UA };
