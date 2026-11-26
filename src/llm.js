'use strict';
// Multi-provider LLM client with tool calling and images.
// Internal message format:
//   {role:'user', text}
//   {role:'assistant', text, tool_calls:[{id, name, args}]}
//   {role:'tool', tool_call_id, name, content, image_b64?}
const store = require('./store');

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base_url: 'https://api.anthropic.com/v1', kind: 'anthropic', model_hint: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', kind: 'openai', model_hint: 'your OpenAI model id' },
  gemini: { label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', model_hint: 'your Gemini model id' },
  openrouter: { label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', kind: 'openai', model_hint: 'e.g. anthropic/claude-sonnet-5-5' },
  deepseek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', kind: 'openai', model_hint: 'e.g. deepseek-chat' },
  groq: { label: 'Groq', base_url: 'https://api.groq.com/openai/v1', kind: 'openai', model_hint: 'your Groq model id' },
  mistral: { label: 'Mistral', base_url: 'https://api.mistral.ai/v1', kind: 'openai', model_hint: 'e.g. mistral-large-latest' },
  xai: { label: 'xAI (Grok)', base_url: 'https://api.x.ai/v1', kind: 'openai', model_hint: 'your Grok model id' },
  custom: { label: 'Custom / Ollama (OpenAI-compatible)', base_url: 'http://localhost:11434/v1', kind: 'openai', model_hint: 'e.g. llama3.1:70b' },
};

class LLMError extends Error {}

function providerConfig(name) {
  if (!PROVIDERS[name]) throw new LLMError(`Unknown AI provider "${name}"`);
  const saved = (store.getSetting('providers', {}) || {})[name] || {};
  return { ...PROVIDERS[name], api_key: saved.api_key || '', base_url: (saved.base_url || PROVIDERS[name].base_url).replace(/\/$/, ''), model: saved.model || '' };
}

function defaultProviderModel() {
  const d = store.getSetting('default_llm', {}) || {};
  return [d.provider || null, d.model || null];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, headers, body, retries = 4) {
  let last = '';
  for (let attempt = 0; attempt < retries; attempt++) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    } catch (e) {
      last = e.message; await sleep(2 ** attempt * 1000); continue;
    }
    const text = await r.text();
    if ([429, 500, 502, 503, 504, 529].includes(r.status)) { last = `HTTP ${r.status}: ${text.slice(0, 400)}`; await sleep(Math.min(30000, 3000 * 2 ** attempt)); continue; }
    if (r.status >= 400) throw new LLMError(`HTTP ${r.status}: ${text.slice(0, 1500)}`);
    try { return JSON.parse(text); } catch (_) { throw new LLMError(`Bad JSON from provider: ${text.slice(0, 300)}`); }
  }
  throw new LLMError(`Request failed after retries: ${last}`);
}

// ---------------------------------------------------------------- Anthropic
function toAnthropic(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text || '(continue)' }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no output)' }]);
    } else if (m.role === 'tool') {
      let content = m.content || '(empty)';
      if (m.image_b64) content = [{ type: 'text', text: content }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.image_b64 } }];
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }]);
    }
  }
  for (const msg of out) if (msg.role === 'user') msg.content.sort((a, b) => (a.type === 'tool_result' ? 0 : 1) - (b.type === 'tool_result' ? 0 : 1));
  return out;
}

async function chatAnthropic(cfg, model, system, messages, tools, maxTokens) {
  // the long system prompt (film guide) is cached by Anthropic, so repeated agent steps cost much less
  const sys = system && system.length > 4000 ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
  const body = { model, max_tokens: maxTokens, system: sys, messages: toAnthropic(messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const data = await post(`${cfg.base_url}/messages`, { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body);
  const text = [], calls = [];
  for (const b of data.content || []) {
    if (b.type === 'text') text.push(b.text);
    else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: b.input || {} });
  }
  const u = data.usage || {};
  return { text: text.join('\n').trim(), tool_calls: calls, usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
}

// ---------------------------------------------------------------- OpenAI-compatible
function toOpenAI(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  const imgs = [];
  const flush = () => {
    if (!imgs.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by view_image:' },
      ...imgs.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } }))] });
    imgs.length = 0;
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '(continue)' });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.tool_calls && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '(empty)' });
      if (m.image_b64) imgs.push(m.image_b64);
    }
  }
  flush();
  return out;
}

async function chatOpenAI(cfg, model, system, messages, tools, maxTokens, provider) {
  const body = { model, messages: toOpenAI(system, messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  if (maxTokens && provider !== 'openai') body.max_tokens = maxTokens;
  const headers = { 'content-type': 'application/json' };
  if (cfg.api_key) headers.authorization = `Bearer ${cfg.api_key}`;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/documentary-studio'; headers['X-Title'] = 'Documentary Studio'; }
  const data = await post(`${cfg.base_url}/chat/completions`, headers, body);
  const choice = ((data.choices || [])[0] || {}).message || {};
  const calls = (choice.tool_calls || []).map((tc, i) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) { args = { _raw: tc.function?.arguments }; }
    return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, args };
  });
  let content = choice.content;
  if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
  const u = data.usage || {};
  return { text: String(content || '').trim(), tool_calls: calls, usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } };
}

async function chat(provider, model, system, messages, tools = null, maxTokens = 8192) {
  const cfg = providerConfig(provider);
  model = model || cfg.model;
  if (!model) throw new LLMError(`No model set for ${cfg.label}. Set one in Settings.`);
  if (cfg.kind === 'anthropic') {
    if (!cfg.api_key) throw new LLMError('Anthropic API key missing. Add it in Settings.');
    return chatAnthropic(cfg, model, system, messages, tools, maxTokens);
  }
  if (provider !== 'custom' && !cfg.api_key) throw new LLMError(`${cfg.label} API key missing. Add it in Settings.`);
  return chatOpenAI(cfg, model, system, messages, tools, maxTokens, provider);
}

function parseJson(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (_) { /* try to find the JSON inside */ }
  for (const [o, c] of [['{', '}'], ['[', ']']]) {
    const s = t.indexOf(o), e = t.lastIndexOf(c);
    if (s !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { /* next */ } }
  }
  throw new LLMError(`The AI did not return valid JSON:\n${t.slice(0, 600)}`);
}

// One-shot JSON answer (metadata, ideas). Tests may replace this function.
const api = {
  async completeJson(prompt, system = 'You are a helpful assistant. Reply with JSON only.', provider = null, model = null) {
    if (!provider) [provider, model] = defaultProviderModel();
    if (!provider) throw new LLMError('No default AI provider set. Choose one in Settings.');
    const res = await api.chat(provider, model, system, [{ role: 'user', text: prompt }], null, 4096);
    return parseJson(res.text);
  },
  chat,
  async test(provider, model) {
    const res = await api.chat(provider, model, 'Reply with the single word: OK', [{ role: 'user', text: 'ping' }], null, 20);
    return res.text;
  },
};

module.exports = Object.assign(api, { PROVIDERS, LLMError, providerConfig, defaultProviderModel, toAnthropic, toOpenAI, parseJson });
