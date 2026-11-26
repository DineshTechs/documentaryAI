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
  const v = voice || s.aiawaaz_voice;
  if (v) args[a.voice] = v;
  const res = await c.call('generate_speech', args);
  const url = audioUrl(res);
  if (!url) throw new Error(`AI Awaaz did not return an audio link: ${resultText(res).slice(0, 300)}`);
  let r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (r.status === 401 || r.status === 403) r = await fetch(url, { headers: { authorization: c.headers.authorization }, signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`Could not download the AI Awaaz audio (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

async function aiawaazInfo(what) {
  const c = awaazClient();
  if (what === 'voices') {
    const tool = (await c.tools()).find((t) => t.name === 'list_voices');
    const args = {};
    const props = ((tool && tool.inputSchema) || {}).properties || {};
    if (props.limit) args.limit = 100;
    return resultText(await c.call('list_voices', args));
  }
  return resultText(await c.call('get_account', {}));
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

module.exports = { TTS_PROVIDERS, UPLOAD_PROVIDERS, synthesize, settings, uploadNote, aiawaazInfo, argNames, audioUrl, AIAWAAZ_URL };
