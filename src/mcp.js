'use strict';
const UA = 'DocumentaryStudio/2.1 (+https://github.com/DineshTechs/documentaryAI) Node.js';
// "fetch failed" hides the real reason; show it, in words
function netError(e, url) {
  const c = (e && e.cause) || {};
  const code = c.code || e.code || '';
  const host = (() => { try { return new URL(url).host; } catch (_) { return url; } })();
  if (e.name === 'TimeoutError' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return `No answer from ${host} (timed out). On shared hosting this usually means the host's firewall blocks outgoing connections: run Settings → System → Connection test.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `This server can't look up ${host} (DNS ${code}).`;
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(code)) return `Connection to ${host} was refused or cut (${code}). The hosting firewall may block it: run Settings → System → Connection test.`;
  if (/CERT|SSL|TLS/i.test(code + (c.message || ''))) return `Secure connection to ${host} failed (${code || c.message}).`;
  return `Request to ${host} failed: ${code || c.message || e.message}`;
}
// Minimal MCP client (Streamable HTTP transport): lets the app call tools on MCP servers such as AI Awaaz.
// Handles JSON or Server-Sent-Events responses and the Mcp-Session-Id header.

const PROTOCOL = '2025-03-26';

class McpClient {
  constructor(url, headers = {}) {
    this.url = url;
    this.headers = headers;
    this.session = null;
    this.nextId = 1;
    this.ready = null;
    this.toolCache = null;
  }

  async rpc(method, params, { notify = false, timeoutMs = 180000 } = {}) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (!notify) body.id = this.nextId++;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': UA, ...this.headers };
    if (this.session) headers['mcp-session-id'] = this.session;
    if (this.protocol) headers['mcp-protocol-version'] = this.protocol;
    let r;
    try { r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(netError(e, this.url)); }
    if (r.status === 403) {
      const t = await r.text();
      throw new Error(/cloudflare|just a moment|cf-ray|error 10\d\d|access denied/i.test(t)
        ? `${new URL(this.url).host} blocked this server (HTTP 403, bot protection). Hosting-company IP addresses are often blocked: run Settings → System → Connection test, and ask the service to allow your server's IP.`
        : `HTTP 403 from ${new URL(this.url).host}: ${t.slice(0, 200)}`);
    }
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await r.text();
    if (/Wrong relay key|RELAY_KEY secret/.test(text)) throw new Error(`The AI Awaaz relay refused the request: ${/Wrong/.test(text) ? "the relay key in Settings → Narration voice doesn't match the worker's RELAY_KEY secret" : "the worker has no RELAY_KEY secret yet"}.`);
    if (r.status === 502 && /Relay could not reach/.test(text)) throw new Error(JSON.parse(text).error);
    if (r.status === 401 || r.status === 403) throw new Error('AI Awaaz rejected the API key (check it in Settings > Narration voice).');
    if (!r.ok) throw new Error(`MCP server error ${r.status}: ${text.slice(0, 300)}`);
    const msg = parseResponse(text, body.id, r.headers.get('content-type') || '');
    if (!msg) throw new Error(`MCP server sent no answer to ${method}.`);
    if (msg.error) throw new Error(`MCP ${method} failed: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  init() {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'documentary-studio', version: '2.0' } });
        this.protocol = (res && res.protocolVersion) || PROTOCOL;
        await this.rpc('notifications/initialized', null, { notify: true }).catch(() => {});
        return res;
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async tools() {
    await this.init();
    if (!this.toolCache) this.toolCache = ((await this.rpc('tools/list', {})) || {}).tools || [];
    return this.toolCache;
  }

  async call(name, args = {}, timeoutMs = 300000) {
    await this.init();
    const res = await this.rpc('tools/call', { name, arguments: args }, { timeoutMs });
    if (res && res.isError) throw new Error(`${name}: ${resultText(res).slice(0, 500) || 'tool error'}`);
    return res;
  }
}

// A response can be plain JSON (one message or a batch) or an SSE stream of "data:" lines.
function parseResponse(text, id, ctype) {
  const pick = (m) => (Array.isArray(m) ? m.find((x) => x.id === id) || m[0] : m);
  if (ctype.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    let found = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try {
        const m = pick(JSON.parse(data));
        if (m && (m.id === id || (m.result !== undefined || m.error !== undefined))) { found = m; if (m.id === id) break; }
      } catch (_) { /* skip partial */ }
    }
    return found;
  }
  try { return pick(JSON.parse(text)); } catch (_) { return null; }
}

// All text from a tool result (content blocks + structured content).
function resultText(res) {
  const parts = [];
  for (const c of (res && res.content) || []) {
    if (c.type === 'text' && c.text) parts.push(c.text);
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.uri || '', c.resource.text || '');
    else if (c.type === 'resource_link' && c.uri) parts.push(c.uri);
  }
  if (res && res.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  return parts.join('\n');
}

module.exports = {
  netError, McpClient, resultText, parseResponse };
