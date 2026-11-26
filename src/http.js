'use strict';
// Tiny HTTP toolkit (no frameworks needed): router, JSON/multipart bodies, signed cookies, static + ranged files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.srt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------------------------------------------------------------- router
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); } post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); } patch(p, h) { this.add('PATCH', p, h); } delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

// ---------------------------------------------------------------- bodies
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Upload too large (limit ${Math.round(limit / 1e6)} MB).`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const buf = await readBody(req, 10 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new HttpError(400, 'Invalid JSON body'); }
}

// multipart/form-data -> { fields, files: [{field, filename, type, data}] }
async function multipart(req, limit = 400 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new HttpError(400, 'Expected multipart/form-data');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const buf = await readBody(req, limit);
  const fields = {}, files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.slice(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next === -1) break;
    const data = buf.slice(headEnd + 4, next - 2);
    const name = (head.match(/name="([^"]*)"/i) || [])[1];
    const filename = (head.match(/filename="([^"]*)"/i) || [])[1];
    const type = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1];
    if (filename != null) { if (filename) files.push({ field: name, filename, type, data }); } else if (name) fields[name] = data.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

// ---------------------------------------------------------------- signed cookies
const sign = (v) => crypto.createHmac('sha256', config.SECRET_KEY).update(v).digest('base64url');
function readCookie(req, name) {
  const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  if (!raw) return null;
  const [val, sig] = decodeURIComponent(raw.slice(name.length + 1)).split('.');
  if (!val || !sig) return null;
  const good = sign(val);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(val, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Date.now() / 1000) return null;
    return data;
  } catch (_) { return null; }
}
function cookieHeader(req, name, data, maxAge = 60 * 60 * 24 * 30) {
  const val = Buffer.from(JSON.stringify({ ...data, exp: Date.now() / 1000 + maxAge })).toString('base64url');
  const secure = String(req.headers['x-forwarded-proto'] || '').startsWith('https') || req.socket.encrypted;
  return `${name}=${encodeURIComponent(val + '.' + sign(val))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------- responses
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, data, status = 200, headers = {}) => send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', ...headers });

function sendFile(req, res, file, { download = false, cache = false } = {}) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return json(res, { error: 'Not found' }, 404); }
  if (!st.isFile()) return json(res, { error: 'Not found' }, 404);
  const headers = { 'content-type': mimeOf(file), 'accept-ranges': 'bytes', 'cache-control': cache ? 'public, max-age=3600' : 'no-store',
    'last-modified': st.mtime.toUTCString() };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file).replace(/"/g, '')}"`;
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range && st.size > 0) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (end >= st.size) end = st.size - 1;
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

module.exports = { Router, HttpError, jsonBody, multipart, readCookie, cookieHeader, json, send, sendFile, mimeOf };
