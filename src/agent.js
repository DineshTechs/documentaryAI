'use strict';
// The film-making agent. It works only through safe, structured tools (no shell commands), so it can run on
// ordinary web hosting: research, Wikimedia Commons images, narration voice, film.json, renders, reviews, approvals.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const llm = require('./llm');
const eta = require('./eta');
const youtube = require('./youtube');
const tts = require('./tts');
const research = require('./research');
const ff = require('./renderer/ffmpeg');
const { runJob } = require('./renderer');
const config = require('./config');

const STAGES = ['story', 'voice', 'images', 'scene', 'review', 'render', 'done'];
const MAX_TOOL_OUTPUT = 12000;
const KEEP_FULL_RECENT = 24;
const KEEP_IMAGES = 2;
const GUIDE = fs.readFileSync(path.join(__dirname, 'GUIDE.md'), 'utf8');

const projectRoot = (p) => path.join(config.PROJECTS_DIR, p.slug);

function safePath(p, rel, write = false) {
  const root = path.resolve(projectRoot(p));
  const cand = path.resolve(root, String(rel || '.').replace(/^\/+/, ''));
  if (cand === root || cand.startsWith(root + path.sep)) {
    if (write && path.basename(cand).startsWith('.')) throw new Error('Hidden files cannot be written.');
    return cand;
  }
  throw new Error(`Path "${rel}" is outside the film's workspace`);
}

const clip = (s, n = MAX_TOOL_OUTPUT) => {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, n / 2)}\n\n… [${s.length - n} characters cut] …\n\n${s.slice(-n / 2)}`;
};

// ---------------------------------------------------------------- tools
const TOOLS = [
  { name: 'read_file', description: 'Read a text file from the film workspace (script.md, beats.md, film.json, credits.md, …).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a text file in the film workspace (script.md, beats.md, sources.md, film.json).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a workspace file. Best for small changes to film.json.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'list_files', description: 'List files in the workspace (or a sub-folder) with sizes.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'web_search', description: 'Search the web (or Wikipedia when no search key is set) for research and fact-checking.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'web_fetch', description: 'Read a web page as text (Wikipedia pages come back as clean text).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'commons_search', description: 'Search Wikimedia Commons for freely licensed archive photos, maps, documents and paintings. Returns titles, sizes, licences, authors, dates and descriptions.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'commons_download', description: 'Download a Wikimedia Commons file (exact title from commons_search) into images/. Only free licences are allowed. The credit is added to credits.md automatically.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, save_as: { type: 'string', description: 'short file name without extension, e.g. wright_brothers' } }, required: ['title'] } },
  { name: 'tts_generate', description: 'Generate the narration audio for lines in film.json (narration ids) with the voice configured in Settings. Writes audio/<id>.mp3. Skips lines that already have audio unless force is true (use force after changing a line). Returns each line\'s length in seconds.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'line ids; omit for all lines' },
      force: { type: 'boolean', description: 'Regenerate lines that already have audio. Lines whose text and voice did not change are kept anyway (saves voice credits).' } } } },
  { name: 'audio_silences', description: 'Find the pauses in an uploaded voice recording (to split it into narration lines).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, min_silence: { type: 'number', description: 'seconds, default 0.45' } }, required: ['path'] } },
  { name: 'split_audio', description: 'Cut a recording into narration line files audio/<id>.mp3 at the given times (seconds). cuts has one fewer entry than ids.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, cuts: { type: 'array', items: { type: 'number' } }, ids: { type: 'array', items: { type: 'string' } } }, required: ['path', 'cuts', 'ids'] } },
  { name: 'check_film', description: 'Validate film.json and show the timing of every scene (start, length, lines). Run after every change to film.json.',
    parameters: { type: 'object', properties: {} } },
  { name: 'render_stills', description: 'Render single frames as PNG to review. times: seconds ("12.5"), a scene id ("s3" = 60% into it) or "s3@2.5". Then look at them with view_image.',
    parameters: { type: 'object', properties: { times: { type: 'array', items: { type: 'string' } } }, required: ['times'] } },
  { name: 'make_thumbnails', description: 'Render 2-3 designed YouTube thumbnails (1280x720, out/thumb_N.png) from the film photos: big 2-5 word text with one highlighted word, optional red circle/arrow on the point of interest, optional badge. The first one becomes the upload thumbnail; the user can pick another in Publish. View them with view_image.',
    parameters: { type: 'object', properties: { variants: { type: 'array', items: { type: 'object', properties: {
      image: { type: 'string', description: 'images/… photo' }, text: { type: 'string', description: '2-5 words, curiosity, not the title' },
      highlight: { type: 'string', description: 'word(s) to colour' }, side: { type: 'string', enum: ['left', 'right'], description: 'where the text goes' },
      focus: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'point of interest in the photo, 0-1' },
      circle: { type: 'boolean' }, arrow: { type: 'boolean' }, badge: { type: 'string' }, color: { type: 'string', enum: ['yellow', 'red', 'white', 'orange', 'cyan'] }, zoom: { type: 'number' } },
      required: ['image', 'text'] } } }, required: ['variants'] } },
  { name: 'render_contact_sheet', description: 'Render a grid of evenly spaced frames from the whole film (out/contact_sheet.png) for a quick visual review. Then view_image it.',
    parameters: { type: 'object', properties: { count: { type: 'integer', description: 'frames, default 12' } } } },
  { name: 'render_draft', description: 'Render a fast low-resolution draft with sound (default the first 30 s) to out/draft.mp4 for the user to approve.',
    parameters: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' } } } },
  { name: 'render_final', description: 'Render the final 1080p film with audio and captions: out/final.mp4, out/final.srt, out/chapters.txt. Unchanged scenes are reused from earlier renders.',
    parameters: { type: 'object', properties: {} } },
  { name: 'view_image', description: 'Look at an image (rendered still, contact sheet, downloaded photo) to review it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'set_stage', description: 'Tell the app which stage you are in: story, voice, images, scene, review, render.',
    parameters: { type: 'object', properties: { stage: { type: 'string', enum: STAGES.slice(0, -1) }, note: { type: 'string' } }, required: ['stage'] } },
  { name: 'request_approval', description: 'Pause and ask the user to approve (beat table, look, 30-second draft) or decide something. Work stops until they answer; the answer comes back as this tool\'s result. List the files to show them.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string', description: 'markdown' }, files: { type: 'array', items: { type: 'string' } } }, required: ['title', 'summary'] } },
  { name: 'finish', description: 'Call when the final film is rendered.',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, video: { type: 'string' }, srt: { type: 'string' } }, required: ['summary', 'video'] } },
];

const filmLanguage = (p) => p.language || (store.getSetting('channel', {}) || {}).language || 'English';
function languageRules(lang) {
  if (/hinglish/i.test(lang)) return `- Narration: natural spoken Hinglish, the way Indian YouTubers talk: Hindi sentences with common English words
  (technology, science, numbers, names). Write Hindi words in Devanagari and English words in English letters, e.g.
  "1903 में Wright brothers ने पहली powered flight की।"
- On-screen text (titles, labels, stamps, notes): short; Hindi in Devanagari or English, whichever reads faster.
- script.md, captions and narration lines use the same mix. Research can be in English.`;
  if (/hindi|हिन्दी|हिंदी/i.test(lang)) return `- Narration: simple, spoken Hindi (not formal/Sanskritised), written in Devanagari. Keep well-known English
  names and terms (Wright brothers, airplane) as people say them, in Devanagari (राइट ब्रदर्स) or English letters.
- On-screen text (titles, labels, stamps, notes): Hindi in Devanagari; dates and numbers in digits.
- Write numbers as digits (1903, 12 सेकंड) so the voice reads them correctly. Research can be in English.`;
  return `- Narration and on-screen text in ${lang}.`;
}

// What is already done, read from the workspace and the film's history (so a resume never starts over)
function progressReport(p) {
  const root = projectRoot(p);
  const ex = (f) => { try { return fs.statSync(path.join(root, f)); } catch (_) { return null; } };
  const ls = (d, re = /./) => { try { return fs.readdirSync(path.join(root, d)).filter((f) => !f.startsWith('.') && re.test(f)); } catch (_) { return []; } };
  const lines = [];
  for (const f of ['script.md', 'beats.md', 'sources.md']) { const st = ex(f); if (st && st.size > 20) lines.push(`- ${f}: written (${Math.round(st.size / 100) / 10} KB)`); }
  let film = null; try { film = JSON.parse(fs.readFileSync(path.join(root, 'film.json'), 'utf8')); } catch (_) { /* none yet */ }
  if (film) {
    const nar = film.narration || [];
    lines.push(`- film.json: ${nar.length} narration lines, ${(film.scenes || []).length} scenes${film.look ? `, look "${film.look}"` : ''}`);
    if (nar.length) {
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(root, 'audio', '.tts.json'), 'utf8')); } catch (_) {}
      const t = tts.settings(), voiceKey = `${t.provider}:${t[`${t.provider}_voice`] || ''}`;
      const sig = (l) => require('crypto').createHash('sha1').update(`${voiceKey}\n${l.text}`).digest('hex').slice(0, 16);
      const done = nar.filter((l) => ex(l.audio || `audio/${l.id}.mp3`) && (!meta[l.id] || meta[l.id] === sig(l))).length;
      lines.push(`- Voice: ${done} of ${nar.length} lines have up-to-date audio${done === nar.length ? ' (voice stage done; tts_generate would reuse them anyway)' : ''}`);
    }
  }
  const imgs = ls('images', /\.(jpe?g|png|webp|gif)$/i);
  if (imgs.length) lines.push(`- images/: ${imgs.length} downloaded (${imgs.slice(0, 12).join(', ')}${imgs.length > 12 ? ', …' : ''})`);
  const ups = ls('uploads');
  if (ups.length) lines.push(`- uploads/ (user's files): ${ups.slice(0, 10).join(', ')}${ups.length > 10 ? ', …' : ''}`);
  const outs = ls('out', /\.(mp4|png|jpg|srt)$/i);
  if (outs.length) lines.push(`- out/: ${outs.slice(0, 12).join(', ')}${outs.length > 12 ? ', …' : ''}`);
  const approved = (p.approved || []).map((a) => `"${a.title}"`);
  if (!approved.length) {
    // older films: read approvals from the activity history
    let lastAsk = null;
    for (const ev of store.getEvents(p.id) || []) {
      if (ev.kind === 'approval') lastAsk = ev.text;
      else if (ev.kind === 'user' && /^Approved/.test(ev.text || '') && lastAsk) { approved.push(`"${lastAsk}"`); lastAsk = null; }
    }
  }
  if (approved.length) lines.push(`- Approved by the user: ${approved.join(', ')}`);
  if (!lines.length) return '';
  return `\n## Work already done (read from the workspace just now)
Current stage: ${p.stage || 'story'}
${lines.join('\n')}
REUSE this work. Do not redo a finished stage, re-research, re-write approved files, re-download images that exist,
or ask again for an approval already given, unless the user asks for a change or something is actually broken.
When resuming, check the files (list_files / read_file) and continue from the first unfinished step.
tts_generate and the renders reuse unchanged lines and scenes automatically, so calling them again is cheap.\n`;
}

function systemPrompt(p) {
  const channel = store.getSetting('channel', {}) || {};
  const t = tts.settings();
  return `You are the film-making agent inside "Documentary Studio", a web app for a YouTube documentary channel.
You research, write and direct short narrated documentary films, then render them with the built-in renderer.
You work only through your tools. Follow the guide below closely.

## This film
- Title: ${p.title}
- Topic / angle: ${p.topic || p.title}
- Brief: ${p.brief || '(none)'}
- Target length: about ${p.duration_s || 90} seconds (≈ ${Math.round((p.duration_s || 90) * 2.5)} words of narration)
- Look: ${p.look && p.look !== 'auto' ? p.look : 'choose the best look for the subject'}
- Format: ${p.aspect || '16:9'}${p.aspect === '9:16' ? `
- THIS IS A YOUTUBE SHORT (vertical 1080x1920, watched on phones). Rules:
  - Hard limit 3 minutes (YouTube only counts vertical videos up to 3 min as Shorts); aim for the target length above.
  - Hook in the first 1-2 seconds: start on the most surprising fact or image, no title card first.
  - One idea per 2-4 seconds; fast cuts; big bold text (size 0.07+), few words per screen.
  - Keep text and faces in the middle: x 0.1-0.85, y 0.15-0.7 (YouTube's buttons cover the right edge and the bottom).
  - Photos should fill most of the frame (w 0.7-0.9); use one photo per scene rather than a busy board.
  - End with a line that makes people want to rewatch or comment. No "subscribe".` : ''}
- Workspace files: film.json, script.md, beats.md, sources.md, credits.md, images/, audio/, uploads/ (the user's own files), out/
${progressReport(p)}
## Channel
- Name: ${channel.name || '(not set)'}; style and audience: ${channel.style || '(not set)'}${(channel.recent_titles || []).length ? `\n- Recent videos on the channel (match their style; don't repeat them): ${channel.recent_titles.slice(0, 12).join(' | ')}` : ''}

## Language of this film: ${filmLanguage(p)}
The film language is ONLY for what the audience hears and reads: narration lines, script.md, captions and on-screen
text${filmLanguage(p) === 'English' ? '' : ' (and the YouTube title/description, which the app writes separately)'}.
Everything you say to the user is ALWAYS in English: chat messages, approval requests (title and summary), notes,
explanations, beats.md and sources.md descriptions. Quote the narration in the film language where needed, but write
your own words in English.
${languageRules(filmLanguage(p))}

## Keep working
Never end a reply by announcing the next step ("Next I'll…", "Now I'll move to…"): do it in the same reply by calling
the tool. Reply without a tool call ONLY when you need the user's answer, and then ask a clear question. After the user
approves a step, start the next step straight away.

## Voice
- Narration voice provider: ${t.provider || 'none'}${t.provider && t.provider !== 'none' && !tts.UPLOAD_PROVIDERS.has(t.provider) ? `; voice set in Settings: ${(t.provider === 'aiawaaz' ? t.aiawaaz_voice : t.provider === 'elevenlabs' ? t.elevenlabs_voice : t.provider === 'openai' ? t.openai_voice : '') || "(the provider's default)"}. tts_generate always uses this voice (it has no voice argument; to change voice the user changes Settings).` : ''}${(!t.provider || t.provider === 'none') ? ' - no voice is configured, so audio will be silent and timing estimated. Tell the user once that they can add a voice in Settings, then carry on.' : ''}
${tts.UPLOAD_PROVIDERS.has(t.provider) ? '- The voice-over is recorded OUTSIDE the app. Do NOT call tts_generate. In the Voice stage:\n  ' + tts.uploadNote(t.provider).split('\n').slice(1).join('\n  ') : ''}

## Working notes
- Renders take time on this server: use stills and contact sheets to review, a 30-second draft for approval,
  and the full render only once at the end.
- Keep chat messages short; the user sees your tool activity.

==================== GUIDE ====================
${GUIDE}`;
}

// ---------------------------------------------------------------- runners
class Runner {
  constructor(pid) { this.pid = pid; this.cancelled = false; this.job = null; this.live = []; this.inbox = []; this.current = null; this.running = false; }
  log(line) { this.live.push(String(line).slice(0, 300)); if (this.live.length > 200) this.live.splice(0, this.live.length - 200); }
}
const RUNNERS = new Map();
const isRunning = (pid) => !!(RUNNERS.get(Number(pid)) && RUNNERS.get(Number(pid)).running);
function liveOutput(pid) {
  const r = RUNNERS.get(Number(pid));
  if (!r) return { running: false, current: null, lines: [] };
  return { running: r.running, current: r.current, lines: r.live.slice(-60) };
}

// one render at a time on the whole server (small hosting plans have little CPU)
let renderChain = Promise.resolve();
function withRenderSlot(fn) {
  const next = renderChain.then(fn, fn);
  renderChain = next.catch(() => {});
  return next;
}

function start(pid) {
  pid = Number(pid);
  if (isRunning(pid)) return false;
  const r = new Runner(pid);
  r.running = true;
  RUNNERS.set(pid, r);
  store.updateProject(pid, { status: 'running' });
  loop(r).catch(() => {}).finally(() => { r.running = false; r.current = null; });
  return true;
}

function stop(pid) {
  const r = RUNNERS.get(Number(pid));
  if (r) { r.cancelled = true; if (r.job) r.job.cancel(); }
  const p = store.getProject(pid);
  if (p && p.status === 'running' && !isRunning(pid)) store.updateProject(pid, { status: 'stopped' });
}

function sendUserMessage(pid, text) {
  pid = Number(pid);
  const p = store.getProject(pid);
  store.addEvent(pid, 'user', text);
  if (isRunning(pid)) { RUNNERS.get(pid).inbox.push(text); return 'queued'; }
  if (p.status === 'awaiting_approval') return respondApproval(pid, false, text, true);
  store.addMessage(pid, { role: 'user', text });
  start(pid);
  return 'started';
}

function respondApproval(pid, approved, feedback = '', alreadyLogged = false) {
  pid = Number(pid);
  const p = store.getProject(pid);
  const pending = p && p.pending;
  if (!pending) return 'no pending approval';
  const content = approved
    ? `The user APPROVED this.${feedback ? ` Their note: ${feedback}` : ''} Continue.`
    : `The user requested CHANGES: ${feedback || '(no details)'}. Make them, then ask for approval again.`;
  if (!alreadyLogged) store.addEvent(pid, 'user', (approved ? 'Approved' : 'Changes requested') + (feedback ? `: ${feedback}` : ''));
  if (approved) store.updateProject(pid, { approved: [...(p.approved || []), { title: pending.title, at: new Date().toISOString() }].slice(-30) });
  store.addMessage(pid, { role: 'tool', tool_call_id: pending.tool_call_id, name: 'request_approval', content });
  store.updateProject(pid, { pending: null, status: 'idle' });
  start(pid);
  return 'resumed';
}

function kickoff(pid) {
  const p = store.getProject(pid);
  if (store.getMessages(p.id).length) return start(p.id);
  const earlier = progressReport(p);
  store.addMessage(p.id, { role: 'user', text: earlier
    ? `Make the film "${p.title}". Topic: ${p.topic || p.title}. ${p.brief || ''}\nWork from an earlier session is already in the workspace (see "Work already done"). Check it and continue from the first unfinished step; don't start over.`
    : `Make the film "${p.title}". Topic: ${p.topic || p.title}. ${p.brief || ''}\n` +
      'Start with the Story stage: research, fact-check, write script.md, beats.md and sources.md, then ask me to approve the beat table.' });
  store.addEvent(p.id, 'system', 'Agent started');
  return start(p.id);
}

function resetConversation(pid) {
  stop(pid);
  store.clearMessages(Number(pid));
  store.updateProject(pid, { pending: null, status: 'idle' });
  store.addEvent(pid, 'system', 'Agent memory cleared. Files in the workspace were kept.');
}

// ---------------------------------------------------------------- context preparation
function imagePayload(file) {
  // re-encode to a modest JPEG so images stay cheap for the model
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  return loadImage(fs.readFileSync(file)).then(async (img) => {
    const s = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = createCanvas(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return (await c.encode('jpeg', 82)).toString('base64');
  });
}

async function prepareMessages(p, msgs) {
  const out = [];
  const n = msgs.length;
  const imgIdx = msgs.map((m, i) => (m.role === 'tool' && m.image ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(imgIdx.slice(-KEEP_IMAGES));
  for (let i = 0; i < n; i++) {
    const m = { ...msgs[i] };
    if (m.role === 'tool') {
      if (i < n - KEEP_FULL_RECENT && (m.content || '').length > 1500) m.content = `${m.content.slice(0, 700)}\n…[older output shortened]…\n${m.content.slice(-500)}`;
      if (m.image) {
        if (keep.has(i)) {
          try { m.image_b64 = await imagePayload(safePath(p, m.image)); } catch (e) { m.content += ` (image could not be loaded: ${e.message})`; }
        } else m.content += ' (older image omitted)';
      }
    }
    out.push(m);
  }
  // every tool call needs a result right after its assistant message
  const have = new Set(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const fixed = [];
  for (const m of out) {
    fixed.push(m);
    if (m.role === 'assistant') for (const tc of m.tool_calls || []) if (!have.has(tc.id)) fixed.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: 'Interrupted: this call did not complete.' });
  }
  const final = [];
  const used = new Set();
  for (let i = 0; i < fixed.length; i++) {
    const m = fixed[i];
    if (used.has(i)) continue;
    final.push(m);
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const ids = new Set(m.tool_calls.map((t) => t.id));
      for (let j = i + 1; j < fixed.length; j++) if (!used.has(j) && fixed[j].role === 'tool' && ids.has(fixed[j].tool_call_id)) { final.push(fixed[j]); used.add(j); }
    } else if (m.role === 'tool' && !final.slice(0, -1).some((x) => x.role === 'assistant' && (x.tool_calls || []).some((t) => t.id === m.tool_call_id))) {
      final.pop(); // orphan tool result
    }
  }
  return final;
}

// ---------------------------------------------------------------- tool execution
// Research results are kept for 7 days in the film's .cache folder
async function cached(root, kind, key, fn) {
  const dir = path.join(root, '.cache');
  const f = path.join(dir, `${kind}-${require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (Date.now() - c.at < 7 * 864e5) return typeof c.v === 'string' ? `${c.v}\n(reused from an earlier identical ${kind})` : c.v; } catch (_) { /* not cached */ }
  const v = await fn();
  if (v && (typeof v !== 'string' || !/^(ERROR|No results)/i.test(v)) && (!Array.isArray(v) || v.length)) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), v })); } catch (_) {} }
  return v;
}
function readFilmJson(p) {
  const f = safePath(p, 'film.json');
  if (!fs.existsSync(f)) throw new Error('film.json does not exist yet. Write it first (narration + scenes).');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

async function render(r, p, cmd, opts, label) {
  r.log(`${label}: waiting for a free render slot…`);
  return withRenderSlot(async () => {
    if (r.cancelled) throw new Error('Stopped by user');
    r.log(`${label}: started`);
    let last = 0;
    r.job = runJob(cmd, projectRoot(p), opts, (done, total, what) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      r.current = `${label}: ${pct}% (${what})`;
      if (Date.now() - last > 2500) { last = Date.now(); r.log(`${label}: ${done}/${total} frames · ${what}`); }
    });
    try { return await r.job.promise; } finally { r.job = null; }
  });
}

function fmtResult(res) {
  if (!res.ok) return `ERRORS in film.json:\n- ${res.errors.join('\n- ')}${res.warnings && res.warnings.length ? `\nWarnings:\n- ${res.warnings.join('\n- ')}` : ''}`;
  const { ok, warnings, ...rest } = res;
  return JSON.stringify(rest, null, 1) + (warnings && warnings.length ? `\nWarnings:\n- ${warnings.join('\n- ')}` : '');
}

async function executeTool(r, p, name, a) {
  const root = projectRoot(p);
  switch (name) {
    case 'read_file': {
      const f = safePath(p, a.path);
      if (!fs.existsSync(f)) return { content: `File not found: ${a.path}` };
      if (fs.statSync(f).isDirectory()) return { content: 'That is a folder; use list_files.' };
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const off = Math.max(0, (a.offset || 1) - 1), lim = a.limit || 1000;
      const body = lines.slice(off, off + lim).map((l, i) => `${String(i + off + 1).padStart(5)}  ${l}`).join('\n');
      return { content: clip(body, 40000) + (lines.length > off + lim ? `\n… (${lines.length - off - lim} more lines, use offset)` : '') };
    }
    case 'write_file': {
      const f = safePath(p, a.path, true);
      if (a.path.endsWith('.json')) { try { JSON.parse(a.content); } catch (e) { return { content: `Not saved: invalid JSON (${e.message}). Fix it and write again.` }; } }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, a.content || '');
      return { content: `Wrote ${a.path} (${(a.content || '').length} chars)${a.path === 'film.json' ? '. Run check_film next.' : ''}` };
    }
    case 'edit_file': {
      const f = safePath(p, a.path, true);
      if (!fs.existsSync(f)) return { content: 'File not found.' };
      const text = fs.readFileSync(f, 'utf8');
      const cnt = a.old_text ? text.split(a.old_text).length - 1 : 0;
      if (cnt !== 1) return { content: `old_text found ${cnt} times; it must match exactly once.` };
      const next = text.replace(a.old_text, () => a.new_text);
      if (a.path.endsWith('.json')) { try { JSON.parse(next); } catch (e) { return { content: `Not saved: the edit would make invalid JSON (${e.message}).` }; } }
      fs.writeFileSync(f, next);
      return { content: 'Edited.' };
    }
    case 'list_files': {
      const base = safePath(p, a.path || '.');
      if (!fs.existsSync(base)) return { content: 'Folder not found.' };
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
          if (e.name.startsWith('.') || out.length > 400) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { out.push(path.relative(base, full) + '/'); walk(full); } else out.push(`${path.relative(base, full)}  (${fs.statSync(full).size} B)`);
        }
      };
      walk(base);
      return { content: out.join('\n') || '(empty)' };
    }
    case 'web_search': return { content: await cached(root, 'web_search', a.query || '', () => research.webSearch(a.query || '')) };
    case 'web_fetch': return { content: await cached(root, 'web_fetch', a.url || '', () => research.webFetch(a.url || '')) };
    case 'commons_search': {
      const res = await cached(root, 'commons_search', `${a.query || ''}|${a.limit || 12}`, () => research.commonsSearch(a.query || '', a.limit || 12));
      if (!res.length) return { content: 'No images found. Try simpler or different keywords (names, places, years).' };
      return { content: res.map((x, i) => `${i + 1}. ${x.title}  [${x.width}x${x.height}] ${x.free ? '' : '(NOT FREE - cannot use) '}licence: ${x.license || '?'}\n   by ${x.author || '?'}${x.date ? ', ' + x.date : ''}\n   ${x.description}`).join('\n') };
    }
    case 'commons_download': {
      const have = research.alreadyDownloaded(root, a.title);
      if (have && fs.existsSync(path.join(root, have))) return { content: `Already downloaded earlier: ${have} (reused, credits already in credits.md).` };
      const d = await research.commonsDownload(root, a.title, a.save_as);
      return { content: `Saved ${d.file} (${Math.round(d.bytes / 1024)} KB). Licence ${d.license}, by ${d.author}. Added to credits.md.` };
    }
    case 'tts_generate': {
      // The voice always comes from Settings: the model kept inventing values like "Bunty / aiawaaz", which the
      // provider rejects. So there is no voice argument any more.
      const film = readFilmJson(p);
      const lines = (film.narration || []).filter((l) => !a.ids || !a.ids.length || a.ids.includes(l.id));
      if (!lines.length) return { content: 'No matching narration lines in film.json.' };
      const t = tts.settings();
      const voiceKey = `${t.provider}:${t[`${t.provider}_voice`] || ''}`;
      const metaFile = path.join(projectRoot(p), 'audio', '.tts.json'); // app-owned, not written by the model
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
      const sig = (l) => require('crypto').createHash('sha1').update(`${voiceKey}\n${l.text}`).digest('hex').slice(0, 16);
      const out = [];
      for (const l of lines) {
        if (r.cancelled) break;
        const rel = l.audio || `audio/${l.id}.mp3`;
        const f = safePath(p, rel, true);
        // Reuse the audio unless the line's text or the voice changed since it was made (or force without a record)
        const same = meta[l.id] ? meta[l.id] === sig(l) : !a.force;
        if (fs.existsSync(f) && same) {
          out.push(`${l.id}: kept (${(await ff.duration(f)).toFixed(2)} s, unchanged)`); continue;
        }
        r.current = `voice ${l.id}`;
        let res;
        try { res = await tts.synthesize(l.text, f, null); } catch (e) { res = { ok: false, note: e.message }; }
        if (!res.ok) {
          const err = String(res.note || 'unknown error');
          store.addEvent(p.id, 'error', `Voice for ${l.id} failed: ${err.slice(0, 400)}`);
          const kind = /voice reference|voice.*(invalid|not found)|unknown voice/i.test(err) ? 'the voice chosen in Settings is not accepted'
            : /credit|quota|balance|insufficient|limit|402|payment/i.test(err) ? 'the voice account is out of credit or hit a limit'
            : /401|403|api key|unauthori|forbidden/i.test(err) ? 'the voice API key is missing or wrong'
            : 'the voice service returned an error';
          return { content: `${out.length ? `Done before the failure:\n${out.join('\n')}\n\n` : ''}Voice generation failed on ${l.id}: ${err}\n\n` +
            `Most likely: ${kind}. Tell the user this exact error in English (quote it) and what it likely means. ` +
            `Do not ask them to re-select or re-test the voice unless the error is about the voice itself, and do not retry more than once. ` +
            `You can keep working on scenes with estimated timing meanwhile.` };
        }
        meta[l.id] = sig(l);
        try { fs.mkdirSync(path.dirname(metaFile), { recursive: true }); fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1)); } catch (_) {}
        out.push(`${l.id}: ${res.seconds} s`);
        r.log(`voice ${l.id}: ${res.seconds} s`);
      }
      return { content: out.join('\n') };
    }
    case 'audio_silences': {
      const f = safePath(p, a.path);
      const err = await ff.run(['-i', f, '-af', `silencedetect=noise=-35dB:d=${a.min_silence || 0.45}`, '-f', 'null', '-']);
      const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
      const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
      const total = await ff.duration(f);
      const mids = starts.map((s, i) => (ends[i] ? +((s + ends[i]) / 2).toFixed(2) : null)).filter((x) => x && x > 0.3 && x < total - 0.3);
      return { content: `Length ${total.toFixed(2)} s. Pauses (good cut points, seconds): ${JSON.stringify(mids)}` };
    }
    case 'split_audio': {
      const f = safePath(p, a.path);
      const total = await ff.duration(f);
      const cuts = [0, ...(a.cuts || []), total];
      if (cuts.length - 1 !== (a.ids || []).length) return { content: `Need ${cuts.length - 1} ids for ${a.cuts.length} cuts.` };
      const out = [];
      for (let i = 0; i < a.ids.length; i++) {
        const dest = safePath(p, `audio/${a.ids[i]}.mp3`, true);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await ff.run(['-ss', String(cuts[i]), '-to', String(cuts[i + 1]), '-i', f, '-af', 'silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse', '-c:a', 'libmp3lame', '-q:a', '3', dest]);
        out.push(`${a.ids[i]}: ${(await ff.duration(dest)).toFixed(2)} s`);
      }
      return { content: out.join('\n') };
    }
    case 'check_film': return { content: fmtResult(await render(r, p, 'inspect', {}, 'check')) };
    case 'render_stills': return { content: fmtResult(await render(r, p, 'stills', { times: a.times || [] }, 'stills')) + '\nLook at them with view_image.' };
    case 'render_contact_sheet': return { content: fmtResult(await render(r, p, 'contact', { count: Math.min(24, Math.max(4, a.count || 12)) }, 'contact sheet')) + '\nLook at it with view_image.' };
    case 'render_draft': return { content: fmtResult(await render(r, p, 'film', { quality: 'draft', from: a.from || 0, to: a.to }, 'draft')) };
    case 'render_final': return { content: fmtResult(await render(r, p, 'film', { quality: 'final' }, 'final render')) };
    case 'make_thumbnails': {
      const res = await youtube.designThumbnails(p, projectRoot(p), (a.variants || []).slice(0, 4));
      return { content: `Rendered ${res.files.join(', ')}. ${res.files[0]} is set as the upload thumbnail. Look at them with view_image and fix any that don't read well at small size.` };
    }
    case 'view_image': {
      const f = safePath(p, a.path);
      if (!fs.existsSync(f)) return { content: 'Image not found.' };
      const rel = path.relative(root, f);
      store.addEvent(p.id, 'image', rel);
      return { content: `Image ${rel} attached.`, image: rel };
    }
    case 'set_stage': {
      if (STAGES.includes(a.stage)) { store.updateProject(p.id, { stage: a.stage }); store.addEvent(p.id, 'stage', a.stage, { note: a.note }); }
      return { content: `Stage set to ${a.stage}.` };
    }
    default: return { content: `Unknown tool ${name}` };
  }
}

function describeCall(name, a) {
  if (['read_file', 'write_file', 'edit_file', 'list_files', 'view_image', 'audio_silences', 'split_audio'].includes(name)) return a.path || '.';
  if (name === 'web_search' || name === 'commons_search') return a.query || '';
  if (name === 'web_fetch') return a.url || '';
  if (name === 'commons_download') return a.title || '';
  if (name === 'tts_generate') return a.ids && a.ids.length ? a.ids.join(', ') : 'all lines';
  if (name === 'render_stills') return (a.times || []).join(', ');
  if (name === 'render_draft') return `${a.from || 0}–${a.to || (a.from || 0) + 30} s`;
  return JSON.stringify(a).slice(0, 200);
}

// Does this tool-less reply wait for the user (a question / request), or is it just narrating the next step?
function needsUser(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const tail = t.slice(-400);
  if (/\?/.test(tail)) return true;
  if (/\b(reply|let me know|tell me|please (send|upload|provide|choose|pick|confirm|add|check|share|set)|do you want|would you like|should i|which (one|option)|waiting for (you|your)|your (answer|choice|decision|input)|need(s)? (you|your)|option [a-c1-3]\b)/i.test(tail)) return true;
  if (/\b(finished|is done|complete[d]?\b.*film|uploaded)\b/i.test(tail) && !/\b(next|now i'?ll|i will|i'?ll)\b/i.test(tail)) return true;
  return false;
}

// ---------------------------------------------------------------- main loop
async function loop(r) {
  const pid = r.pid;
  try {
    let p = store.getProject(pid);
    fs.mkdirSync(path.join(projectRoot(p), 'uploads'), { recursive: true });
    let lastUsed = null;
    for (let step = 0; step < config.AGENT_MAX_STEPS; step++) {
      if (r.cancelled) { store.updateProject(pid, { status: 'stopped' }); store.addEvent(pid, 'system', 'Stopped'); return; }
      while (r.inbox.length) store.addMessage(pid, { role: 'user', text: r.inbox.shift() });
      p = store.getProject(pid);
      const stepStart = Date.now(), stepStage = p.stage; // for the time estimate: agent working time per stage
      const countStep = () => eta.addWork(pid, stepStage, (Date.now() - stepStart) / 1000);
      const msgs = await prepareMessages(p, store.getMessages(pid));
      const system = systemPrompt(p);
      // read the priority list every step, so changes in Settings apply to a film that is already running
      if (store.reloadSettings) { try { await store.reloadSettings(); } catch (_) { /* keep current */ } }
      const providers = llm.chain(p.provider || null, p.model || null);
      if (!providers.length) throw new llm.LLMError('No AI provider set. Add a key and set the priority in Settings → AI models.');
      r.current = 'thinking';
      const res = await llm.chatChain(providers, system, msgs, TOOLS, 8192, (from, to, err) =>
        store.addEvent(pid, 'system', `⚠️ ${llm.PROVIDERS[from]?.label || from} failed (${err}). Switching to ${llm.PROVIDERS[to]?.label || to}.`));
      r.current = null;
      if (lastUsed && res.provider !== lastUsed) store.addEvent(pid, 'system', `🤖 Now using ${llm.PROVIDERS[res.provider]?.label || res.provider} · ${res.model}`);
      lastUsed = res.provider;
      try { llm.recordUsage(res, pid); } catch (_) {}
      store.addMessage(pid, { role: 'assistant', text: res.text, tool_calls: res.tool_calls });
      if (res.text) store.addEvent(pid, 'assistant', res.text, { usage: res.usage });
      if (!res.tool_calls || !res.tool_calls.length) {
        countStep();
        if (r.inbox.length) continue;
        // The model sometimes says what it will do next and then stops. Unless it is asking the user something, keep it going.
        if (needsUser(res.text) === false && (r.nudges || 0) < 2 && store.getProject(pid).stage !== 'done') {
          r.nudges = (r.nudges || 0) + 1;
          store.addMessage(pid, { role: 'user', text: '(automatic) Go ahead: do that now by calling the tools. Stop without a tool call only if you need an answer from me, and then ask a clear question.' });
          continue;
        }
        r.nudges = 0;
        store.updateProject(pid, { status: 'idle' });
        store.addEvent(pid, 'waiting', res.text || 'The agent paused.');
        return;
      }
      r.nudges = 0;
      let paused = false, finished = false;
      for (const tc of res.tool_calls) {
        const name = tc.name, a = tc.args || {};
        if (paused || finished) {
          store.addMessage(pid, { role: 'tool', tool_call_id: tc.id, name, content: 'Not run: waiting for the user. Call it again later if needed.' });
          continue;
        }
        if (name === 'request_approval') {
          const pending = { tool_call_id: tc.id, title: a.title || 'Approval needed', summary: a.summary || '', files: a.files || [] };
          store.updateProject(pid, { pending, status: 'awaiting_approval' });
          store.addEvent(pid, 'approval', pending.title, pending);
          paused = true;
          continue;
        }
        if (name === 'finish') {
          store.updateProject(pid, { final_video: a.video, final_srt: a.srt || null, stage: 'done', status: 'done' });
          store.addEvent(pid, 'done', a.summary || 'Film finished', a);
          store.addMessage(pid, { role: 'tool', tool_call_id: tc.id, name, content: 'Recorded. The user will review the final film.' });
          if (p.idea_id) { const idea = store.getIdea(p.idea_id); if (idea && ['idea', 'research', 'production'].includes(idea.status)) store.updateIdea(idea.id, { status: 'scheduled' }); }
          countStep(); try { eta.learn(store.getProject(pid)); } catch (_) {}
          finished = true;
          continue;
        }
        store.addEvent(pid, 'tool', describeCall(name, a), { name });
        r.current = `${name}: ${describeCall(name, a).slice(0, 120)}`;
        let out;
        try { out = await executeTool(r, p, name, a); } catch (e) { out = { content: `ERROR: ${e.message}` }; }
        r.current = null;
        const msg = { role: 'tool', tool_call_id: tc.id, name, content: clip(out.content) };
        if (out.image) msg.image = out.image;
        store.addMessage(pid, msg);
        store.addEvent(pid, 'tool_result', clip(out.content, 4000), { name });
      }
      if (!finished) countStep();
      if (paused || finished) return;
    }
    store.updateProject(pid, { status: 'idle' });
    store.addEvent(pid, 'system', `Paused after ${config.AGENT_MAX_STEPS} steps. Press Resume or send "continue".`);
  } catch (e) {
    store.updateProject(pid, { status: 'error' });
    store.addEvent(pid, 'error', e instanceof llm.LLMError ? e.message : `${e.name}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 6).join('\n')}`);
  }
}

// Render without the agent (from the web app's Preview tab or Telegram).
function manualRender(pid, quality = 'final') {
  pid = Number(pid);
  if (isRunning(pid)) throw new Error('The agent is working on this film. Stop it first or let it finish.');
  const p = store.getProject(pid);
  const r = new Runner(pid);
  r.running = true;
  RUNNERS.set(pid, r);
  const label = quality === 'draft' ? 'draft render' : 'final render';
  store.addEvent(pid, 'system', `Started ${label}`);
  render(r, p, 'film', { quality }, label).then((res) => {
    if (!res.ok) { store.addEvent(pid, 'error', `Render failed:\n- ${res.errors.join('\n- ')}`); return; }
    if (quality !== 'draft') store.updateProject(pid, { final_video: res.video, final_srt: res.srt });
    store.addEvent(pid, 'system', `Rendered ${res.video} (${res.seconds} s, took ${res.renderSeconds} s)${(res.warnings || []).length ? '\nWarnings: ' + res.warnings.join(' / ') : ''}`);
  }).catch((e) => store.addEvent(pid, 'error', `Render failed: ${e.message}`)).finally(() => { r.running = false; r.current = null; });
  return true;
}

module.exports = {
  needsUser, progressReport,
  filmLanguage,
  manualRender,
  STAGES, TOOLS, projectRoot, safePath, isRunning, liveOutput, start, stop, sendUserMessage, respondApproval,
  kickoff, resetConversation, systemPrompt, prepareMessages, RUNNERS, executeTool,
};
