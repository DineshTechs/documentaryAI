'use strict';
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
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers };
    if (this.session) headers['mcp-session-id'] = this.session;
    if (this.protocol) headers['mcp-protocol-version'] = this.protocol;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await r.text();
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

module.exports = { McpClient, resultText, parseResponse };
