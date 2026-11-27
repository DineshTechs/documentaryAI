'use strict';
// Narration voice. Cloud TTS only (no system packages needed): OpenAI TTS, ElevenLabs, or AI Awaaz (via its MCP endpoint).
// "none" writes no audio: the renderer then estimates timing and the film is silent (captions still work).
const fs = require('fs');
const path = require('path');
const store = require('./store');
const ff = require('./renderer/ffmpeg');

const TTS_PROVIDERS = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  aiawaaz: 'AI Awaaz (aiawaaz.io, Indian voices, Hindi + 20 languages)',
  manual: 'Upload: any other voice app or your own recording (you upload the MP3)',
  none: 'None (silent drafts, timing estimated from the text)',
};
const UPLOAD_PROVIDERS = new Set(['manual']);
const AIAWAAZ_URL = 'https://app.aiawaaz.io/api/mcp';

const settings = () => store.getSetting('tts', {}) || {};

// ---------------------------------------------------------------- AI Awaaz (MCP)
const { McpClient, resultText } = require('./mcp');
let awaaz = null;
function awaazClient() {
  const s = settings();
  const key = String(s.aiawaaz_key || '').trim();
  if (!key) throw new Error('AI Awaaz needs an API key (Settings > Narration voice). Get it from app.aiawaaz.io (Connect your AI tool).');
  const url = s.aiawaaz_url || AIAWAAZ_URL;
  if (!awaaz || awaaz.key !== key || awaaz.url !== url) {
    awaaz = new McpClient(url, { authorization: `Bearer ${key.replace(/^Bearer\s+/i, '')}` });
    awaaz.key = key;
  }
  return awaaz;
}

// Pick the argument names from the tool's own schema, so we don't depend on guessed field names.
function argNames(tool) {
  const props = ((tool && tool.inputSchema) || {}).properties || {};
  const keys = Object.keys(props);
  const find = (...cands) => cands.map((c) => keys.find((k) => k.toLowerCase() === c)).find(Boolean)
    || cands.map((c) => keys.find((k) => k.toLowerCase().includes(c))).find(Boolean);
  return { text: find('text', 'script', 'input', 'content', 'prompt') || 'text', voice: find('voice_id', 'voiceid', 'voice', 'speaker') || 'voice_id', keys };
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
function audioUrl(res) {
  const sc = res && res.structuredContent;
  if (sc) for (const k of ['url', 'audio_url', 'audioUrl', 'link', 'mp3', 'download_url', 'file']) if (typeof sc[k] === 'string' && /^https?:/.test(sc[k])) return sc[k];
  const urls = resultText(res).match(URL_RE) || [];
  return urls.find((u) => /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(u)) || urls.find((u) => /audio|speech|voice|download|storage|cdn/i.test(u)) || urls[0] || null;
}

function extraOptions() {
  const raw = String(settings().aiawaaz_options || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw new Error('AI Awaaz "extra options" must be JSON, e.g. {"speed": 1.0}'); }
}

async function aiawaazSpeech(text, voice) {
  const s = settings();
  const c = awaazClient();
  const tools = await c.tools();
  const gen = tools.find((t) => t.name === 'generate_speech');
  if (!gen) throw new Error(`AI Awaaz has no generate_speech tool (found: ${tools.map((t) => t.name).join(', ')}).`);
  if (s.aiawaaz_enhance) {
    const enh = tools.find((t) => t.name === 'enhance_for_v3');
    if (enh) {
      const a = argNames(enh);
      const out = resultText(await c.call('enhance_for_v3', { [a.text]: text })).trim();
      if (out && out.length < text.length * 4) text = out.replace(/^```\w*\n?|```$/g, '').trim();
    }
  }
  const a = argNames(gen);
  const args = { [a.text]: text, ...extraOptions() };
  const v = String(voice || s.aiawaaz_voice || '').trim();
  if (v && !(a.voice in args)) args[a.voice] = await awaazVoiceArg(gen, a.voice, v);
  let res;
  try { res = await c.call('generate_speech', args); }
  catch (e) {
    if (!/voice/i.test(e.message)) throw e;
    const prop = ((gen.inputSchema || {}).properties || {})[a.voice] || {};
    throw new Error(`${e.message}\nVoice sent as "${a.voice}": ${JSON.stringify(args[a.voice])}\nAI Awaaz expects: ${JSON.stringify(prop).slice(0, 600)}`);
  }
  const url = audioUrl(res);
  if (!url) throw new Error(`AI Awaaz did not return an audio link: ${resultText(res).slice(0, 300)}`);
  let r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (r.status === 401 || r.status === 403) r = await fetch(url, { headers: { authorization: c.headers.authorization }, signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`Could not download the AI Awaaz audio (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

// Build the voice argument the way generate_speech's own schema describes it.
async function awaazVoiceArg(tool, key, v) {
  const prop = ((tool.inputSchema || {}).properties || {})[key] || {};
  const type = Array.isArray(prop.type) ? prop.type : [prop.type];
  // the saved value may be a name: swap it for the reference/id from the voice list
  let found = null;
  try {
    const list = await listVoices('aiawaaz');
    found = list.find((x) => x.id === v) || list.find((x) => x.name.toLowerCase() === v.toLowerCase())
      || list.find((x) => x.raw && Object.values(x.raw).some((y) => String(y) === v));
  } catch (_) {}
  if (type.includes('object')) {
    if (found && found.raw) {
      const keys = Object.keys(prop.properties || {});
      return keys.length ? Object.fromEntries(keys.filter((k) => found.raw[k] != null).map((k) => [k, found.raw[k]])) : found.raw;
    }
    try { return JSON.parse(v); } catch (_) { return { id: v }; }
  }
  if (Array.isArray(prop.enum) && prop.enum.length) {
    return prop.enum.find((e) => e === v) || (found && prop.enum.find((e) => e === found.id || (found.raw && Object.values(found.raw).includes(e))))
      || prop.enum.find((e) => String(e).toLowerCase().includes(v.toLowerCase())) || v;
  }
  if (REF_RE.test(v)) return v; // already a reference
  if (found) {
    if (REF_RE.test(found.id)) return found.id;
    const r = found.raw && Object.values(found.raw).find((x) => typeof x === 'string' && REF_RE.test(x));
    if (r) return r;
    return found.id;
  }
  return v;
}

async function aiawaazInfo(what) {
  const c = awaazClient();
  if (what === 'voices') {
    const tool = (await c.tools()).find((t) => t.name === 'list_voices');
    const args = {};
    const props = ((tool && tool.inputSchema) || {}).properties || {};
    if (props.limit) args.limit = 100;
    const gen = (await c.tools()).find((t) => t.name === 'generate_speech');
    return `generate_speech parameters:\n${JSON.stringify((gen && gen.inputSchema) || {}, null, 2)}\n\nlist_voices:\n${resultText(await c.call('list_voices', args))}`;
  }
  return resultText(await c.call('get_account', {}));
}

// ---------------------------------------------------------------- voice lists (for the Settings dropdown)
const OPENAI_VOICES = [
  ['onyx', 'Onyx', 'male · deep, authoritative'], ['ash', 'Ash', 'male · clear, warm'], ['echo', 'Echo', 'male · calm'],
  ['ballad', 'Ballad', 'male · soft, expressive'], ['verse', 'Verse', 'male · versatile'], ['fable', 'Fable', 'neutral · storyteller'],
  ['sage', 'Sage', 'female · calm, wise'], ['coral', 'Coral', 'female · bright'], ['nova', 'Nova', 'female · energetic'],
  ['shimmer', 'Shimmer', 'female · gentle'], ['alloy', 'Alloy', 'neutral · balanced'], ['marin', 'Marin', 'female · natural (gpt-4o-mini-tts)'],
  ['cedar', 'Cedar', 'male · natural (gpt-4o-mini-tts)'],
].map(([id, name, info]) => ({ id, name, info }));

const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const flat = (v) => (Array.isArray(v) ? v.join('/') : v && typeof v === 'object' ? Object.values(v).filter((x) => typeof x === 'string').join(' · ') : v);

// AI Awaaz voice references look like "platform:5316" or "mine:42"
const REF_RE = /^[a-z][a-z_-]*:[\w.-]+$/i;
// Turn one voice object (any reasonable field names) into {id, name, info, preview}.
function normVoice(o) {
  if (typeof o === 'string') return { id: o, name: o, info: '' };
  if (!o || typeof o !== 'object') return null;
  const ref = Object.entries(o).find(([k, v]) => /^(voice|voice_ref|ref|reference)$/i.test(k) && typeof v === 'string' && REF_RE.test(v));
  const id = ref ? ref[1] : pick(o, ['voice_ref', 'voiceRef', 'voice_reference', 'voiceReference', 'reference', 'ref', 'voice_id', 'voiceId', 'id', 'slug', 'key', 'code', 'name']);
  if (id == null) return null;
  const name = pick(o, ['name', 'display_name', 'displayName', 'title', 'label']) || id;
  const bits = [];
  for (const k of ['gender', 'language', 'languages', 'lang', 'accent', 'age', 'style', 'tone', 'category', 'use_case', 'model', 'version', 'tier']) {
    const v = flat(o[k]); if (v && typeof v !== 'object' && !bits.includes(String(v))) bits.push(String(v));
  }
  if (o.labels && typeof o.labels === 'object') for (const v of Object.values(o.labels)) if (typeof v === 'string' && !bits.includes(v)) bits.push(v);
  const desc = pick(o, ['description', 'desc', 'about']);
  const preview = pick(o, ['preview_url', 'previewUrl', 'sample_url', 'sampleUrl', 'sample', 'preview', 'audio_url', 'demo_url']);
  return { id: String(id), name: String(name), info: [bits.join(' · '), typeof desc === 'string' ? desc.slice(0, 90) : ''].filter(Boolean).join(' — '),
    preview: typeof preview === 'string' && /^https?:/.test(preview) ? preview : null, raw: o };
}

// Find the biggest array of voice-like things inside parsed JSON.
function voicesFromJson(j) {
  let best = [];
  const walk = (v, depth) => {
    if (depth > 4 || !v) return;
    if (Array.isArray(v)) {
      const list = v.map(normVoice).filter(Boolean);
      if (list.length > best.length) best = list;
      v.forEach((x) => x && typeof x === 'object' && walk(x, depth + 1));
    } else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(j, 0);
  return best;
}

// Plain-text lists, e.g. "- Bunty (id: bunty_v3) - male, Hindi" or "1. Name | ID: abc | female".
function voicesFromTable(text) {
  // markdown table: | Name | Voice | Gender | ...
  const rows = String(text).split(/\r?\n/).filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/[`*]/g, '').trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ci = col(/^(voice|voice[_ ]?ref|reference|ref)$/), ni = col(/name|title/), ii = col(/^(voice[_ ]?id|id)$/);
  return rows.slice(1).map((r) => {
    const refCell = r.find((c) => REF_RE.test(c));
    const id = (ci >= 0 && r[ci]) || refCell || (ii >= 0 && r[ii]) || (ni >= 0 && r[ni]);
    if (!id) return null;
    const name = (ni >= 0 && r[ni]) || id;
    const info = r.filter((c, k) => k !== ci && k !== ni && k !== ii && c && c !== id).join(' · ').slice(0, 90);
    return { id, name, info, preview: null, raw: Object.fromEntries(head.map((h, k) => [h, r[k]])) };
  }).filter(Boolean);
}

function voicesFromText(text) {
  const table = voicesFromTable(text);
  if (table.length) return table;
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim();
    if (!line || line.length > 300) continue;
    const refm = line.match(/`?\b((?:platform|mine|shared|custom|library|cloned?)[:][\w.-]+)`?/i);
    const idm = refm ? [refm[0], refm[1]] : line.match(/\b(?:voice[_ ]?id|id)\b\s*[:=]\s*`?([\w.\-]+)`?/i);
    const nm = line.match(/\bname\b\s*[:=]\s*([^,|;\n()]+)/i);
    if (!idm && !nm) continue;
    const id = idm ? idm[1] : nm[1].trim();
    let name = nm ? nm[1].trim() : line.split(/\s*[(|,—–]\s*|\s+-\s+/)[0].replace(/\b(?:voice[_ ]?id|id)\b\s*[:=].*/i, '').trim();
    if (!name) name = id;
    const info = line.replace(idm ? idm[0] : '', '').replace(nm ? nm[0] : '', '').replace(name, '').replace(/[()|,:;—–\-\s]+/g, ' ').trim().slice(0, 90);
    if (!out.some((v) => v.id === id)) out.push({ id, name, info, preview: null });
  }
  return out;
}

function parseVoiceList(res) {
  let list = [];
  if (res && res.structuredContent) list = voicesFromJson(res.structuredContent);
  for (const c of (!list.length && res && res.content) || []) {
    if (c.type !== 'text' || !c.text) continue;
    const t = c.text.trim().replace(/^```\w*\n?|```$/g, '');
    try { const l = voicesFromJson(JSON.parse(t)); if (l.length > list.length) list = l; } catch (_) {}
  }
  if (!list.length) list = voicesFromText(resultText(res));
  return list;
}

const voiceCache = new Map();
async function listVoices(provider, fresh = false) {
  const s = settings();
  const key = provider === 'aiawaaz' ? s.aiawaaz_key : provider === 'elevenlabs' ? s.elevenlabs_key : '';
  const ck = `${provider}:${key || ''}`;
  const hit = voiceCache.get(ck);
  if (!fresh && hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  let voices;
  if (provider === 'openai') voices = OPENAI_VOICES;
  else if (provider === 'elevenlabs') {
    if (!key) throw new Error('Add your ElevenLabs API key first, then load the voices.');
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`ElevenLabs voices: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    voices = ((await r.json()).voices || []).map(normVoice).filter(Boolean);
  } else if (provider === 'aiawaaz') {
    const c = awaazClient();
    const tool = (await c.tools()).find((t) => t.name === 'list_voices');
    if (!tool) throw new Error('AI Awaaz has no list_voices tool.');
    const props = (tool.inputSchema || {}).properties || {};
    const args = {};
    if (props.limit) args.limit = 100;
    if (props.page_size) args.page_size = 100;
    const res = await c.call('list_voices', args);
    voices = parseVoiceList(res);
    if (!voices.length) throw new Error(`Could not read the voice list. AI Awaaz said: ${resultText(res).slice(0, 300)}`);
  } else throw new Error(`${provider} has no voice list.`);
  voices.sort((a, b) => a.name.localeCompare(b.name));
  voiceCache.set(ck, { t: Date.now(), v: voices });
  return voices;
}

async function synthesize(text, outPath, voice = null, provider = null) {
  const s = settings();
  provider = provider || s.provider || 'none';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (provider === 'none') return { ok: false, note: 'No TTS provider set (Settings > Narration voice). Timing will be estimated and the line will be silent.' };
  if (UPLOAD_PROVIDERS.has(provider)) return { ok: false, upload: true, note: uploadNote(provider) };
  let buf;
  if (provider === 'openai') {
    const key = s.openai_key || ((store.getSetting('providers', {}) || {}).openai || {}).api_key;
    if (!key) throw new Error('OpenAI TTS needs an OpenAI API key (Settings > Narration voice).');
    const body = { model: s.openai_model || 'gpt-4o-mini-tts', voice: voice || s.openai_voice || 'onyx', input: text, response_format: 'mp3' };
    if (s.openai_instructions) body.instructions = s.openai_instructions;
    const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`OpenAI TTS error ${r.status}: ${(await r.text()).slice(0, 400)}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (provider === 'elevenlabs') {
    const key = s.elevenlabs_key, vid = voice || s.elevenlabs_voice;
    if (!key || !vid) throw new Error('ElevenLabs needs an API key and a voice ID (Settings > Narration voice).');
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: s.elevenlabs_model || 'eleven_multilingual_v2' }), signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`ElevenLabs error ${r.status}: ${(await r.text()).slice(0, 400)}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (provider === 'aiawaaz') {
    buf = await aiawaazSpeech(text, voice);
  } else throw new Error(`Unknown TTS provider ${provider}`);
  if (path.extname(outPath).toLowerCase() === '.mp3') fs.writeFileSync(outPath, buf);
  else {
    const tmp = outPath + '.tmp.mp3';
    fs.writeFileSync(tmp, buf);
    await ff.run(['-i', tmp, outPath]);
    fs.unlinkSync(tmp);
  }
  return { ok: true, seconds: +(await ff.duration(outPath)).toFixed(2) };
}

function uploadNote(provider) {
  const app = 'their voice app (or record it themselves)';
  return `The narration voice is made outside the app with ${app}. Do this instead of tts_generate:\n` +
    '1. Write voiceover_script.txt: every narration line from film.json, in order, one per paragraph, separated by a blank line, with no ids or notes.\n' +
    `2. Call request_approval titled "Record the voice-over" asking the user to paste voiceover_script.txt into ${app}, choose a voice, export ONE MP3 of the whole script, and upload it on the Files tab (or send it to the Telegram bot). Show voiceover_script.txt.\n` +
    '3. When they approve, find the MP3 in uploads/, run audio_silences on it, choose the pauses between lines (one fewer cut than lines), and split_audio into audio/<id>.mp3. Then run check_film and confirm the line lengths look right.';
}

module.exports = { TTS_PROVIDERS, UPLOAD_PROVIDERS, synthesize, settings, uploadNote, aiawaazInfo, listVoices, parseVoiceList, OPENAI_VOICES, argNames, audioUrl, AIAWAAZ_URL };
