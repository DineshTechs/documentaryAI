'use strict';
// Narration voice. Cloud TTS only (no system packages needed): OpenAI TTS or ElevenLabs.
// "none" writes no audio: the renderer then estimates timing and the film is silent (captions still work).
const fs = require('fs');
const path = require('path');
const store = require('./store');
const ff = require('./renderer/ffmpeg');

const TTS_PROVIDERS = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  none: 'None (silent drafts, timing estimated from the text)',
};

const settings = () => store.getSetting('tts', {}) || {};

async function synthesize(text, outPath, voice = null, provider = null) {
  const s = settings();
  provider = provider || s.provider || 'none';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (provider === 'none') return { ok: false, note: 'No TTS provider set (Settings > Narration voice). Timing will be estimated and the line will be silent.' };
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

module.exports = { TTS_PROVIDERS, synthesize, settings };
