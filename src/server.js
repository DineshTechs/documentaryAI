'use strict';
// Documentary Studio web server (plain Node.js http; works on cPanel "Setup Node.js App", any VPS, or your PC).
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const llm = require('./llm');
const tts = require('./tts');
const agent = require('./agent');
const services = require('./services');
const youtube = require('./youtube');
const seo = require('./seo');
const research = require('./research');
const { LOOKS } = require('./renderer/looks');
const { Router, HttpError, jsonBody, multipart, readCookie, cookieHeader, json, sendFile } = require('./http');

const STATIC = path.join(config.ROOT, 'static');
const r = new Router();
const SESSION = 'ds_session';


const loggedIn = (req) => !config.APP_PASSWORD || (readCookie(req, SESSION) || {}).ok === true;
const projectOr404 = (id) => { const p = store.getProject(id); if (!p) throw new HttpError(404, 'Film not found'); return p; };
const root = (p) => agent.projectRoot(p);

function projectJson(p) {
  let estimate = null;
  try { estimate = require('./eta').estimate(p); } catch (_) {}
  return { ...p, running: agent.isRunning(p.id), eta: estimate };
}

// ---------------------------------------------------------------- auth
r.get('/api/health', (req, res) => json(res, { ok: true, app: 'documentary-studio', logged_in: loggedIn(req) }));
r.post('/api/login', async (req, res) => {
  const { password = '' } = await jsonBody(req);
  const a = Buffer.from(String(password)), b = Buffer.from(config.APP_PASSWORD);
  if (config.APP_PASSWORD && a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return json(res, { ok: true }, 200, { 'set-cookie': cookieHeader(req, SESSION, { ok: true }) });
  }
  await new Promise((s) => setTimeout(s, 1000));
  json(res, { error: config.APP_PASSWORD ? 'Wrong password' : 'Set APP_PASSWORD in .env first' }, 403);
});
r.post('/api/logout', (req, res) => json(res, { ok: true }, 200, { 'set-cookie': `${SESSION}=; Path=/; Max-Age=0` }));

// ---------------------------------------------------------------- settings
const SETTING_KEYS = ['providers', 'default_llm', 'tts', 'youtube', 'channel', 'search', 'telegram', 'llm_prices'];
const MASK = '••••';
const SECRET = /(key|secret|token)$/i;
const HIDDEN = new Set(['access_token', 'refresh_token', 'expires_at', 'allowed', 'pair_code']);
function mask(o) {
  if (Array.isArray(o) || !o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (HIDDEN.has(k)) continue;
    out[k] = SECRET.test(k) && typeof v === 'string' && v ? MASK + v.slice(-4) : mask(v);
  }
  return out;
}
function merge(nw, old) {
  if (nw && typeof nw === 'object' && !Array.isArray(nw)) {
    const out = { ...(old && typeof old === 'object' ? old : {}) };
    for (const [k, v] of Object.entries(nw)) {
      if (HIDDEN.has(k)) continue;
      if (typeof v === 'string' && v.startsWith(MASK)) continue;
      out[k] = merge(v, out[k]);
    }
    return out;
  }
  return nw;
}
// Code changed on disk since this process started? (git pull / new files without a restart)
const codeStamp = () => {
  let max = 0;
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.(js|md)$/.test(f.name)) max = Math.max(max, fs.statSync(p).mtimeMs);
  } };
  try { walk(__dirname); } catch (_) {}
  return max;
};
const STARTED_CODE = codeStamp();
const STARTED_AT = Date.now();
function settingsJson(req) {
  const data = Object.fromEntries(SETTING_KEYS.map((k) => [k, store.getSetting(k, {}) || {}]));
  const yt = data.youtube;
  data.youtube_status = { connected: !!yt.refresh_token, channel: yt.channel_title || null, redirect_uri: youtube.redirectUri(req) };
  const out = mask(data);
  out.llm_priority = llm.priorityList();
  out.llm_order = store.getSetting('llm_order', []) || [];
  out.llm_status = llm.providerStatus();
  // usage + the price used for every model you have set up or used
  const months = store.getSetting('usage_monthly', {}) || {};
  const models = new Map();
  for (const m of Object.values(months)) for (const k of Object.keys(m.by_model || {})) { const [pr, ...rest] = k.split(':'); models.set(k, [pr, rest.join(':')]); }
  for (const [pr, c] of Object.entries(store.getSetting('providers', {}) || {})) if (c && c.model) models.set(`${pr}:${c.model}`, [pr, c.model]);
  out.usage = { months, prices: [...models.values()].filter(([, m]) => m).map(([pr, m]) => { const x = llm.priceFor(pr, m); return { provider: pr, model: m, price: x && x.p, source: x ? x.source : null }; }) };
  out.system = { database: store.status(), node: process.version, version: require('../package.json').version, url: youtube.publicUrl(req),
    data_dir: config.DATA_DIR, films: store.projects().length, restart_needed: codeStamp() > STARTED_CODE + 1000, pid: process.pid, started: STARTED_AT };
  return out;
}
r.get('/api/settings', async (req, res) => { await store.reloadSettings(); json(res, settingsJson(req)); });
r.put('/api/settings', async (req, res) => {
  const body = await jsonBody(req);
  await store.reloadSettings();
  for (const k of SETTING_KEYS) if (k in body) store.setSetting(k, merge(body[k], store.getSetting(k, {}) || {}));
  if (Array.isArray(body.llm_priority)) {
    const list = [...new Set(body.llm_priority.map(String))].filter((k) => llm.PROVIDERS[k]);
    store.setSetting('llm_priority', list);
    // keep the old single "default" in step (Telegram /status and older code read it)
    if (list[0]) store.setSetting('default_llm', { provider: list[0], model: llm.modelFor(list[0]) });
  }
  if (Array.isArray(body.llm_order)) store.setSetting('llm_order', body.llm_order.map(String).filter((k) => llm.PROVIDERS[k]));
  if ('telegram' in body) telegram.configure().catch(() => {});
  store.save(true); await store.flush(); // write to the database now, so other copies of the app see it straight away
  json(res, settingsJson(req));
});
r.post('/api/settings/test-llm', async (req, res) => {
  const b = await jsonBody(req);
  json(res, { ok: true, reply: await llm.test(b.provider, b.model) });
});
r.post('/api/settings/test-tts', async (req, res) => {
  const prov = (tts.settings().provider) || 'none';
  if (tts.UPLOAD_PROVIDERS.has(prov)) throw new HttpError(400, 'With this option you upload your own voice-over MP3 to each film, so there is nothing to test here.');
  const out = path.join(config.DATA_DIR, '_tts_test.mp3');
  const t = await tts.synthesize('This is a test of the narration voice for your documentary.', out);
  if (!t.ok) throw new HttpError(400, t.note);
  sendFile(req, res, out);
});
r.get('/api/tts/aiawaaz/:what', async (req, res, { what }) => {
  if (!['voices', 'account'].includes(what)) throw new HttpError(404, 'Not found');
  json(res, { text: await tts.aiawaazInfo(what) });
});
r.get('/api/tts/voices/:provider', async (req, res, { provider }) => {
  if (!['openai', 'elevenlabs', 'aiawaaz'].includes(provider)) throw new HttpError(404, 'Not found');
  try { json(res, { voices: (await tts.listVoices(provider, /fresh=1/.test(req.url))).map(({ raw, ...v }) => v) }); } catch (e) { throw new HttpError(400, e.message); }
});
r.get('/api/llm/models/:provider', async (req, res, { provider }) => {
  if (provider === 'default') provider = llm.defaultProviderModel()[0] || 'anthropic';
  if (!llm.PROVIDERS[provider]) throw new HttpError(404, 'Unknown provider');
  try { json(res, { models: await llm.listModels(provider, /fresh=1/.test(req.url)) }); } catch (e) { throw new HttpError(400, e.message); }
});
r.get('/api/net/check', async (req, res) => {
  const host = new URL(req.url, 'http://x').searchParams.get('host');
  json(res, await require('./netcheck').checkAll(host ? [host] : null));
});
r.get('/api/eta', (req, res) => {
  const d = Math.min(3600, Math.max(10, parseInt(new URL(req.url, 'http://x').searchParams.get('duration') || '90', 10)));
  json(res, require('./eta').estimate({ duration_s: d, stage: 'story', status: 'new' }));
});
r.get('/api/meta', (req, res) => json(res, {
  providers: Object.fromEntries(Object.entries(llm.PROVIDERS).map(([k, v]) => [k, { label: v.label, base_url: v.base_url, model_hint: v.model_hint, no_key: !!v.no_key, note: v.note || '', default_model: v.default_model || '' }])),
  tts_providers: tts.TTS_PROVIDERS, categories: youtube.CATEGORIES, skill_installed: true, stages: agent.STAGES,
  channel_language: (store.getSetting('channel', {}) || {}).language || 'English',
  looks: Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.label])),
}));
r.get('/api/setup-check', async (req, res) => {
  const { setupCheck } = require('./check');
  const out = await setupCheck({ render: req.query.render !== '0' });
  json(res, { ok: out.ok, output: out.lines.join('\n') });
});

// ---------------------------------------------------------------- projects
r.get('/api/projects', (req, res) => {
  const list = [...store.projects()].sort((a, b) => b.updated - a.updated).map((p) => {
    const m = store.getMeta(p.id);
    return { ...projectJson(p), youtube: { youtube_id: m.youtube_id, upload_status: m.upload_status, publish_at: m.publish_at } };
  });
  json(res, list);
});
r.post('/api/projects', async (req, res) => {
  const b = await jsonBody(req);
  json(res, projectJson(services.createProject(b, !!b.autostart)));
});
r.get('/api/projects/:id', (req, res, { id }) => json(res, projectJson(projectOr404(id))));
r.patch('/api/projects/:id', async (req, res, { id }) => {
  projectOr404(id);
  const b = await jsonBody(req);
  const allowed = {};
  for (const k of ['title', 'topic', 'brief', 'duration_s', 'look', 'aspect', 'language', 'provider', 'model', 'final_video', 'final_srt']) if (k in b) allowed[k] = b[k];
  json(res, projectJson(store.updateProject(id, allowed)));
});
r.delete('/api/projects/:id', (req, res, { id }) => {
  const p = projectOr404(id);
  agent.stop(id);
  if (req.query.files === '1') fs.rmSync(root(p), { recursive: true, force: true });
  store.deleteProject(id);
  json(res, { ok: true });
});
r.post('/api/projects/:id/start', (req, res, { id }) => { projectOr404(id); services.startOrResume(Number(id)); json(res, projectJson(store.getProject(id))); });
r.post('/api/projects/:id/stop', (req, res, { id }) => { projectOr404(id); agent.stop(Number(id)); json(res, { ok: true }); });
r.post('/api/projects/:id/message', async (req, res, { id }) => {
  projectOr404(id);
  const text = String((await jsonBody(req)).text || '').trim();
  if (!text) throw new HttpError(400, 'Empty message');
  json(res, { result: agent.sendUserMessage(Number(id), text) });
});
r.post('/api/projects/:id/approve', async (req, res, { id }) => {
  projectOr404(id);
  const b = await jsonBody(req);
  json(res, { result: agent.respondApproval(Number(id), !!b.approved, b.feedback || '') });
});
r.post('/api/projects/:id/render', async (req, res, { id }) => {
  projectOr404(id);
  const { quality = 'final' } = await jsonBody(req);
  agent.manualRender(Number(id), quality === 'draft' ? 'draft' : 'final');
  json(res, { ok: true });
});
r.post('/api/projects/:id/reset', (req, res, { id }) => { projectOr404(id); agent.resetConversation(Number(id)); json(res, { ok: true }); });
r.delete('/api/projects/:id/events', async (req, res, { id }) => { projectOr404(id); await store.clearEvents(Number(id)); json(res, { ok: true }); });
r.post('/api/events/clear-all', async (req, res) => { json(res, { ok: true, films: await store.clearEvents() }); });
r.get('/api/projects/:id/events', (req, res, { id }) => {
  const p = projectOr404(id);
  json(res, { events: store.eventsAfter(Number(id), Number(req.query.after || 0)), project: projectJson(p), live: agent.liveOutput(Number(id)) });
});

// ---------------------------------------------------------------- files
r.get('/api/projects/:id/files', (req, res, { id }) => {
  const p = projectOr404(id);
  const base = root(p);
  fs.mkdirSync(base, { recursive: true });
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || out.length > 3000) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { const st = fs.statSync(full); out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs / 1000 }); }
    }
  };
  walk(base);
  out.sort((a, b) => a.path.localeCompare(b.path));
  json(res, out);
});
r.get('/api/projects/:id/raw', (req, res, { id }) => {
  const p = projectOr404(id);
  let f;
  try { f = agent.safePath(p, req.query.path || ''); } catch (_) { throw new HttpError(403, 'Forbidden'); }
  sendFile(req, res, f, { download: req.query.dl === '1' });
});
r.put('/api/projects/:id/file', async (req, res, { id }) => {
  const p = projectOr404(id);
  const b = await jsonBody(req);
  const f = agent.safePath(p, b.path, true);
  if (String(b.path).endsWith('.json')) { try { JSON.parse(b.content); } catch (e) { throw new HttpError(400, `Not saved: invalid JSON (${e.message})`); } }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, b.content || '');
  store.addEvent(p.id, 'system', `You edited ${b.path}`);
  json(res, { ok: true });
});
r.post('/api/projects/:id/upload', async (req, res, { id }) => {
  const p = projectOr404(id);
  const { fields, files } = await multipart(req);
  const sub = String(fields.dir || 'uploads').replace(/^\/+|\/+$/g, '');
  const dest = agent.safePath(p, sub, true);
  fs.mkdirSync(dest, { recursive: true });
  const saved = [];
  for (const f of files) {
    const name = services.safeFilename(path.basename(f.filename));
    fs.writeFileSync(path.join(dest, name), f.data);
    saved.push(`${sub}/${name}`);
  }
  services.notifyUploads(p.id, saved);
  json(res, { saved });
});

// ---------------------------------------------------------------- metadata + YouTube
r.get('/api/projects/:id/metadata', (req, res, { id }) => { projectOr404(id); json(res, store.getMeta(Number(id))); });
r.put('/api/projects/:id/metadata', async (req, res, { id }) => { projectOr404(id); json(res, youtube.saveMeta(Number(id), await jsonBody(req))); });
r.post('/api/projects/:id/metadata/generate', async (req, res, { id }) => { const p = projectOr404(id); json(res, await youtube.generateMetadata(p, root(p))); });
r.post('/api/projects/:id/thumbnail', async (req, res, { id }) => {
  const p = projectOr404(id);
  if ((req.headers['content-type'] || '').startsWith('multipart/')) {
    const { files } = await multipart(req, 20 * 1024 * 1024);
    const f = files[0];
    if (!f) throw new HttpError(400, 'No file');
    const ext = path.extname(f.filename).toLowerCase() || '.jpg';
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) throw new HttpError(400, 'Thumbnail must be JPG or PNG');
    const rel = `uploads/thumbnail${ext}`;
    fs.mkdirSync(path.join(root(p), 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(root(p), rel), f.data);
    youtube.saveMeta(p.id, { thumbnail_path: rel });
    return json(res, { path: rel });
  }
  const b = await jsonBody(req);
  if (b.path) { // choose one of the designed thumbnails
    if (!/^out\/thumb_\d\.png$/.test(b.path) || !fs.existsSync(path.join(root(p), b.path))) throw new HttpError(400, 'Unknown thumbnail');
    youtube.saveMeta(p.id, { thumbnail_path: b.path });
    return json(res, { path: b.path });
  }
  json(res, { path: await youtube.extractThumbnail(p, root(p), Number(b.seconds || 0)) });
});
r.post('/api/projects/:id/thumbnails/design', async (req, res, { id }) => {
  const p = projectOr404(id);
  try { json(res, await youtube.designThumbnails(p, root(p))); } catch (e) { throw new HttpError(400, e.message); }
});
// SEO checklist + score, and a one-click fix that fills in what's missing
async function seoReport(p) {
  const m = store.getMeta(p.id);
  let duration = 0;
  try { if (p.final_video) duration = await require('./renderer/ffmpeg').duration(path.join(root(p), p.final_video)); } catch (_) { /* */ }
  const lang = seo.uploadLang(p, m, (store.getSetting('channel', {}) || {}).language);
  return { ...seo.audit(p, m, root(p), { duration }), language: lang, preview: seo.prepare(p, m, root(p), { duration, lang }) };
}
r.get('/api/projects/:id/seo', async (req, res, { id }) => json(res, await seoReport(projectOr404(id))));
r.post('/api/projects/:id/seo/fix', async (req, res, { id }) => {
  const p = projectOr404(id);
  const m = store.getMeta(p.id);
  if (!m.title || !m.description || (m.tags || []).length < 8 || !Object.keys(m.localized || {}).length || !m.focus_keyword) {
    // fill in what's missing, but keep what you already chose or wrote
    const keep = {};
    if (m.title) keep.title = m.title;
    if (p.aspect === '9:16' ? String(m.description || '').length >= 40 : (String(m.description || '').match(/[\p{L}\p{N}]+/gu) || []).length >= 120) keep.description = m.description;
    if ((m.tags || []).length >= 8) keep.tags = m.tags;
    await youtube.generateMetadata(p, root(p));
    if (Object.keys(keep).length) youtube.saveMeta(p.id, keep);
  }
  const r2 = await seoReport(p);
  // save the cleaned-up version so what you see is exactly what gets uploaded
  youtube.saveMeta(p.id, { title: r2.preview.title, description: r2.preview.description, tags: r2.preview.tags, language: r2.language });
  json(res, await seoReport(p));
});
r.post('/api/projects/:id/youtube-upload', async (req, res, { id }) => {
  const p = projectOr404(id);
  await youtube.accessToken();
  if (!youtube.startUpload(p, root(p))) throw new HttpError(400, 'An upload is already running');
  json(res, { ok: true });
});
r.get('/api/youtube/connect', (req, res) => {
  const state = crypto.randomBytes(12).toString('base64url');
  const redirect = youtube.redirectUri(req);
  json(res, { url: youtube.authUrl(state, redirect) }, 200, { 'set-cookie': cookieHeader(req, 'ds_oauth', { state, redirect }, 900) });
});
r.get(youtube.REDIRECT_PATH, async (req, res) => {
  const c = readCookie(req, 'ds_oauth') || {};
  if (!c.state || req.query.state !== c.state) return json(res, { error: 'Invalid OAuth state. Go back to the app and try again.' }, 400);
  if (req.query.error) { res.writeHead(302, { location: `/#/settings/youtube?yt=${encodeURIComponent(req.query.error)}` }); return res.end(); }
  try { await youtube.exchangeCode(req.query.code, c.redirect); }
  catch (e) { return json(res, { error: `YouTube connection failed: ${e.message}` }, 400); }
  res.writeHead(302, { location: '/#/settings/youtube?yt=connected', 'set-cookie': 'ds_oauth=; Path=/; Max-Age=0' });
  res.end();
});
r.post('/api/youtube/disconnect', (req, res) => { youtube.disconnect(); json(res, { ok: true }); });

// ---------------------------------------------------------------- ideas + calendar
r.get('/api/ideas', (req, res) => json(res, [...store.ideas()].sort((a, b) => (a.publish_date || '9999').localeCompare(b.publish_date || '9999') || b.id - a.id)));
r.post('/api/ideas', async (req, res) => {
  const b = await jsonBody(req);
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Title is required');
  json(res, store.addIdea({ title: b.title.trim(), notes: b.notes || '', status: b.status || 'idea', publish_date: b.publish_date || null }));
});
r.patch('/api/ideas/:id', async (req, res, { id }) => {
  const b = await jsonBody(req);
  const f = {};
  for (const k of ['title', 'notes', 'status', 'publish_date']) if (k in b) f[k] = b[k];
  json(res, store.updateIdea(id, f));
});
r.delete('/api/ideas/:id', (req, res, { id }) => { store.deleteIdea(id); json(res, { ok: true }); });
r.post('/api/ideas/brainstorm', async (req, res) => {
  const b = await jsonBody(req);
  json(res, await brainstorm(b.theme, Math.max(1, Math.min(20, parseInt(b.count || 8, 10)))));
});
async function brainstorm(theme, n = 8) {
  const ch = store.getSetting('channel', {}) || {};
  const existing = store.ideas().map((i) => i.title).slice(0, 60);
  const data = await llm.completeJson(`Suggest ${n} documentary video ideas for a YouTube channel.
Channel: ${ch.name || ''}. Style/audience: ${ch.style || ''}.
Theme or direction from the creator: ${theme || '(open)'}.
Videos are short narrated cinematic documentaries (history, true crime, science, tech) made from public-domain
archive photos, maps and documents - favour stories with rich public-domain imagery on Wikimedia Commons.
Avoid these existing ideas: ${JSON.stringify(existing)}
Return JSON: {"ideas": [{"title": "...", "notes": "hook, angle, why it would perform, key archive visuals"}]}`);
  return (data.ideas || []).slice(0, n).filter((i) => i.title).map((i) => store.addIdea({ title: i.title, notes: i.notes || '' }));
}
r.get('/api/calendar', (req, res) => {
  const ideas = store.ideas().filter((i) => i.publish_date).map(({ id, title, status, publish_date, project_id }) => ({ id, title, status, publish_date, project_id }));
  const uploads = store.allMeta().filter((m) => m.publish_at).map((m) => ({ project_id: m.project_id, publish_at: m.publish_at, youtube_id: m.youtube_id,
    upload_status: m.upload_status, title: (store.getProject(m.project_id) || {}).title })).filter((u) => u.title);
  json(res, { ideas, uploads });
});

// ---------------------------------------------------------------- telegram
const telegram = require('./telegram');
r.get('/api/telegram', (req, res) => json(res, telegram.publicStatus()));
r.post('/api/telegram/pair-code', (req, res) => { telegram.newPairCode(); json(res, telegram.publicStatus()); });
r.post('/api/telegram/remove', async (req, res) => { telegram.removeUser((await jsonBody(req)).id); json(res, telegram.publicStatus()); });
r.post('/api/telegram/test', async (req, res) => { await telegram.sendTest(); json(res, { ok: true }); });
r.post('/telegram/webhook/:secret', async (req, res, { secret }) => {
  const body = await jsonBody(req);
  const ok = await telegram.handleWebhook(req, secret, body);
  json(res, { ok }, ok ? 200 : 403);
});

// ---------------------------------------------------------------- server
let lastUrl = null;
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(u.searchParams);
  const pathname = u.pathname;
  try {
    if (!pathname.startsWith('/api/health') && !pathname.startsWith('/static/')) {
      const url = youtube.publicUrl(req);
      if (url !== lastUrl) { lastUrl = url; if (store.getSetting('public_url') !== url) store.setSetting('public_url', url); }
    }
    if (pathname === '/' || pathname === '/index.html') return sendFile(req, res, path.join(STATIC, 'index.html'));
    if (pathname.startsWith('/static/')) {
      const f = path.resolve(STATIC, '.' + pathname.slice('/static'.length));
      if (!f.startsWith(STATIC + path.sep)) throw new HttpError(403, 'Forbidden');
      return sendFile(req, res, f, { cache: false });
    }
    const open = ['/api/login', '/api/health'];
    const isOpen = open.includes(pathname) || pathname.startsWith('/telegram/webhook/');
    if ((pathname.startsWith('/api/') || pathname.startsWith('/oauth/')) && !isOpen && !loggedIn(req)) {
      return json(res, { error: 'Not logged in' }, 401);
    }
    const m = r.match(req.method, pathname);
    if (!m) {
      if (pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
      return sendFile(req, res, path.join(STATIC, 'index.html'));
    }
    await m.handler(req, res, m.params);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError) console.error(e); // real bugs only
    json(res, { error: e.message || String(e) }, status);
  }
}

function listen(port = config.PORT, host = config.HOST) {
  const server = http.createServer(handle);
  // connect the database first (MongoDB or local files), then start serving
  const ready = store.init().then((st) => {
    console.log(`Database: ${st.backend}${st.db && st.backend === 'mongodb' ? ` (${st.db})` : ''}${st.error ? ` - ${st.error}` : ''}`);
    // agents don't survive a restart; mark them so the UI offers "Resume"
    for (const p of store.projects()) if (p.status === 'running') store.updateProject(p.id, { status: 'stopped' });
    start();
  });
  const shutdown = () => { store.close().catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.ready = ready;
  return server;

  function start() {
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${port} is already in use - another copy of Documentary Studio (or another program) is running.\nClose that window first, or set a different PORT in .env.`);
    else console.error(`Could not start the web server: ${e.message}`);
    store.close().catch(() => {}).finally(() => process.exit(1));
  });
  server.listen(port, host, () => console.log(`Documentary Studio running on http://localhost:${port}`));
  // background: fonts, Telegram bot
  require('./renderer/fonts').downloadFonts(config.FONTS_DIR, (m) => console.log(m)).catch(() => {});
  telegram.start();
  // Keep-alive: shared hosting (cPanel/Passenger) stops apps that get no web requests. While films are being
  // made or uploaded, the app visits itself once a minute so long renders are not cut off.
  setInterval(() => {
    const busy = store.projects().some((p) => agent.isRunning(p.id)) || store.allMeta().some((m) => m.upload_status && !/^(done|error)/.test(m.upload_status));
    if (busy) fetch(`${youtube.publicUrl()}/api/health?keepalive=1`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, 60000).unref();
  }
}

module.exports = { handle, listen, brainstorm };
