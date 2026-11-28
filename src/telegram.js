'use strict';
// Telegram bot: control everything from your phone, plus push notifications.
// Webhook mode when the app has a public https address (best for cPanel/Passenger: Telegram wakes the app),
// long polling otherwise (local PC). Only paired Telegram accounts can use it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const llm = require('./llm');
const agent = require('./agent');
const services = require('./services');
const youtube = require('./youtube');
const config = require('./config');

const API = 'https://api.telegram.org';
const MAX_SEND = 49 * 1024 * 1024;
const MAX_GET = 20 * 1024 * 1024;
const STATUS = { running: false, username: null, error: null, mode: null };
let bot = null;

const COMMANDS = [
  ['films', 'List films'], ['film', 'Film card: /film 3'], ['new', 'New film: /new Title | topic | 90'], ['short', 'New YouTube Short: /short Title | topic | 60'],
  ['use', 'Set active film: /use 3'], ['status', "What's running and what needs you"],
  ['approve', 'Approve the pending step (optional note)'], ['changes', 'Request changes: /changes text'],
  ['say', 'Message the agent (or just type)'], ['resume', 'Start / resume the agent'], ['stop', 'Stop the agent'],
  ['log', 'Recent agent activity'], ['files', 'List files'], ['get', 'Download a file: /get path'],
  ['video', 'Send the film / latest render'], ['stills', 'Send review stills'],
  ['meta', 'YouTube metadata (generates if empty)'], ['title', 'Set title: /title text'],
  ['tags', 'Set tags: /tags a, b, c'], ['privacy', 'private | unlisted | public'],
  ['schedule', 'Schedule: /schedule 2026-12-01 18:00 (or off)'], ['thumb', 'Thumbnail from frame: /thumb 4.5'],
  ['upload', 'Upload to YouTube'], ['ideas', 'Idea board'], ['idea', 'Add idea: /idea Title | notes'],
  ['brainstorm', 'AI ideas: /brainstorm theme'], ['makefilm', 'Film from idea: /makefilm 5'],
  ['plan', 'Release date: /plan 5 2026-12-10'], ['calendar', 'Upcoming releases'],
  ['model', 'Show/set model: /model anthropic claude-opus-5-5'], ['models', 'Configured AI providers'], ['link', 'Web app address (tunnel)'], ['help', 'All commands'],
];

const HELP = `<b>Documentary Studio bot</b>

<b>Films</b>
/films · /film 3 · /use 3 (set the active film)
/new Title | topic | 90 | 16:9 | Hindi: create and start a film
/short Title | topic | 60 | Hinglish: create a vertical YouTube Short
/status: what's running and what needs you

<b>Agent</b> (acts on the active film, or put the film number first)
/approve [note] · /changes what to change
/resume · /stop · /log [n]
Just type a message to talk to the agent.

<b>Files</b>
/files · /get path · /video · /stills
Send photos, audio, voice notes or documents → saved to the film's uploads/.
Send a photo with caption <code>thumbnail</code> → YouTube thumbnail.

<b>YouTube</b>
/meta (/meta new regenerates) · /title … · /tags a, b
/privacy public · /schedule 2026-12-01 18:00 · /thumb 4.5 · /upload

<b>Planning</b>
/ideas · /idea Title | notes · /brainstorm theme
/makefilm 5 · /plan 5 2026-12-10 · /calendar

<b>AI</b>
/models · /model (show) · /model openai gpt-x (active film) · /model default anthropic claude-sonnet-5-5

<b>Web app</b>
/link: the web app's address when it runs on your PC with start_tunnel.bat`;

// ---------------------------------------------------------------- API client
class TG {
  constructor(token) { this.base = `${API}/bot${token}`; this.fbase = `${API}/file/bot${token}`; }
  async call(method, params = {}, files = null, timeoutMs = 60000) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
    let r;
    if (files) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(clean)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([fs.readFileSync(f.path)]), f.name);
      r = await fetch(`${this.base}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs) });
    } else {
      r = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clean), signal: AbortSignal.timeout(timeoutMs) });
    }
    let d;
    try { d = await r.json(); } catch (_) { throw new Error(`HTTP ${r.status}`); }
    if (!d.ok) throw new Error(d.description || `HTTP ${r.status}`);
    return d.result;
  }
  async download(fileId, dest) {
    const info = await this.call('getFile', { file_id: fileId });
    const r = await fetch(`${this.fbase}/${info.file_path}`, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  }
}

// ---------------------------------------------------------------- settings / state
const cfg = () => store.getSetting('telegram', {}) || {};
const saveCfg = (c) => store.setSetting('telegram', c);
const state = () => store.getSetting('telegram_state', {}) || {};
function updateState(fn) { const s = state(); fn(s); store.setSetting('telegram_state', s); return s; }
const chatState = (chat) => ((state().chats || {})[String(chat)]) || {};
const setChat = (chat, kw) => updateState((s) => { s.chats = s.chats || {}; s.chats[String(chat)] = { ...(s.chats[String(chat)] || {}), ...kw }; });
const allowedIds = () => (cfg().allowed || []).map((a) => a.id);
function pairCode() { const c = cfg(); if (!c.pair_code) { c.pair_code = crypto.randomBytes(4).toString('hex'); saveCfg(c); } return c.pair_code; }
function newPairCode() { const c = cfg(); c.pair_code = crypto.randomBytes(4).toString('hex'); saveCfg(c); return c.pair_code; }
function removeUser(uid) { const c = cfg(); c.allowed = (c.allowed || []).filter((a) => a.id !== Number(uid)); saveCfg(c); }
function publicStatus() {
  const code = pairCode();
  return { ...STATUS, pair_code: code, link: STATUS.username ? `https://t.me/${STATUS.username}?start=${code}` : null, allowed: cfg().allowed || [] };
}
const webhookSecret = (token) => crypto.createHash('sha256').update('tg:' + token).digest('hex').slice(0, 32);

// timezone helpers (no external libraries)
function tzName() { return cfg().timezone || 'UTC'; }
function zonedToUtc(dateStr, timeStr, tz) {
  // interpret "YYYY-MM-DD HH:MM" in tz -> Date (UTC)
  const [y, mo, d] = dateStr.split('-').map(Number), [h, mi] = timeStr.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).filter((p) => p.type !== 'literal').map((p) => [p.type, +p.value]));
    const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asLocal;
  }
  return new Date(guess);
}
const fmtLocal = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: tzName(), dateStyle: 'medium', timeStyle: 'short' }).format(date) + ` (${tzName()})`;

// ---------------------------------------------------------------- formatting
const e = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function mdToHtml(s, limit = 3000) {
  let t = String(s || '');
  if (t.length > limit) t = t.slice(0, limit) + '\n…';
  t = e(t);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>');
  return t.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$\n?/gm, '');
}
const ICON = { running: '🟡', awaiting_approval: '✋', done: '✅', error: '⚠️', idle: '⏸', stopped: '⏹', new: '🆕' };
function statusOf(p) {
  const st = agent.isRunning(p.id) ? 'running' : p.status;
  return [st, ICON[st] || '•', { awaiting_approval: 'needs approval', new: 'not started' }[st] || st];
}
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b > 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);
const btn = (text, data, url) => (url ? { text, url } : { text, callback_data: String(data).slice(0, 64) });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
function appLinkRow(pid) {
  const base = youtube.publicUrl();
  return base.startsWith('https://') ? [btn('🌐 Open in web app', null, `${base}/#/films/${pid}`)] : null;
}

// ---------------------------------------------------------------- sending
async function send(chat, text, markup = null) {
  if (!bot) return;
  const parts = [];
  for (let i = 0; i < Math.max(text.length, 1); i += 4000) parts.push(text.slice(i, i + 4000));
  for (let i = 0; i < parts.length; i++) {
    const rm = i === parts.length - 1 ? markup : null;
    try { await bot.call('sendMessage', { chat_id: chat, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: rm }); }
    catch (err) {
      if (/parse/i.test(err.message)) await bot.call('sendMessage', { chat_id: chat, text: parts[i].replace(/<[^>]+>/g, ''), reply_markup: rm });
      else throw err;
    }
  }
}
async function sendFile(chat, file, caption = null, kind = null) {
  const size = fs.statSync(file).size;
  if (size > MAX_SEND) return send(chat, `📦 <code>${e(path.basename(file))}</code> is ${fmtSize(size)}, over Telegram's 50 MB bot limit. Download it from the web app.`);
  const ext = path.extname(file).toLowerCase();
  kind = kind || (['.mp4', '.mov'].includes(ext) ? 'video' : ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && size < 10e6 ? 'photo' : ['.mp3', '.m4a'].includes(ext) ? 'audio' : 'document');
  const method = { video: 'sendVideo', photo: 'sendPhoto', audio: 'sendAudio' }[kind] || 'sendDocument';
  await bot.call(method, { chat_id: chat, caption: caption ? caption.slice(0, 1000) : null, parse_mode: caption ? 'HTML' : null, supports_streaming: kind === 'video' ? true : null },
    { [kind]: { path: file, name: path.basename(file) } }, 600000);
}
async function sendImages(chat, files, caption = null) {
  files = files.filter((f) => fs.existsSync(f) && fs.statSync(f).size < 10e6).slice(0, 10);
  if (!files.length) return;
  if (files.length === 1) return sendFile(chat, files[0], caption, 'photo');
  const media = files.map((f, i) => ({ type: 'photo', media: `attach://f${i}`, ...(i === 0 && caption ? { caption: caption.slice(0, 1000), parse_mode: 'HTML' } : {}) }));
  const att = Object.fromEntries(files.map((f, i) => [`f${i}`, { path: f, name: path.basename(f) }]));
  await bot.call('sendMediaGroup', { chat_id: chat, media }, att, 300000);
}
async function broadcast(text, markup) { for (const id of allowedIds()) { try { await send(id, text, markup); } catch (_) { /* skip */ } } }

// ---------------------------------------------------------------- film helpers
function resolvePid(chat, arg) {
  let pid = arg != null && /^#?\d+$/.test(String(arg).trim()) ? parseInt(String(arg).replace('#', ''), 10) : chatState(chat).active;
  if (!pid || !store.getProject(pid)) throw new Error('No film selected. Use /films then /use <number>, or add the number, e.g. /video 3');
  return pid;
}
function splitPid(chat, args) {
  const m = String(args || '').trim().match(/^#?(\d+)\s*([\s\S]*)$/);
  if (m && store.getProject(+m[1])) return [+m[1], m[2]];
  return [resolvePid(chat), String(args || '')];
}
const rootOf = (pid) => agent.projectRoot(store.getProject(pid));
function latestFiles(pid, pred, n) {
  const base = rootOf(pid), out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      if (x.name.startsWith('.')) continue;
      const f = path.join(d, x.name);
      if (x.isDirectory()) walk(f); else if (pred(f)) out.push(f);
    }
  };
  walk(base);
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, n);
}

async function filmCard(chat, pid) {
  const p = store.getProject(pid);
  const [st, icon, label] = statusOf(p);
  const m = store.getMeta(pid);
  const lines = [`🎞 <b>#${pid} ${e(p.title)}</b>`, `${icon} ${e(label)} · stage <b>${e(p.stage)}</b> · ${p.duration_s}s · ${e(p.aspect)} · ${e(p.look)}`,
    `<i>${e(String(p.topic || '').slice(0, 300))}</i>`, `AI: ${e(p.provider || 'default')}${p.model ? ' · ' + e(p.model) : ''}`];
  if (p.final_video) lines.push(`🎬 Final: <code>${e(p.final_video)}</code>`);
  if (m.youtube_id) lines.push(`▶️ https://youtu.be/${e(m.youtube_id)}`);
  else if (m.upload_status) lines.push(`⬆️ Upload: ${e(m.upload_status)} ${m.upload_progress || 0}%`);
  if (chatState(chat).active === pid) lines.push('📌 Active film');
  const run = st === 'running' ? [btn('■ Stop', `st:${pid}`)] : st === 'awaiting_approval' ? [btn('✓ Approve', `ap:${pid}:y`), btn('✎ Changes', `ap:${pid}:n`)]
    : (st === 'done' || p.stage === 'done') ? [] : [btn(st === 'new' ? '▶ Start' : '▶ Resume', `go:${pid}`)];
  await send(chat, lines.join('\n'), kb([...run, btn('📜 Log', `lg:${pid}`)], [btn('📁 Files', `fl:${pid}`), btn('🎬 Video', `vd:${pid}`), btn('🖼 Stills', `sl:${pid}`)],
    [btn('📝 Metadata', `md:${pid}`), btn('⬆ YouTube', `up:${pid}`), btn('📌 Use', `use:${pid}`)], appLinkRow(pid)));
}

async function showMeta(chat, pid, regenerate = false) {
  const p = store.getProject(pid);
  let m = store.getMeta(pid);
  if (regenerate || !m.title) { await send(chat, '✨ Writing title, description, tags and chapters…'); m = await youtube.generateMetadata(p, rootOf(pid)); }
  const opts = (m.title_options || []).map((o) => (typeof o === 'string' ? { title: o } : o));
  const t = [`📝 <b>#${pid} YouTube metadata</b>`, `<b>Title:</b> ${e(m.title)}`];
  if (opts.length) t.push('<b>Options:</b>\n' + opts.map((o, i) => `${i + 1}. ${e(o.title)}${o.score ? ` <i>(${o.score}/10)</i>` : ''}`).join('\n'));
  if (m.pinned_comment) t.push(`<b>Pinned comment idea:</b> ${e(m.pinned_comment)}`);
  try { const a = require('./seo').audit(p, m, rootOf(pid)); t.push(`<b>SEO score:</b> ${a.score}/100${a.score < 80 ? ` (missing: ${e(a.checks.filter((c) => !c.ok).map((c) => c.msg).slice(0, 3).join('; '))})` : ''}. Gaps are filled automatically on upload.`); } catch (_) { /* optional */ }
  t.push(`<b>Tags:</b> ${e((m.tags || []).join(', '))}`);
  t.push(`<b>Visibility:</b> ${e(m.privacy)}${m.publish_at ? ` · <b>scheduled</b> ${e(fmtLocal(new Date(m.publish_at)))}` : ''}`);
  if ((m.chapters || []).length) t.push('<b>Chapters:</b>\n' + m.chapters.slice(0, 20).map((c) => `${e(c.time)} ${e(c.label)}`).join('\n'));
  t.push(`<b>Thumbnail:</b> ${e(m.thumbnail_path || 'none')}`);
  t.push('<b>Description:</b>\n' + e(String(m.description || '').slice(0, 1500)));
  await send(chat, t.join('\n\n'), kb(opts.slice(0, 3).map((_, i) => btn(`Use title ${i + 1}`, `tt:${pid}:${i}`)), opts.slice(3, 5).map((_, i) => btn(`Use title ${i + 4}`, `tt:${pid}:${i + 3}`)),
    [btn('🔒 private', `pv:${pid}:private`), btn('🔗 unlisted', `pv:${pid}:unlisted`), btn('🌍 public', `pv:${pid}:public`)],
    [btn('🔄 Regenerate', `mg:${pid}`), btn('⬆ Upload to YouTube', `up:${pid}`)]));
  if (m.thumbnail_path && fs.existsSync(path.join(rootOf(pid), m.thumbnail_path))) await sendFile(chat, path.join(rootOf(pid), m.thumbnail_path), 'Current thumbnail', 'photo');
}

async function confirmUpload(chat, pid) {
  const p = store.getProject(pid), m = store.getMeta(pid), yt = youtube.creds();
  if (!yt.refresh_token) return send(chat, "YouTube isn't connected. Connect your channel in the web app: Settings → YouTube.");
  if (!p.final_video) return send(chat, "This film isn't finished yet, so there's no final video to upload.");
  if (!m.title) return send(chat, 'No title yet. Run /meta first.');
  const when = m.publish_at ? `scheduled for ${fmtLocal(new Date(m.publish_at))}` : m.privacy || 'private';
  await send(chat, `⬆️ Upload <b>${e(m.title)}</b> to <b>${e(yt.channel_title || 'your channel')}</b> as <b>${e(when)}</b>?`, kb([btn('✅ Yes, upload', `upok:${pid}`), btn('Cancel', `x:${pid}`)]));
}

function logText(pid, n = 15) {
  const ev = store.getEvents(pid).filter((x) => x.kind !== 'tool_result' && x.kind !== 'waiting').slice(-n);
  const icon = { assistant: '🤖', user: '🧑', tool: '🔧', error: '⚠️', approval: '✋', stage: '▸', done: '🎬', image: '🖼' };
  return ev.map((x) => `${icon[x.kind] || '·'} ${e(((x.kind === 'tool' ? `${(x.meta || {}).name}: ` : '') + x.text).replace(/\n/g, ' ').slice(0, 240))}`).join('\n') || 'No activity yet.';
}

// ---------------------------------------------------------------- commands
const H = {};
H.help = (c) => send(c, HELP);
H.link = (c) => {
  const u = require('./tunnel').current() || youtube.publicUrl();
  return u.startsWith('https://') ? send(c, `🌐 Web app: ${u}`, kb([btn('Open the web app', null, u)]))
    : send(c, 'The web app has no public address right now. On your PC, run <b>start_tunnel.bat</b>.');
};
H.films = async (c) => {
  const rows = [...store.projects()].sort((a, b) => b.updated - a.updated).slice(0, 20);
  if (!rows.length) return send(c, 'No films yet. Create one with\n<code>/new Title | topic | 90</code>');
  const active = chatState(c).active;
  await send(c, '🎞 <b>Films</b>\n' + rows.map((p) => { const [, ic, lb] = statusOf(p); return `${ic} <b>#${p.id}</b> ${e(p.title)}: ${e(lb)}, ${e(p.stage)}${p.id === active ? ' 📌' : ''}`; }).join('\n'),
    kb(...chunk(rows.slice(0, 12).map((p) => btn(`#${p.id} ${p.title.slice(0, 20)}`, `f:${p.id}`)), 2)));
};
H.film = (c, a) => filmCard(c, resolvePid(c, a.trim() || null));
H.use = async (c, a) => { const pid = resolvePid(c, a.trim()); setChat(c, { active: pid }); await send(c, `📌 Active film is now #${pid}.`); await filmCard(c, pid); };
H.new = async (c, a) => {
  if (!a.trim()) { setChat(c, { wait: { kind: 'new' } }); return send(c, 'Send the new film as:\n<code>Title | topic and angle | seconds | 16:9 or short | English/Hindi/Hinglish</code>\nOnly the title is required. Or use /short for a YouTube Short.'); }
  const parts = a.split('|').map((s) => s.trim());
  const body = { title: parts[0], topic: parts[1] || parts[0] };
  if (/^\d+$/.test(parts[2] || '')) body.duration_s = +parts[2];
  if (['16:9', '9:16', '1:1'].includes(parts[3])) body.aspect = parts[3];
  if (/^shorts?$/i.test(parts[3] || '')) body.aspect = '9:16';
  const lang = (parts[4] || '').toLowerCase();
  if (lang) body.language = lang.startsWith('hing') ? 'Hinglish' : lang.startsWith('hi') ? 'Hindi' : lang.startsWith('en') ? 'English' : parts[4];
  const p = services.createProject(body, true);
  setChat(c, { active: p.id, wait: null });
  await send(c, `🎬 Created <b>#${p.id} ${e(p.title)}</b> and started the agent. It's now your active film.\nI'll message you when it needs your approval.`, kb(appLinkRow(p.id)));
};
// /short Title | topic | seconds | language  -> a vertical YouTube Short
H.short = async (c, a) => {
  if (!a.trim()) return send(c, 'Send: <code>/short Title | topic and angle | seconds | English/Hindi/Hinglish</code>\nShorts are vertical (9:16) and at most 3 minutes; 45-60 s works best.');
  const parts = a.split('|').map((s) => s.trim());
  return H.new(c, [parts[0], parts[1] || '', parts[2] || '60', 'short', parts[3] || ''].join(' | '));
};
H.status = async (c) => {
  const rows = store.projects();
  const running = rows.filter((p) => agent.isRunning(p.id)), waiting = rows.filter((p) => p.status === 'awaiting_approval');
  const errors = rows.filter((p) => p.status === 'error' && !agent.isRunning(p.id));
  const ups = store.allMeta().filter((m) => m.upload_status && !/^done|^error/.test(m.upload_status));
  const [prov, model] = llm.defaultProviderModel(); const yt = youtube.creds();
  await send(c, ['📊 <b>Status</b>',
    '🟡 Working: ' + (running.map((p) => `#${p.id} ${e(p.title)} (${e(agent.liveOutput(p.id).current || '')})`).join(', ') || 'none'),
    '✋ Needs approval: ' + (waiting.map((p) => `#${p.id} ${e(p.title)}`).join(', ') || 'none'),
    '⚠️ Errors: ' + (errors.map((p) => `#${p.id} ${e(p.title)}`).join(', ') || 'none'),
    '⬆️ Uploads: ' + (ups.map((m) => `#${m.project_id} ${m.upload_progress}%`).join(', ') || 'none'),
    `🤖 AI: ${e(llm.priorityList().join(' → ') || 'not set')}`,
    (() => { const m = (store.getSetting('usage_monthly', {}) || {})[new Date().toISOString().slice(0, 7)]; return `💰 AI cost this month: ${m ? '$' + m.cost.toFixed(2) + ` (${m.calls} calls)` : '$0'}`; })(),
    `▶️ YouTube: ${e(yt.channel_title || (yt.refresh_token ? 'connected' : 'not connected'))}`].join('\n'),
  waiting.length ? kb(waiting.slice(0, 4).map((p) => btn(`✋ #${p.id} review`, `f:${p.id}`))) : null);
};
async function approve(c, a, ok) {
  const [pid, note] = splitPid(c, a);
  if (store.getProject(pid).status !== 'awaiting_approval') return send(c, `#${pid} isn't waiting for approval right now.`);
  if (!ok && !note.trim()) { setChat(c, { wait: { kind: 'feedback', pid } }); return send(c, `What should change in #${pid}? Send it as your next message.`); }
  const res = agent.respondApproval(pid, ok, note.trim());
  setChat(c, { wait: null });
  await send(c, `${ok ? '✅ Approved' : '✎ Changes sent'}. #${pid} agent ${e(res)}.`);
}
H.approve = (c, a) => approve(c, a, true);
H.changes = (c, a) => approve(c, a, false);
H.say = async (c, a) => {
  const [pid, text] = splitPid(c, a);
  if (!text.trim()) return send(c, 'Usage: /say [film] your message. Or just type a message.');
  const wasPending = store.getProject(pid).status === 'awaiting_approval';
  const res = agent.sendUserMessage(pid, text.trim());
  await send(c, `📨 Sent to #${pid}: ${e(res)}${wasPending ? ' (treated as a change request for the pending approval)' : ''}`);
};
H.resume = async (c, a) => { const pid = resolvePid(c, a.trim() || null); await send(c, `▶ #${pid}: ${e(services.startOrResume(pid))}`); };
H.stop = async (c, a) => { const pid = resolvePid(c, a.trim() || null); agent.stop(pid); await send(c, `■ Stopping #${pid}…`); };
H.log = async (c, a) => {
  const nums = (a.match(/#?\d+/g) || []).map((x) => +x.replace('#', ''));
  let pid = null, n = 15;
  if (nums.length >= 2) [pid, n] = nums; else if (nums.length === 1) { if (a.trim().startsWith('#') || store.getProject(nums[0])) pid = nums[0]; else n = nums[0]; }
  pid = resolvePid(c, pid);
  const live = agent.liveOutput(pid);
  await send(c, `📜 <b>#${pid} activity</b>\n${logText(pid, Math.min(n, 50))}${live.running && live.lines.length ? `\n\n<b>Live</b>\n<pre>${e(live.lines.slice(-10).join('\n')).slice(-1500)}</pre>` : ''}`);
};
H.files = async (c, a) => {
  const [pid, flt] = splitPid(c, a);
  const fs_ = latestFiles(pid, (f) => f.toLowerCase().includes(flt.toLowerCase()), 40);
  if (!fs_.length) return send(c, flt ? 'No matching files.' : 'No files yet.');
  await send(c, `📁 <b>#${pid} newest files</b>${flt ? ' matching ' + e(flt) : ''}\n` + fs_.map((f) => `<code>${e(path.relative(rootOf(pid), f))}</code> · ${fmtSize(fs.statSync(f).size)}`).join('\n') + '\n\nGet one with <code>/get path</code>');
};
H.get = async (c, a) => {
  const [pid, rel] = splitPid(c, a);
  if (!rel.trim()) return send(c, 'Usage: /get film.json');
  const f = agent.safePath(store.getProject(pid), rel.trim());
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(c, 'File not found. See /files');
  await sendFile(c, f, null, ['.mp4', '.mov'].includes(path.extname(f).toLowerCase()) ? null : 'document');
};
H.video = async (c, a) => {
  const pid = resolvePid(c, a.trim() || null);
  const p = store.getProject(pid);
  let f = p.final_video ? path.join(rootOf(pid), p.final_video) : null;
  if (!f || !fs.existsSync(f)) f = latestFiles(pid, (x) => /\.(mp4|mov)$/i.test(x), 1)[0];
  if (!f) return send(c, 'No video rendered yet.');
  await send(c, `🎬 Sending <code>${e(path.relative(rootOf(pid), f))}</code> (${fmtSize(fs.statSync(f).size)})…`);
  await sendFile(c, f, `#${pid} ${e(p.title)}`);
  if (p.final_srt && fs.existsSync(path.join(rootOf(pid), p.final_srt))) await sendFile(c, path.join(rootOf(pid), p.final_srt), null, 'document');
};
H.stills = async (c, a) => {
  const pid = resolvePid(c, a.trim() || null);
  const imgs = latestFiles(pid, (f) => /\.(png|jpe?g|webp)$/i.test(f) && /[\\/]out[\\/]/.test(f), 10);
  if (!imgs.length) return send(c, 'No stills yet.');
  await sendImages(c, imgs, `#${pid} latest stills`);
};
H.meta = async (c, a) => { const [pid, rest] = splitPid(c, a); await showMeta(c, pid, /^(new|regenerate|again)$/i.test(rest.trim())); };
H.title = async (c, a) => { const [pid, t] = splitPid(c, a); if (!t.trim()) return send(c, 'Usage: /title Your new title'); youtube.saveMeta(pid, { title: t.trim().slice(0, 100) }); await send(c, `✓ Title set: <b>${e(t.trim().slice(0, 100))}</b>`); };
H.tags = async (c, a) => { const [pid, t] = splitPid(c, a); const tags = t.split(',').map((x) => x.trim()).filter(Boolean); youtube.saveMeta(pid, { tags }); await send(c, `✓ ${tags.length} tags saved.`); };
H.privacy = async (c, a) => {
  const [pid, v] = splitPid(c, a);
  if (!['private', 'unlisted', 'public'].includes(v.trim().toLowerCase())) return send(c, 'Usage: /privacy private | unlisted | public');
  youtube.saveMeta(pid, { privacy: v.trim().toLowerCase() }); await send(c, `✓ Visibility: ${v.trim().toLowerCase()}`);
};
H.schedule = async (c, a) => {
  const [pid, v] = splitPid(c, a);
  if (/^(off|none|clear)?$/i.test(v.trim())) { youtube.saveMeta(pid, { publish_at: '' }); return send(c, '✓ Schedule cleared.'); }
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/);
  if (!m) return send(c, `Usage: /schedule 2026-12-01 18:00 (your timezone: ${e(tzName())}, change it in Settings → Telegram)`);
  const when = zonedToUtc(m[1], m[2], tzName());
  if (when.getTime() < Date.now() + 15 * 60000) return send(c, 'Pick a time at least 15 minutes from now.');
  youtube.saveMeta(pid, { publish_at: when.toISOString().replace(/\.\d{3}Z$/, 'Z') });
  await send(c, `✓ #${pid} will go public at ${e(fmtLocal(when))}. Upload it with /upload (it stays private until then).`);
};
H.thumb = async (c, a) => {
  const parts = a.trim().split(/\s+/).filter(Boolean);
  const pid = parts.length >= 2 ? resolvePid(c, parts[0]) : resolvePid(c);
  const secs = parseFloat(parts.length >= 2 ? parts[1] : parts[0] || '3');
  if (!Number.isFinite(secs)) return send(c, 'Usage: /thumb 4.5 (seconds into the final video)');
  const rel = await youtube.extractThumbnail(store.getProject(pid), rootOf(pid), secs);
  await sendFile(c, path.join(rootOf(pid), rel), `✓ Thumbnail set from ${secs}s`, 'photo');
};
H.upload = (c, a) => confirmUpload(c, resolvePid(c, a.trim() || null));
H.ideas = async (c) => {
  const rows = store.ideas().filter((i) => i.status !== 'published');
  if (!rows.length) return send(c, 'No ideas yet. /idea Title | notes, or /brainstorm a theme');
  const names = { idea: '💡 Ideas', research: '🔎 Research', production: '🎞 In production', scheduled: '📅 Scheduled' };
  const text = Object.keys(names).map((k) => { const g = rows.filter((i) => i.status === k); return g.length ? `<b>${names[k]}</b>\n` + g.map((i) => `#${i.id} ${e(i.title)}${i.publish_date ? ` · 📅 ${i.publish_date}` : ''}${i.project_id ? ` · film #${i.project_id}` : ''}`).join('\n') : null; }).filter(Boolean);
  const makeable = rows.filter((i) => !i.project_id).slice(0, 6);
  await send(c, text.join('\n\n') + '\n\n/makefilm &lt;id&gt; · /plan &lt;id&gt; YYYY-MM-DD', kb(...chunk(makeable.map((i) => btn(`🎞 Make #${i.id}`, `mk:${i.id}`)), 3)));
};
H.idea = async (c, a) => {
  if (!a.trim()) return send(c, 'Usage: /idea Title | notes');
  const [title, ...rest] = a.split('|');
  const i = store.addIdea({ title: title.trim(), notes: rest.join('|').trim() });
  await send(c, `💡 Idea #${i.id} saved.`, kb([btn('🎞 Make film now', `mk:${i.id}`)]));
};
H.brainstorm = async (c, a) => {
  await send(c, '✨ Brainstorming…');
  const made = await require('./server').brainstorm(a.trim(), 8);
  await send(c, '💡 <b>New ideas</b>\n\n' + made.map((i) => `<b>#${i.id} ${e(i.title)}</b>\n${e(String(i.notes || '').slice(0, 300))}`).join('\n\n'),
    kb(...chunk(made.map((i) => btn(`🎞 Make #${i.id}`, `mk:${i.id}`)), 4)));
};
H.makefilm = async (c, a) => {
  if (!/^#?\d+$/.test(a.trim())) return send(c, 'Usage: /makefilm <idea id> (see /ideas)');
  const p = services.makeFilmFromIdea(parseInt(a.trim().replace('#', ''), 10));
  setChat(c, { active: p.id });
  await send(c, `🎬 Film <b>#${p.id} ${e(p.title)}</b> created and the agent is working. It's your active film.`);
};
H.plan = async (c, a) => {
  const m = a.trim().match(/^#?(\d+)\s+(\d{4}-\d{2}-\d{2})$/);
  if (!m) return send(c, 'Usage: /plan <idea id> 2026-12-10');
  store.updateIdea(+m[1], { publish_date: m[2] });
  await send(c, `📅 Idea #${m[1]} planned for ${m[2]}.`);
};
H.calendar = async (c) => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const until = new Date(today.getTime() + 60 * 86400000), from = new Date(today.getTime() - 86400000);
  const items = [];
  const dayFmt = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short' }).format(d);
  for (const i of store.ideas()) if (i.publish_date) { const d = new Date(i.publish_date + 'T12:00:00Z'); if (d >= from && d <= until) items.push([d, `<b>${e(dayFmt(d, 'UTC'))}</b>: 💡 #${i.id} ${e(i.title)} (${e(i.status)})`]); }
  for (const m of store.allMeta()) if (m.publish_at) {
    const d = new Date(m.publish_at); const p = store.getProject(m.project_id);
    if (p && d >= from && d <= until) items.push([d, `<b>${e(dayFmt(d, tzName()))} ${e(new Intl.DateTimeFormat('en-GB', { timeZone: tzName(), hour: '2-digit', minute: '2-digit' }).format(d))}</b>: ▶️ film #${p.id} ${e(p.title)}${m.youtube_id ? ' · uploaded' : ' · not uploaded yet'}`]);
  }
  if (!items.length) return send(c, '📅 Nothing planned in the next 60 days. Use /plan or /schedule.');
  items.sort((x, y) => x[0] - y[0]);
  await send(c, '📅 <b>Next 60 days</b>\n' + items.map(([, s]) => s).join('\n'));
};
H.models = async (c) => {
  const saved = store.getSetting('providers', {}) || {};
  const [prov, model] = llm.defaultProviderModel();
  await send(c, ['🤖 <b>AI providers</b>', ...Object.entries(llm.PROVIDERS).map(([k, v]) => { const s = saved[k] || {}; return `${s.api_key || (k === 'custom' ? s.base_url : v.no_key) ? '✅' : '▫️'} <code>${k}</code> ${e(v.label)}${s.model ? ' · ' + e(s.model) : ''}`; }),
    `\nPriority: <b>${e(llm.priorityList().join(' → ') || 'not set')}</b>`, ...Object.entries(llm.providerStatus()).map(([k, v]) => `⏸ ${e(k)} paused ${v.minutes_left} min: ${e(v.reason)}`),
    'If one fails (limit, quota, error) the next one takes over. Change the order in Settings → AI models, or /model default &lt;provider&gt;.'].join('\n'));
};
H.model = async (c, a) => {
  const parts = a.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const pid = resolvePid(c); const p = store.getProject(pid); const [prov] = llm.defaultProviderModel();
    return send(c, `#${pid} uses <b>${e(p.provider || prov || 'default')}</b> ${e(p.model || '(provider default)')}\nChange: <code>/model openrouter some/model</code> · default: <code>/model default anthropic claude-sonnet-5-5</code>`);
  }
  if (parts[0] === 'default') {
    if (!llm.PROVIDERS[parts[1]]) return send(c, 'Usage: /model default <provider> [model]');
    // move it to the top of the priority list; the others stay as fallbacks
    store.setSetting('llm_priority', [parts[1], ...llm.priorityList().filter((k) => k !== parts[1])]);
    if (parts[2]) { const pr = store.getSetting('providers', {}) || {}; store.setSetting('providers', { ...pr, [parts[1]]: { ...(pr[parts[1]] || {}), model: parts[2] } }); }
    store.setSetting('default_llm', { provider: parts[1], model: llm.modelFor(parts[1]) });
    return send(c, `✓ ${e(parts[1])} ${e(llm.modelFor(parts[1]))} is now first.\nPriority: ${e(llm.priorityList().join(' → '))}`);
  }
  const [pid, rest] = splitPid(c, a);
  const rp = rest.trim().split(/\s+/).filter(Boolean);
  if (!rp.length || !llm.PROVIDERS[rp[0]]) return send(c, `Usage: /model <provider> [model]. Providers: ${Object.keys(llm.PROVIDERS).join(', ')}`);
  store.updateProject(pid, { provider: rp[0], model: rp[1] || null });
  await send(c, `✓ #${pid} now uses ${e(rp[0])} ${e(rp[1] || '(provider default)')}. It applies the next time the agent starts.`);
};
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ---------------------------------------------------------------- update routing
async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg) return;
  const chat = msg.chat.id, user = msg.from || {};
  const text = String(msg.text || '').trim();
  if (!allowedIds().includes(user.id)) {
    const m = text.match(/^\/start(?:@\w+)?\s+(\S+)/);
    if (m && m[1] === pairCode()) {
      const c = cfg();
      c.allowed = [...(c.allowed || []), { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id) }];
      c.pair_code = crypto.randomBytes(4).toString('hex');
      saveCfg(c);
      return send(chat, `✅ Paired! This chat now controls Documentary Studio and gets notifications.\n\n${HELP}`);
    }
    return send(chat, `🔒 This bot is private. To pair, open the web app → Settings → Telegram and use the pairing link or send <code>/start CODE</code>. Your Telegram user ID is <code>${user.id}</code>.`);
  }
  try {
    if (text.startsWith('/')) {
      const [cmdRaw, ...rest] = text.slice(1).split(' ');
      const cmd = cmdRaw.split('@')[0].toLowerCase();
      if (cmd === 'start') return send(chat, HELP);
      if (cmd !== 'changes') setChat(chat, { wait: null });
      const h = H[cmd];
      if (!h) return send(chat, 'Unknown command. /help');
      return await h(chat, rest.join(' '));
    }
    if (msg.photo || msg.document || msg.audio || msg.voice || msg.video) return await handleMedia(chat, msg);
    if (text) {
      const wait = chatState(chat).wait || {};
      if (wait.kind === 'new') { setChat(chat, { wait: null }); return await H.new(chat, text); }
      if (wait.kind === 'feedback') { setChat(chat, { wait: null }); const res = agent.respondApproval(wait.pid, false, text); return send(chat, `✎ Changes sent to #${wait.pid}: agent ${e(res)}.`); }
      return await H.say(chat, text);
    }
  } catch (err) { await send(chat, `⚠️ ${e(err.message)}`); }
}

async function handleMedia(chat, msg) {
  const pid = resolvePid(chat);
  const caption = String(msg.caption || '').trim();
  let obj, name;
  if (msg.photo) { obj = msg.photo[msg.photo.length - 1]; name = `photo_${msg.message_id}.jpg`; }
  else if (msg.document) { obj = msg.document; name = obj.file_name || `file_${msg.message_id}`; }
  else if (msg.audio) { obj = msg.audio; name = obj.file_name || `audio_${msg.message_id}.mp3`; }
  else if (msg.voice) { obj = msg.voice; name = `voice_${msg.message_id}.ogg`; }
  else { obj = msg.video; name = obj.file_name || `video_${msg.message_id}.mp4`; }
  if ((obj.file_size || 0) > MAX_GET) return send(chat, "That file is over Telegram's 20 MB bot download limit. Upload it in the web app instead.");
  const up = path.join(rootOf(pid), 'uploads');
  fs.mkdirSync(up, { recursive: true });
  let dest = path.join(up, services.safeFilename(name));
  await bot.download(obj.file_id, dest);
  if (dest.endsWith('.ogg')) {
    try { const mp3 = dest.replace(/\.ogg$/, '.mp3'); await require('./renderer/ffmpeg').run(['-i', dest, mp3]); fs.unlinkSync(dest); dest = mp3; } catch (_) { /* keep ogg */ }
  }
  const rel = `uploads/${path.basename(dest)}`;
  if (/^thumb/i.test(caption) && /\.(jpe?g|png)$/i.test(dest)) { youtube.saveMeta(pid, { thumbnail_path: rel }); return send(chat, `🖼 Thumbnail for #${pid} set.`); }
  services.notifyUploads(pid, [rel], caption);
  await send(chat, `📥 Saved <code>${e(rel)}</code> to #${pid} and told the agent.`);
}

async function handleCallback(q) {
  const user = q.from || {};
  const chat = (q.message && q.message.chat && q.message.chat.id) || user.id;
  try { await bot.call('answerCallbackQuery', { callback_query_id: q.id }); } catch (_) { /* ignore */ }
  if (!allowedIds().includes(user.id)) return;
  const [kind, a1, a2] = String(q.data || '').split(':');
  try {
    if (kind === 'mk') return await H.makefilm(chat, a1);
    const pid = parseInt(a1, 10);
    if (!store.getProject(pid)) return send(chat, 'That film no longer exists.');
    const map = {
      f: () => filmCard(chat, pid), use: () => H.use(chat, String(pid)), go: () => H.resume(chat, String(pid)), st: () => H.stop(chat, String(pid)),
      lg: () => send(chat, `📜 <b>#${pid} activity</b>\n${logText(pid)}`), fl: () => H.files(chat, String(pid)), vd: () => H.video(chat, String(pid)),
      sl: () => H.stills(chat, String(pid)), md: () => showMeta(chat, pid), mg: () => showMeta(chat, pid, true), up: () => confirmUpload(chat, pid),
      pv: () => H.privacy(chat, `${pid} ${a2}`), x: () => send(chat, 'Cancelled.'),
      tt: () => { const o = (store.getMeta(pid).title_options || [])[+a2]; const title = o && (typeof o === 'string' ? o : o.title); if (title) { youtube.saveMeta(pid, { title }); return send(chat, `✓ Title: <b>${e(title)}</b>`); } return null; },
      upok: async () => { await youtube.accessToken(); return send(chat, youtube.startUpload(store.getProject(pid), rootOf(pid)) ? `⬆️ Uploading #${pid}… I'll tell you when it's on YouTube.` : 'An upload is already running.'); },
      ap: () => approve(chat, String(pid), a2 === 'y'),
    };
    if (map[kind]) await map[kind]();
  } catch (err) { await send(chat, `⚠️ ${e(err.message)}`); }
}

// ---------------------------------------------------------------- notifications
async function notifyEvent(ev) {
  if (!bot || !allowedIds().length) return;
  const pid = ev.project_id, p = store.getProject(pid);
  if (!p) return;
  const meta = ev.meta || {};
  const level = cfg().notify || 'important';
  const line = `#${pid} ${e(p.title)}`;
  for (const chat of allowedIds()) {
    try {
      if (ev.kind === 'approval') {
        await send(chat, `✋ <b>${line}: needs your approval</b>\n\n<b>${e(meta.title)}</b>\n\n${mdToHtml(meta.summary)}\n\nReply with a message to request changes, or tap a button.`,
          kb([btn('✓ Approve & continue', `ap:${pid}:y`), btn('✎ Request changes', `ap:${pid}:n`)], appLinkRow(pid)));
        const files = (meta.files || []).slice(0, 12).map((rel) => { try { return agent.safePath(p, rel); } catch (_) { return null; } }).filter((f) => f && fs.existsSync(f) && fs.statSync(f).isFile());
        const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
        if (imgs.length) await sendImages(chat, imgs);
        for (const f of files) if (!imgs.includes(f)) await sendFile(chat, f, null, /\.(mp4|mov)$/i.test(f) ? 'video' : 'document');
        setChat(chat, { active: pid });
      } else if (ev.kind === 'done') {
        await send(chat, `🎬 <b>${line} is finished!</b>\n\n${mdToHtml(ev.text, 1500)}`, kb([btn('📝 Metadata', `md:${pid}`), btn('⬆ Upload to YouTube', `up:${pid}`)], appLinkRow(pid)));
        if (p.final_video && fs.existsSync(path.join(rootOf(pid), p.final_video))) await sendFile(chat, path.join(rootOf(pid), p.final_video), `#${pid} ${e(p.title)}`);
      } else if (ev.kind === 'error') {
        await send(chat, `⚠️ <b>${line}</b>\n<pre>${e(String(ev.text).slice(0, 1200))}</pre>`, kb([btn('▶ Retry / resume', `go:${pid}`), btn('📜 Log', `lg:${pid}`)]));
      } else if (ev.kind === 'stage') {
        await send(chat, `▸ ${line} → <b>${e(ev.text)}</b> stage`);
      } else if (ev.kind === 'system' && String(ev.text).startsWith('Uploaded to YouTube')) {
        await send(chat, `✅ ${line}: ${e(ev.text)}`);
      } else if (ev.kind === 'waiting' && level !== 'all') {
        await send(chat, `💬 <b>${line}: agent is waiting for you</b>\n\n${mdToHtml(ev.text || 'The agent paused.', 2500)}\n\nReply to answer.`, kb([btn('▶ Continue', `go:${pid}`), btn('📜 Log', `lg:${pid}`)]));
        setChat(chat, { active: pid });
      } else if (ev.kind === 'assistant' && level === 'all') {
        await send(chat, `🤖 ${line}\n${mdToHtml(ev.text, 2500)}`);
      }
    } catch (err) { STATUS.error = `notify: ${err.message}`; }
  }
}

// ---------------------------------------------------------------- lifecycle (webhook or polling)
let pollToken = null, started = false;
const lockFile = path.join(config.DATA_DIR, 'telegram.lock');
function haveLock() {
  // only one process may poll (cPanel can run several app processes)
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (cur.pid !== process.pid && Date.now() - cur.t < 45000) return false;
  } catch (_) { /* free */ }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, t: Date.now() }));
  return true;
}

async function configure() {
  const c = cfg();
  const tok = String(c.bot_token || '').trim();
  if (!c.enabled || !tok) { bot = null; pollToken = null; Object.assign(STATUS, { running: false, username: null, mode: null }); return; }
  const base = youtube.publicUrl();
  const mode = c.mode === 'polling' || !base.startsWith('https://') ? 'polling' : 'webhook';
  const key = `${tok}|${mode}|${base}`;
  if (STATUS.running && STATUS._key === key) return;
  try {
    const b = new TG(tok);
    const me = await b.call('getMe');
    await b.call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    if (mode === 'webhook') {
      await b.call('setWebhook', { url: `${base}/telegram/webhook/${webhookSecret(tok)}`, secret_token: webhookSecret(tok), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    } else {
      await b.call('deleteWebhook', {});
    }
    bot = b;
    Object.assign(STATUS, { running: true, username: me.username, error: null, mode, _key: key });
    if (mode === 'polling') { pollToken = tok; poll(tok); } else pollToken = null;
  } catch (err) {
    Object.assign(STATUS, { running: false, error: `Could not start bot: ${err.message}` });
  }
}

async function poll(tok) {
  while (pollToken === tok) {
    if (!haveLock()) { await new Promise((r) => setTimeout(r, 15000)); continue; }
    try {
      const updates = await bot.call('getUpdates', { offset: state().offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, null, 40000);
      for (const u of updates) {
        updateState((s) => { s.offset = u.update_id + 1; });
        handleUpdate(u).catch((err) => { STATUS.error = err.message; });
      }
    } catch (err) {
      if (/Conflict/.test(err.message)) STATUS.error = 'Another program is using this bot token.';
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// called by the HTTP server for webhook mode
async function handleWebhook(req, secret, body) {
  const tok = String(cfg().bot_token || '');
  if (!tok || secret !== webhookSecret(tok) || req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret(tok)) return false;
  if (!bot) bot = new TG(tok);
  await handleUpdate(body).catch((err) => { STATUS.error = err.message; });
  return true;
}

function start() {
  if (started || config.TELEGRAM_DISABLED) return;
  started = true;
  store.onEvent((ev) => { notifyEvent(ev).catch(() => {}); });
  require('./tunnel').watch((u) => { broadcast(`🌐 The web app is online at a new address:\n${u}\n\n(Send /link any time to get it again.)`, kb([btn('Open the web app', null, u)])).catch(() => {}); });
  configure();
  setInterval(configure, 20000).unref();
}

async function sendTest() {
  if (!bot) throw new Error('Bot is not running. Save a valid token and enable it first.');
  if (!allowedIds().length) throw new Error('No Telegram account is paired yet.');
  await broadcast('👋 Test message from Documentary Studio. Notifications are working.');
}

module.exports = { notifyEvent, start, configure, publicStatus, newPairCode, removeUser, sendTest, handleWebhook, handleUpdate, _set: (b) => { bot = b; }, STATUS, TG, zonedToUtc };
