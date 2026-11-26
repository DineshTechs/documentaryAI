'use strict';
// YouTube: OAuth, resumable upload, captions, thumbnails, AI-written metadata.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const llm = require('./llm');
const ff = require('./renderer/ffmpeg');
const config = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'];
const REDIRECT_PATH = '/oauth/youtube/callback';
const CATEGORIES = { 27: 'Education', 22: 'People & Blogs', 24: 'Entertainment', 25: 'News & Politics', 28: 'Science & Technology', 19: 'Travel & Events', 1: 'Film & Animation', 17: 'Sports' };

// The app's public address, detected from browser requests (works locally and on any host). BASE_URL overrides.
function urlFromRequest(req) {
  if (config.BASE_URL) return config.BASE_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  let proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (!proto) proto = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}
function publicUrl(req) {
  if (req) return urlFromRequest(req);
  return config.BASE_URL || store.getSetting('public_url') || `http://localhost:${config.PORT}`;
}
const redirectUri = (req) => publicUrl(req) + REDIRECT_PATH;
const creds = () => store.getSetting('youtube', {}) || {};

function authUrl(state, redirect) {
  const c = creds();
  if (!c.client_id) throw new Error('Add your Google OAuth client ID and secret in Settings first.');
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(text.slice(0, 400)), { body: text });
  return JSON.parse(text);
}

async function exchangeCode(code, redirect) {
  const c = creds();
  let tok;
  try {
    tok = await tokenRequest({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code' });
  } catch (e) {
    throw new Error(`Token exchange failed: ${e.message}${/redirect_uri/.test(e.body || '') ? ` Add this exact redirect URI to your Google OAuth client: ${redirect}` : ''}`);
  }
  c.refresh_token = tok.refresh_token || c.refresh_token;
  c.access_token = tok.access_token;
  c.expires_at = Date.now() / 1000 + (tok.expires_in || 3600) - 60;
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${c.access_token}` } });
    const info = await r.json();
    const item = (info.items || [])[0] || {};
    c.channel_title = item.snippet && item.snippet.title;
    c.channel_id = item.id;
  } catch (_) { /* channel name is optional */ }
  store.setSetting('youtube', c);
}

async function accessToken() {
  const c = creds();
  if (c.access_token && (c.expires_at || 0) > Date.now() / 1000) return c.access_token;
  if (!c.refresh_token) throw new Error('YouTube is not connected. Connect your channel in Settings.');
  let tok;
  try { tok = await tokenRequest({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }); }
  catch (e) { throw new Error(`Could not refresh the YouTube login (reconnect in Settings): ${e.message}`); }
  c.access_token = tok.access_token;
  c.expires_at = Date.now() / 1000 + (tok.expires_in || 3600) - 60;
  store.setSetting('youtube', c);
  return c.access_token;
}

function disconnect() {
  const c = creds();
  for (const k of ['refresh_token', 'access_token', 'expires_at', 'channel_title', 'channel_id']) delete c[k];
  store.setSetting('youtube', c);
}

// ---------------------------------------------------------------- metadata
const ALLOWED = ['title', 'description', 'tags', 'chapters', 'title_options', 'thumbnail_ideas', 'category_id', 'privacy', 'publish_at', 'language', 'thumbnail_path'];
function saveMeta(pid, data) {
  const fields = {};
  for (const k of ALLOWED) if (k in data) fields[k] = data[k];
  return store.saveMeta(pid, fields);
}

function gatherContext(p, root) {
  const order = (f) => (/script|beat|chapter|srt|credit|sources/i.test(f) ? 0 : 1);
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'uploads' || e.name === 'images' || e.name === 'audio') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(md|txt|srt)$/i.test(e.name) && fs.statSync(full).size < 400000) files.push(full);
    }
  };
  walk(root);
  files.sort((a, b) => order(path.basename(a)) - order(path.basename(b)));
  let budget = 45000;
  const parts = [];
  for (const f of files.slice(0, 20)) {
    const t = fs.readFileSync(f, 'utf8').slice(0, 12000);
    if (!t.trim()) continue;
    parts.push(`--- ${path.relative(root, f)} ---\n${t}`);
    budget -= t.length;
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}

async function generateMetadata(p, root) {
  const ch = store.getSetting('channel', {}) || {};
  const prompt = `Write YouTube metadata for a documentary video.

Channel: ${ch.name || ''}
Channel style / audience: ${ch.style || ''}
Default description footer: ${ch.footer || ''}
Language: ${ch.language || 'English'}
Video title (working): ${p.title}
Topic: ${p.topic || ''}

Project files (script, beat table, captions, credits, chapters):
${gatherContext(p, root) || '(no files yet - use the topic)'}

Return JSON only, with this shape:
{
 "title_options": ["5 strong, honest, curiosity-driven titles under 70 characters"],
 "title": "the best of them",
 "description": "2-3 hook paragraphs, then a CHAPTERS block (one 'M:SS Label' per line, first 0:00, taken from chapters.txt when present), then a SOURCES & IMAGE CREDITS block built from credits.md (keep every attribution and licence), then the footer. At most 3 hashtags, at the very end.",
 "tags": ["15-25 search tags"],
 "chapters": [{"time": "0:00", "label": "..."}],
 "thumbnail_ideas": ["4 thumbnail concepts: image + 2-4 word overlay text"]
}
Never invent facts that are not in the script.`;
  const data = await llm.completeJson(prompt);
  const out = {};
  for (const k of ['title', 'description', 'tags', 'chapters', 'title_options', 'thumbnail_ideas']) if (data[k] != null) out[k] = data[k];
  return saveMeta(p.id, out);
}

async function extractThumbnail(p, root, seconds) {
  const video = path.join(root, p.final_video || 'out/final.mp4');
  if (!fs.existsSync(video)) throw new Error('No final video yet.');
  const rel = `uploads/thumb_${Math.round(seconds * 10)}.jpg`;
  const out = path.join(root, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await ff.run(['-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '2', out]);
  if (!fs.existsSync(out)) throw new Error(`No frame at ${seconds}s. The time is probably past the end of the video.`);
  saveMeta(p.id, { thumbnail_path: rel });
  return rel;
}

// ---------------------------------------------------------------- upload
const uploading = new Set();

function startUpload(p, root) {
  if (uploading.has(p.id)) return false;
  uploading.add(p.id);
  store.saveMeta(p.id, { upload_status: 'starting', upload_progress: 0, upload_error: null });
  upload(p, root).finally(() => uploading.delete(p.id));
  return true;
}

async function upload(p, root) {
  const pid = p.id;
  try {
    const m = store.getMeta(pid);
    const video = p.final_video ? path.join(root, p.final_video) : null;
    if (!video || !fs.existsSync(video)) throw new Error('Final video file not found. Finish the film first.');
    if (!m.title) throw new Error('Add a title (or generate metadata) first.');
    const status = { privacyStatus: m.privacy || 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false };
    if (m.publish_at) { status.privacyStatus = 'private'; status.publishAt = m.publish_at; }
    const body = { snippet: { title: m.title.slice(0, 100), description: (m.description || '').slice(0, 5000), tags: m.tags || [],
      categoryId: String(m.category_id || '27'), defaultLanguage: m.language || 'en', defaultAudioLanguage: m.language || 'en' }, status };
    const size = fs.statSync(video).size;
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) },
    });
    if (!init.ok) throw new Error(`YouTube rejected the upload: ${(await init.text()).slice(0, 600)}`);
    const session = init.headers.get('location');
    store.saveMeta(pid, { upload_status: 'uploading' });
    const CHUNK = 8 * 1024 * 1024;
    const fd = fs.openSync(video, 'r');
    let sent = 0, videoId = null;
    try {
      while (sent < size) {
        const len = Math.min(CHUNK, size - sent);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, sent);
        let res = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            res = await fetch(session, { method: 'PUT', body: buf, headers: { authorization: `Bearer ${await accessToken()}`, 'content-range': `bytes ${sent}-${sent + len - 1}/${size}` }, signal: AbortSignal.timeout(600000) });
            if ([500, 502, 503, 504].includes(res.status)) { await new Promise((r) => setTimeout(r, 2 ** attempt * 1000)); continue; }
            break;
          } catch (_) { await new Promise((r) => setTimeout(r, 2 ** attempt * 1000)); res = null; }
        }
        if (!res) throw new Error('Upload kept failing; try again.');
        if (res.status === 308) {
          const range = res.headers.get('range');
          sent = range ? parseInt(range.split('-')[1], 10) + 1 : sent;
        } else if (res.status === 200 || res.status === 201) {
          videoId = (await res.json()).id; sent = size;
        } else throw new Error(`Upload error ${res.status}: ${(await res.text()).slice(0, 500)}`);
        store.saveMeta(pid, { upload_progress: Math.round((sent / size) * 1000) / 10 });
      }
    } finally { fs.closeSync(fd); }
    store.saveMeta(pid, { youtube_id: videoId, upload_status: 'processing captions/thumbnail', upload_progress: 100 });
    const notes = [];
    if (p.final_srt && fs.existsSync(path.join(root, p.final_srt))) {
      try { await uploadCaptions(videoId, path.join(root, p.final_srt), m.language || 'en'); notes.push('captions added'); }
      catch (e) { notes.push(`captions failed: ${e.message}`); }
    }
    if (m.thumbnail_path && fs.existsSync(path.join(root, m.thumbnail_path))) {
      try { await uploadThumbnail(videoId, path.join(root, m.thumbnail_path)); notes.push('thumbnail set'); }
      catch (e) { notes.push(`thumbnail failed (custom thumbnails need a verified channel): ${e.message}`); }
    }
    store.saveMeta(pid, { upload_status: 'done' + (notes.length ? ` (${notes.join('; ')})` : '') });
    if (p.idea_id) store.updateIdea(p.idea_id, { status: m.publish_at || status.privacyStatus === 'private' ? 'scheduled' : 'published' });
    store.addEvent(pid, 'system', `Uploaded to YouTube: https://youtu.be/${videoId}`);
  } catch (e) {
    store.saveMeta(pid, { upload_status: 'error', upload_error: String(e.message).slice(0, 1000) });
    store.addEvent(pid, 'error', `YouTube upload failed: ${String(e.message).slice(0, 800)}`);
  }
}

async function uploadCaptions(videoId, srtFile, lang) {
  const boundary = `docstudio${Date.now()}`;
  const meta = JSON.stringify({ snippet: { videoId, language: lang, name: '', isDraft: false } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fs.readFileSync(srtFile), Buffer.from(`\r\n--${boundary}--`)]);
  const r = await fetch('https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet', {
    method: 'POST', body, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': `multipart/related; boundary=${boundary}` } });
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
}

async function uploadThumbnail(videoId, file) {
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`, {
    method: 'POST', body: fs.readFileSync(file), headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
}

module.exports = { CATEGORIES, REDIRECT_PATH, publicUrl, redirectUri, creds, authUrl, exchangeCode, accessToken, disconnect,
  saveMeta, generateMetadata, extractThumbnail, startUpload };
