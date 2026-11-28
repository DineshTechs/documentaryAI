'use strict';
// Multi-provider LLM client with tool calling and images.
// Internal message format:
//   {role:'user', text}
//   {role:'assistant', text, tool_calls:[{id, name, args}]}
//   {role:'tool', tool_call_id, name, content, image_b64?}
const store = require('./store');

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base_url: 'https://api.anthropic.com/v1', kind: 'anthropic', model_hint: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI (ChatGPT / GPT)', base_url: 'https://api.openai.com/v1', kind: 'openai', model_hint: 'your GPT model id',
    note: 'Uses an API key from platform.openai.com (pay-as-you-go credits). A ChatGPT Plus/Pro subscription does not include API access.' },
  gemini: { label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', model_hint: 'your Gemini model id' },
  openrouter: { label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', kind: 'openai', model_hint: 'e.g. anthropic/claude-sonnet-5-5' },
  deepseek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', kind: 'openai', model_hint: 'e.g. deepseek-flash' },
  groq: { label: 'Groq', base_url: 'https://api.groq.com/openai/v1', kind: 'openai', model_hint: 'your Groq model id' },
  mistral: { label: 'Mistral', base_url: 'https://api.mistral.ai/v1', kind: 'openai', model_hint: 'e.g. mistral-large-latest' },
  xai: { label: 'xAI (Grok)', base_url: 'https://api.x.ai/v1', kind: 'openai', model_hint: 'your Grok model id' },
  pollinations: { label: 'Pollinations (free, no key)', base_url: 'https://text.pollinations.ai/openai', base_url_with_key: 'https://gen.pollinations.ai/v1', kind: 'openai', model_hint: 'openai', default_model: 'openai', no_key: true,
    min_interval_ms: 15000, max_chars_no_key: 16000,
    note: 'Free, no sign-up, but without a key each request is limited to about 16,000 characters and one request every 15 seconds. That is too small for the film agent (its instructions alone are longer), so without a key Pollinations is only used for short jobs like YouTube titles and idea brainstorming. A key (sk_…) from enter.pollinations.ai removes the size limit; the app then uses gen.pollinations.ai automatically.' },
  custom: { label: 'Custom / Ollama (OpenAI-compatible)', base_url: 'http://localhost:11434/v1', kind: 'openai', model_hint: 'e.g. llama3.1:70b', no_key: true },
};

class LLMError extends Error {}
// Anthropic wants [A-Za-z0-9_-] ids; OpenAI allows at most 40 chars. Same input -> same output, so pairs still match.
const safeId = (id) => { const t = String(id || 'call').replace(/[^A-Za-z0-9_-]/g, '_'); return t.length > 40 ? t.slice(0, 24) + '_' + require('crypto').createHash('sha1').update(t).digest('hex').slice(0, 15) : t; };

function providerConfig(name) {
  if (!PROVIDERS[name]) throw new LLMError(`Unknown AI provider "${name}"`);
  const saved = (store.getSetting('providers', {}) || {})[name] || {};
  // Pollinations: keys only work on its newer gateway; without a key, use the free classic endpoint
  const base = saved.base_url || (saved.api_key && PROVIDERS[name].base_url_with_key) || PROVIDERS[name].base_url;
  return { ...PROVIDERS[name], api_key: saved.api_key || '', base_url: base.replace(/\/$/, ''), model: saved.model || PROVIDERS[name].default_model || '' };
}

// ---------------------------------------------------------------- priority list + fallback
// Settings: llm_priority = ['gemini', 'openrouter', 'anthropic'] (first = used first). Older installs only have
// default_llm {provider, model}; that still works as a one-item list.
function hasAccess(name) {
  try {
    const c = providerConfig(name);
    if (c.api_key) return true;
    if (name === 'custom') return !!store.getSetting('providers', {})?.custom?.base_url;
    return !!c.no_key;
  } catch (_) { return false; }
}
function modelFor(name) {
  const d = store.getSetting('default_llm', {}) || {};
  return providerConfig(name).model || (d.provider === name ? d.model || '' : '') || '';
}
function priorityList() {
  const saved = store.getSetting('llm_priority', null);
  const d = store.getSetting('default_llm', {}) || {};
  const list = Array.isArray(saved) ? saved : d.provider ? [d.provider] : []; // [] = you turned them all off
  return [...new Set(list)].filter((k) => PROVIDERS[k]);
}
function defaultProviderModel() {
  const first = priorityList().find(hasAccess) || priorityList()[0];
  return first ? [first, modelFor(first) || null] : [null, null];
}
// The providers to try, in order. A film pinned to a provider tries that one first, then the priority list.
function chain(pinned = null, pinnedModel = null) {
  const out = [];
  if (pinned) out.push({ provider: pinned, model: pinnedModel || modelFor(pinned) });
  for (const k of priorityList()) if (k !== pinned && hasAccess(k)) out.push({ provider: k, model: modelFor(k) });
  if (!out.length) { const k = priorityList()[0]; if (k) out.push({ provider: k, model: modelFor(k) }); }
  return out;
}

// After a quota / rate-limit / auth failure, skip that provider for a while (it is still tried as a last resort).
const cooling = new Map(); // provider -> { until, reason }
function coolDown(name, msg) {
  let mins = 0;
  if (/HTTP 429|rate.?limit|too many requests|RESOURCE_EXHAUSTED/i.test(msg)) mins = 10;
  if (/quota|insufficient|credit|billing|exceeded your current|per day|daily|HTTP 402/i.test(msg)) mins = 60;
  if (/HTTP 401|HTTP 403|invalid.*key|API key missing|unauthori[sz]ed/i.test(msg)) mins = 30;
  if (/HTTP 5\d\d|HTTP 529|overloaded|fetch failed|timeout|timed out|ECONN|ENOTFOUND|refused|Request failed after retries/i.test(msg)) mins = Math.max(mins, 3);
  if (mins) cooling.set(name, { until: Date.now() + mins * 60000, reason: msg.slice(0, 160) });
}
function providerStatus() {
  const now = Date.now();
  return Object.fromEntries([...cooling].filter(([, v]) => v.until > now).map(([k, v]) => [k, { minutes_left: Math.ceil((v.until - now) / 60000), reason: v.reason }]));
}
const shortErr = (m) => String(m).replace(/\s+/g, ' ').slice(0, 180);

// Try each provider in turn. onSwitch(from, to, error) is called when moving to the next one.
async function chatChain(list, system, messages, tools = null, maxTokens = 8192, onSwitch = null) {
  if (!list.length) throw new LLMError('No AI provider set. Add a key and set the priority in Settings → AI models.');
  const now = Date.now();
  const ready = list.filter((x) => !(cooling.get(x.provider)?.until > now));
  const order = [...ready, ...list.filter((x) => !ready.includes(x))]; // cooling-down ones go last
  const errors = [];
  const size = String(system || '').length + JSON.stringify(messages || []).length + (tools ? JSON.stringify(tools).length : 0);
  for (let i = 0; i < order.length; i++) {
    const { provider, model } = order[i];
    const cfg = (() => { try { return providerConfig(provider); } catch (_) { return {}; } })();
    if (cfg.max_chars_no_key && !cfg.api_key && size > cfg.max_chars_no_key) {
      // known free-tier size limit: don't waste a request (and don't pause the provider for short jobs)
      errors.push(`${cfg.label}: request is ${Math.round(size / 1000)}k characters; the free no-key limit is ${cfg.max_chars_no_key / 1000}k. Add a free Pollinations key to use it for films.`);
      continue;
    }
    try {
      const res = await api.chat(provider, model, system, messages, tools, maxTokens, order.length > 1 ? 2 : 4); // api.chat so tests can replace it
      // Some services (Pollinations) answer "out of credits" as a normal reply instead of an error: treat it as one
      if ((!res.tool_calls || !res.tool_calls.length) && /doesn'?t have enough credits|insufficient (credits|balance)|top[- ]?up\?ref=|low_balance/i.test(res.text || ''))
        throw new LLMError(`HTTP 402: out of credits (${shortErr(res.text)})`);
      cooling.delete(provider);
      return { ...res, provider, model: model || providerConfig(provider).model };
    } catch (e) {
      const label = PROVIDERS[provider]?.label || provider;
      errors.push(`${label}: ${shortErr(e.message)}`);
      coolDown(provider, e.message);
      if (i < order.length - 1 && onSwitch) onSwitch(provider, order[i + 1].provider, shortErr(e.message));
    }
  }
  throw new LLMError(errors.length > 1 ? `All AI providers failed:\n- ${errors.join('\n- ')}` : errors[0].replace(/^[^:]+: /, ''));
}

// ---------------------------------------------------------------- model lists (for the Settings dropdowns)
const NOT_CHAT = /embed|whisper|tts|dall-?e|moderation|transcribe|realtime|audio|image|imagen|veo|davinci|babbage|search-|aqa|guard|rerank|ocr/i;
const modelCache = new Map();
async function listModels(name, fresh = false) {
  const cfg = providerConfig(name);
  const ck = `${name}:${cfg.api_key}:${cfg.base_url}`;
  const hit = modelCache.get(ck);
  if (!fresh && hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.v;
  if (!cfg.api_key && !cfg.no_key) throw new LLMError(`Add your ${cfg.label} API key first, then load the models.`);
  const headers = cfg.kind === 'anthropic'
    ? { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' }
    : (cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {});
  const r = await require('./relay').fetchSmart(`${cfg.base_url}/models${cfg.kind === 'anthropic' ? '?limit=1000' : ''}`, { headers, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new LLMError(`Could not list ${cfg.label} models: HTTP ${r.status} ${text.slice(0, 200)}`);
  let j; try { j = JSON.parse(text); } catch (_) { throw new LLMError(`Bad model list from ${cfg.label}`); }
  const raw = Array.isArray(j) ? j : j.data || j.models || [];
  let models = raw.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && (m.id || m.name)).map((m) => {
    if (m.tools === false && name === 'pollinations') return null; // the agent needs tool calling
    const id = String(m.id || m.name).replace(/^models\//, '');
    const info = [m.display_name || (m.name && m.name !== id ? m.name : ''), m.context_length ? `${Math.round(m.context_length / 1000)}k context` : ''].filter(Boolean).join(' · ');
    return { id, name: id, info: info || (typeof m.description === 'string' ? m.description.slice(0, 80) : ''), created: m.created || (m.created_at ? Date.parse(m.created_at) / 1000 : 0) };
  }).filter(Boolean);
  if (!['custom', 'openrouter', 'pollinations'].includes(name)) models = models.filter((m) => !NOT_CHAT.test(m.id));
  models.sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id));
  modelCache.set(ck, { t: Date.now(), v: models });
  return models;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// keep to a provider's free rate limit (e.g. Pollinations without a key: one request per 15 s)
const lastCall = new Map();
async function throttle(name, ms) {
  const wait = (lastCall.get(name) || 0) + ms - Date.now();
  lastCall.set(name, Date.now() + Math.max(0, wait));
  if (wait > 0) await sleep(wait);
}

async function post(url, headers, body, retries = 4) {
  let last = '';
  for (let attempt = 0; attempt < retries; attempt++) {
    let r;
    try {
      r = await require('./relay').fetchSmart(url, { method: 'POST', headers: { 'user-agent': 'DocumentaryStudio/2.1 (+https://github.com/DineshTechs/documentaryAI) Node.js', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    } catch (e) {
      last = require('./mcp').netError(e, url); await sleep(2 ** attempt * 1000); continue;
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
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: safeId(tc.id), name: tc.name, input: tc.args || {} });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no output)' }]);
    } else if (m.role === 'tool') {
      let content = m.content || '(empty)';
      if (m.image_b64) content = [{ type: 'text', text: content }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.image_b64 } }];
      push('user', [{ type: 'tool_result', tool_use_id: safeId(m.tool_call_id), content }]);
    }
  }
  for (const msg of out) if (msg.role === 'user') msg.content.sort((a, b) => (a.type === 'tool_result' ? 0 : 1) - (b.type === 'tool_result' ? 0 : 1));
  return out;
}

async function chatAnthropic(cfg, model, system, messages, tools, maxTokens, retries = 4) {
  // the long system prompt (film guide) is cached by Anthropic, so repeated agent steps cost much less
  const sys = system && system.length > 4000 ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
  const body = { model, max_tokens: maxTokens, system: sys, messages: toAnthropic(messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const data = await post(`${cfg.base_url}/messages`, { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body, retries);
  const text = [], calls = [];
  for (const b of data.content || []) {
    if (b.type === 'text') text.push(b.text);
    else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: b.input || {} });
  }
  const u = data.usage || {};
  return { text: text.join('\n').trim(), tool_calls: calls,
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 } };
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
        msg.tool_calls = m.tool_calls.map((tc) => ({ id: safeId(tc.id), type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: safeId(m.tool_call_id), content: m.content || '(empty)' });
      if (m.image_b64) imgs.push(m.image_b64);
    }
  }
  flush();
  return out;
}

async function chatOpenAI(cfg, model, system, messages, tools, maxTokens, provider, retries = 4) {
  const body = { model, messages: toOpenAI(system, messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  if (maxTokens && provider !== 'openai') body.max_tokens = maxTokens;
  const headers = { 'content-type': 'application/json' };
  if (cfg.api_key) headers.authorization = `Bearer ${cfg.api_key}`;
  if (provider === 'openrouter') body.usage = { include: true };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/documentary-studio'; headers['X-Title'] = 'Documentary Studio'; }
  const data = await post(`${cfg.base_url}/chat/completions`, headers, body, retries);
  const choice = ((data.choices || [])[0] || {}).message || {};
  const calls = (choice.tool_calls || []).map((tc, i) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) { args = { _raw: tc.function?.arguments }; }
    return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, args };
  });
  let content = choice.content;
  if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
  const u = data.usage || {};
  // prompt_tokens includes cached ones; OpenAI/Gemini report them in prompt_tokens_details, DeepSeek as prompt_cache_hit_tokens
  const cached = (u.prompt_tokens_details || {}).cached_tokens || u.prompt_cache_hit_tokens || 0;
  const usage = { in: Math.max(0, (u.prompt_tokens || 0) - cached), out: u.completion_tokens || 0, cache_read: cached, cache_write: 0 };
  if (typeof u.cost === 'number') usage.cost = u.cost; // OpenRouter reports the exact charge
  return { text: String(content || '').trim(), tool_calls: calls, usage };
}

async function chat(provider, model, system, messages, tools = null, maxTokens = 8192, retries = 4) {
  const cfg = providerConfig(provider);
  model = model || cfg.model;
  if (!model) throw new LLMError(`No model set for ${cfg.label}. Set one in Settings.`);
  if (cfg.kind === 'anthropic') {
    if (!cfg.api_key) throw new LLMError('Anthropic API key missing. Add it in Settings.');
    return chatAnthropic(cfg, model, system, messages, tools, maxTokens, retries);
  }
  if (!cfg.no_key && !cfg.api_key) throw new LLMError(`${cfg.label} API key missing. Add it in Settings.`);
  if (cfg.min_interval_ms && !cfg.api_key) await throttle(provider, cfg.min_interval_ms);
  return chatOpenAI(cfg, model, system, messages, tools, maxTokens, provider, retries);
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

// ---------------------------------------------------------------- cost counter
// USD per 1M tokens: [input, output, cache read, cache write]. First match wins. These are estimates from public
// price lists (Nov 2026); prices change, so Settings → AI models lets you correct any model's price.
const PRICE_TABLE = [
  [/claude-haiku-5/i, [0.10, 0.50, 0.01, 0.125]],
  [/claude-sonnet-5/i, [2, 10, 0.10, 2.5]],
  [/claude-opus-5/i, [4, 20, 0.20, 5]],
  [/claude-fable-5|claude-mythos-5/i, [8, 40, 0.20, 10]],
  [/deepseek.*flash/i, [0.3, 1.2, 0.006, 0]], // official peak rates (off-peak is half), Nov 2026
  [/deepseek.*pro/i, [1.32, 3.96, 0.044, 0]],
];
const FREE_PROVIDERS = { pollinations: 'free', gemini: 'free tier' }; // Gemini: set a price if billing is on
function priceFor(provider, model) {
  const own = (store.getSetting('llm_prices', {}) || {})[model];
  if (own && own.in !== '' && own.in != null) return { p: [+own.in || 0, +own.out || 0, own.cache != null && own.cache !== '' ? +own.cache : (+own.in || 0) * 0.1, (+own.in || 0) * 1.25], source: 'yours' };
  if (FREE_PROVIDERS[provider]) return { p: [0, 0, 0, 0], source: FREE_PROVIDERS[provider] };
  const hit = PRICE_TABLE.find(([re]) => re.test(model || ''));
  return hit ? { p: hit[1], source: 'estimate' } : null;
}
function costOf(provider, model, u) {
  if (typeof u.cost === 'number') return { cost: u.cost, known: true };
  const pr = priceFor(provider, model);
  if (!pr) return { cost: 0, known: false };
  const [i, o, cr, cw] = pr.p;
  return { cost: ((u.in || 0) * i + (u.out || 0) * o + (u.cache_read || 0) * cr + (u.cache_write || 0) * cw) / 1e6, known: true };
}
const blankUsage = () => ({ calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced_calls: 0 });
function addTo(t, u, c) {
  t.calls++; for (const k of ['in', 'out', 'cache_read', 'cache_write']) t[k] += u[k] || 0;
  t.cost += c.cost; if (!c.known) t.unpriced_calls++;
  return t;
}
// Adds one AI call to the monthly total, and to the film's total when pid is given. Returns the call's cost.
function recordUsage(res, pid = null) {
  if (!res || !res.usage) return 0;
  const key = `${res.provider}:${res.model}`;
  const c = costOf(res.provider, res.model, res.usage);
  const month = new Date().toISOString().slice(0, 7);
  const all = store.getSetting('usage_monthly', {}) || {};
  const m = all[month] || { ...blankUsage(), by_model: {} };
  addTo(m, res.usage, c); m.by_model[key] = addTo(m.by_model[key] || blankUsage(), res.usage, c);
  const months = Object.keys({ ...all, [month]: m }).sort().slice(-12); // keep a year
  store.setSetting('usage_monthly', Object.fromEntries(months.map((k) => [k, k === month ? m : all[k]])));
  if (pid != null) {
    const p = store.getProject(pid);
    if (p) {
      const t = p.usage || { ...blankUsage(), by_model: {} };
      addTo(t, res.usage, c); t.by_model = t.by_model || {}; t.by_model[key] = addTo(t.by_model[key] || blankUsage(), res.usage, c);
      store.updateProject(pid, { usage: t });
    }
  }
  return c.cost;
}

// One-shot JSON answer (metadata, ideas). Tests may replace this function.
const api = {
  async completeJson(prompt, system = 'You are a helpful assistant. Reply with JSON only.', provider = null, model = null, pid = null) {
    const list = chain(provider, model);
    const res = await api.chatChain(list, system, [{ role: 'user', text: prompt }], null, 4096);
    try { recordUsage(res, pid); } catch (_) {}
    return parseJson(res.text);
  },
  chat,
  chatChain: (...a) => chatChain(...a),
  async test(provider, model) {
    const res = await api.chat(provider, model, 'Reply with the single word: OK', [{ role: 'user', text: 'ping' }], null, 20);
    return res.text;
  },
};

module.exports = Object.assign(api, { PROVIDERS, LLMError, providerConfig, defaultProviderModel, toAnthropic, toOpenAI, parseJson, listModels, chain, priorityList, modelFor, hasAccess, providerStatus, safeId, recordUsage, costOf, priceFor, PRICE_TABLE });
