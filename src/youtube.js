'use strict';
// YouTube: OAuth, resumable upload, captions, thumbnails, AI-written metadata.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const llm = require('./llm');
const seo = require('./seo');
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
  return config.BASE_URL || require('./tunnel').current() || store.getSetting('public_url') || `http://localhost:${config.PORT}`;
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
const ALLOWED = ['title', 'description', 'tags', 'chapters', 'title_options', 'thumbnail_ideas', 'category_id', 'privacy', 'publish_at', 'language', 'thumbnail_path', 'thumbnail_designs', 'pinned_comment', 'hashtags', 'focus_keyword', 'localized'];
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

// YouTube language code for a film (Hindi and Hinglish videos are tagged as Hindi)
const langCode = (p) => seo.langCode(p, (store.getSetting('channel', {}) || {}).language);
// the second language for the title/description: English for Indian-language videos, Hindi for English ones
const otherLang = (p) => (langCode(p) === 'en' ? 'hi' : 'en');
const otherLangName = (p) => (otherLang(p) === 'en' ? 'English' : 'Hindi (Devanagari)');

// ---------------------------------------------------------------- designed thumbnails
// Renders thumbnail variants (out/thumb_N.png). With no specs given, the AI designs 3 from the film's photos.
async function designThumbnails(p, root, specs = null) {
  const imgDir = path.join(root, 'images');
  const images = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => `images/${f}`) : [];
  if (!specs) {
    if (!images.length) throw new Error('This film has no photos in images/ to build a thumbnail from.');
    let credits = '';
    try { credits = fs.readFileSync(path.join(root, 'credits.md'), 'utf8').slice(0, 2500); } catch (_) {}
    const ch = store.getSetting('channel', {}) || {};
    const m = store.getMeta(p.id) || {};
    const prompt = `Design 3 different YouTube thumbnails for this documentary. They must make people click on a phone screen.
Title: ${m.title || p.title}
Topic: ${p.topic || ''}
Language of the video: ${p.language || ch.language || 'English'} (thumbnail text in that language; Hinglish -> short English or Hindi words)
Photos available (use exact paths): ${images.join(', ')}
Photo descriptions (from credits): ${credits || '(none)'}
Rules: 2-5 words of text that create curiosity and do NOT repeat the title; one highlighted word; pick the most dramatic photo;
"focus" is the point of interest in that photo (0-1 fractions); use circle/arrow only when there is a clear object to point at;
vary the 3 designs (different photo, wording or side). "badge" optional (a year or 1-2 words).
Reply with JSON: {"thumbnails": [{"image": "images/…", "text": "…", "highlight": "word", "side": "left|right", "focus": {"x": 0.5, "y": 0.4}, "circle": true, "arrow": false, "badge": "1903", "color": "yellow|red|white"}]}`;
    const data = await llm.completeJson(prompt, 'You are a top YouTube thumbnail designer. Reply with JSON only.', null, null, p.id);
    specs = (data.thumbnails || []).filter((t) => t && t.text);
    if (!specs.length) throw new Error('The AI did not return any thumbnail designs. Try again.');
  }
  specs = specs.map((t) => ({ ...t, image: images.includes(t.image) ? t.image : images[0] }));
  const { runJob } = require('./renderer');
  const res = await runJob('thumbnails', root, { specs }).promise;
  const cur = (store.getMeta(p.id) || {}).thumbnail_path;
  if (!cur || /^out\/thumb_\d\.png$/.test(cur)) saveMeta(p.id, { thumbnail_path: res.files[0] });
  saveMeta(p.id, { thumbnail_designs: specs });
  return { files: res.files, specs };
}

async function generateMetadata(p, root) {
  const ch = store.getSetting('channel', {}) || {};
  const prompt = `Write YouTube metadata for a documentary video.

Channel: ${ch.name || ''}
Channel style / audience: ${ch.style || ''}
Default description footer: ${ch.footer || ''}
Language: ${p.language || ch.language || 'English'} (write the title, description and tags in this language; for Hinglish use Hindi with English words, in a mix of Devanagari and English letters)${p.aspect === '9:16' ? '\nThis is a YouTube SHORT (vertical, under 3 minutes): title under 60 characters, 1-3 line description, end the description with #Shorts and 2 topic hashtags, no chapters.' : ''}
Video title (working): ${p.title}
Topic: ${p.topic || ''}

Project files (script, beat table, captions, credits, chapters):
${gatherContext(p, root) || '(no files yet - use the topic)'}

What makes people click (use it, honestly): a specific number or date, a surprising contrast ("They laughed. Then…"),
an open question, stakes or a mystery, the most dramatic moment. Put the strongest words first (phones cut long titles).
No clickbait that the video doesn't deliver, no ALL CAPS titles, max one emoji.

Return JSON only, with this shape:
{
 "title_options": [{"title": "under 70 characters (Shorts: under 60)", "score": 1-10, "why": "what makes it clickable, 5-10 words"}],  // 5 options, different angles
 "title": "the best of them",
 "description": "2-3 hook paragraphs, then a CHAPTERS block (one 'M:SS Label' per line, first 0:00, taken from chapters.txt when present), then a SOURCES & IMAGE CREDITS block built from credits.md (keep every attribution and licence), then the footer. At most 3 hashtags, at the very end.",
 "tags": ["15-25 search tags"],
 "chapters": [{"time": "0:00", "label": "..."}],
 "thumbnail_ideas": ["4 thumbnail concepts: image + 2-4 word overlay text"],
 "focus_keyword": "the main search phrase people would type to find this video (2-4 words, in the language people search in)",
 "hashtags": ["3 hashtags, most specific first"],
 "localized": {"${otherLang(p)}": {"title": "the chosen title translated/adapted for ${otherLangName(p)} searchers", "description": "the first 2-3 paragraphs of the description in ${otherLangName(p)} (no chapters/credits)"}},
 "pinned_comment": "a short question for viewers to answer in the comments, tied to the video (e.g. 'Would you have flown with them in 1903?')"
}
The description's first line is a hook sentence (it shows in search results) containing the focus keyword, then a
summary using the main search keywords naturally (long videos: 150-300 words before the chapters). Tags: the focus
keyword, spelling variants, names, places, years, the topic in both English and the video's language.
Never invent facts that are not in the script.`;
  const data = await llm.completeJson(prompt, undefined, null, null, p.id);
  const out = {};
  for (const k of ['title', 'description', 'tags', 'chapters', 'title_options', 'thumbnail_ideas', 'hashtags', 'pinned_comment', 'focus_keyword', 'localized']) if (data[k] != null) out[k] = data[k];
  const cur = store.getMeta(p.id) || {};
  if (!cur.language || cur.language === 'en') out.language = langCode(p); // the film's language (Hindi films were tagged English)
  // best-scored title first; accept plain strings from models that ignore the object shape
  if (Array.isArray(out.title_options)) {
    out.title_options = out.title_options.map((t) => (typeof t === 'string' ? { title: t } : t)).filter((t) => t && t.title)
      .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6);
    if (!out.title && out.title_options[0]) out.title = out.title_options[0].title;
  }
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
    let m = store.getMeta(pid);
    const video = p.final_video ? path.join(root, p.final_video) : null;
    if (!video || !fs.existsSync(video)) throw new Error('Final video file not found. Finish the film first.');
    // SEO autopilot: never upload without a title, description and tags
    if (!m.title || !m.description || !(m.tags || []).length) {
      store.saveMeta(pid, { upload_status: 'writing title, description and tags' });
      await generateMetadata(p, root);
      m = store.getMeta(pid);
    }
    if (!m.title) throw new Error('Add a title (or generate metadata) first.');
    let duration = 0;
    try { duration = await ff.duration(video); } catch (_) { /* chapters are checked without it */ }
    const lang = seo.uploadLang(p, m, (store.getSetting('channel', {}) || {}).language);
    const fix = seo.prepare(p, m, root, { duration, lang });
    const status = { privacyStatus: m.privacy || 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, embeddable: true, publicStatsViewable: true, license: 'youtube' };
    if (m.publish_at) { status.privacyStatus = 'private'; status.publishAt = m.publish_at; }
    const body = { snippet: { title: fix.title, description: fix.description, tags: fix.tags,
      categoryId: String(m.category_id || '27'), defaultLanguage: lang, defaultAudioLanguage: lang }, status };
    const parts = ['snippet', 'status'];
    if (Object.keys(fix.localizations).length) { body.localizations = fix.localizations; parts.push('localizations'); }
    store.saveMeta(pid, { seo_applied: fix.fixes });
    const size = fs.statSync(video).size;
    const init = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts.join(',')}`, {
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
      try { await uploadCaptions(videoId, path.join(root, p.final_srt), lang); notes.push('captions added'); }
      catch (e) { notes.push(`captions failed: ${e.message}`); }
    }
    if (m.thumbnail_path && fs.existsSync(path.join(root, m.thumbnail_path))) {
      try { await uploadThumbnail(videoId, path.join(root, m.thumbnail_path)); notes.push('thumbnail set'); }
      catch (e) { notes.push(`thumbnail failed (custom thumbnails need a verified channel): ${e.message}`); }
    }
    if (fix.fixes.length) notes.push(`SEO: ${fix.fixes.join(', ')}`);
    if (Object.keys(fix.localizations).length) notes.push(`title also in ${Object.keys(fix.localizations).join(', ')}`);
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
  saveMeta, generateMetadata, extractThumbnail, startUpload, designThumbnails, langCode };
