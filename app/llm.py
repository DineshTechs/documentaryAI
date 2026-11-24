"""Multi-provider LLM client with tool calling.

Internal, provider-neutral message format:
  {"role": "user", "text": "..."}
  {"role": "assistant", "text": "...", "tool_calls": [{"id": "...", "name": "...", "args": {...}}]}
  {"role": "tool", "tool_call_id": "...", "name": "...", "content": "..."}

Supported providers:
  anthropic  - Claude (native Messages API)
  openai     - OpenAI
  gemini     - Google Gemini (OpenAI-compatible endpoint)
  openrouter - OpenRouter (hundreds of models)
  deepseek, groq, mistral, xai
  custom     - any OpenAI-compatible server (Ollama, LM Studio, vLLM, Together...)
"""
import json
import time
import uuid

import requests

from . import db

PROVIDERS = {
    "anthropic": {"label": "Anthropic (Claude)", "base_url": "https://api.anthropic.com/v1",
                  "kind": "anthropic", "model_hint": "claude-sonnet-5-5"},
    "openai": {"label": "OpenAI", "base_url": "https://api.openai.com/v1", "kind": "openai",
               "model_hint": "your OpenAI model id"},
    "gemini": {"label": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "kind": "openai", "model_hint": "your Gemini model id"},
    "openrouter": {"label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "kind": "openai",
                   "model_hint": "e.g. anthropic/claude-sonnet-5-5"},
    "deepseek": {"label": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "kind": "openai",
                 "model_hint": "e.g. deepseek-chat"},
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1", "kind": "openai",
             "model_hint": "your Groq model id"},
    "mistral": {"label": "Mistral", "base_url": "https://api.mistral.ai/v1", "kind": "openai",
                "model_hint": "e.g. mistral-large-latest"},
    "xai": {"label": "xAI (Grok)", "base_url": "https://api.x.ai/v1", "kind": "openai",
            "model_hint": "your Grok model id"},
    "custom": {"label": "Custom / Ollama (OpenAI-compatible)", "base_url": "http://localhost:11434/v1",
               "kind": "openai", "model_hint": "e.g. llama3.1:70b"},
}


class LLMError(Exception):
    pass


def provider_config(name):
    """Merge built-in defaults with what the user saved in Settings."""
    if name not in PROVIDERS:
        raise LLMError(f"Unknown provider '{name}'")
    saved = (db.get_setting("providers", {}) or {}).get(name, {})
    cfg = dict(PROVIDERS[name])
    cfg["api_key"] = saved.get("api_key", "")
    cfg["base_url"] = (saved.get("base_url") or cfg["base_url"]).rstrip("/")
    cfg["model"] = saved.get("model") or ""
    return cfg


def default_provider_model():
    d = db.get_setting("default_llm", {}) or {}
    return d.get("provider"), d.get("model")


def _post(url, headers, body, timeout=300, retries=4):
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=timeout)
        except requests.RequestException as e:
            last = str(e)
            time.sleep(2 ** attempt)
            continue
        if r.status_code in (429, 500, 502, 503, 504, 529):
            last = f"HTTP {r.status_code}: {r.text[:500]}"
            time.sleep(min(30, 3 * (2 ** attempt)))
            continue
        if r.status_code >= 400:
            raise LLMError(f"HTTP {r.status_code}: {r.text[:1500]}")
        return r.json()
    raise LLMError(f"Request failed after retries: {last}")


# ---------------- Anthropic ----------------
def _to_anthropic(messages):
    out = []

    def push(role, blocks):
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": list(blocks)})

    for m in messages:
        if m["role"] == "user":
            push("user", [{"type": "text", "text": m.get("text") or "(continue)"}])
        elif m["role"] == "assistant":
            blocks = []
            if m.get("text"):
                blocks.append({"type": "text", "text": m["text"]})
            for tc in m.get("tool_calls") or []:
                blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc.get("args") or {}})
            if not blocks:
                blocks = [{"type": "text", "text": "(no output)"}]
            push("assistant", blocks)
        elif m["role"] == "tool":
            content = m.get("content") or "(empty)"
            if m.get("image_b64"):
                content = [{"type": "text", "text": content},
                           {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": m["image_b64"]}}]
            push("user", [{"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": content}])
    # Tool results must come before any text in a user turn.
    for msg in out:
        if msg["role"] == "user":
            msg["content"].sort(key=lambda b: 0 if b["type"] == "tool_result" else 1)
    return out


def _chat_anthropic(cfg, model, system, messages, tools, max_tokens):
    body = {"model": model, "max_tokens": max_tokens, "system": system,
            "messages": _to_anthropic(messages)}
    if tools:
        body["tools"] = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
                         for t in tools]
    headers = {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
    data = _post(f"{cfg['base_url']}/messages", headers, body)
    text, calls = [], []
    for b in data.get("content", []):
        if b.get("type") == "text":
            text.append(b["text"])
        elif b.get("type") == "tool_use":
            calls.append({"id": b["id"], "name": b["name"], "args": b.get("input") or {}})
    usage = data.get("usage", {})
    return {"role": "assistant", "text": "\n".join(text).strip(), "tool_calls": calls,
            "usage": {"in": usage.get("input_tokens", 0), "out": usage.get("output_tokens", 0)}}


# ---------------- OpenAI-compatible ----------------
def _to_openai(system, messages):
    out = [{"role": "system", "content": system}] if system else []
    pending_imgs = []

    def flush_imgs():
        # OpenAI-style APIs only accept images in user messages, after the block of tool results.
        if pending_imgs:
            parts = [{"type": "text", "text": "Images returned by view_image:"}]
            parts += [{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}} for b in pending_imgs]
            out.append({"role": "user", "content": parts})
            pending_imgs.clear()

    for m in messages:
        if m["role"] != "tool":
            flush_imgs()
        if m["role"] == "user":
            out.append({"role": "user", "content": m.get("text") or "(continue)"})
        elif m["role"] == "assistant":
            msg = {"role": "assistant", "content": m.get("text") or ""}
            if m.get("tool_calls"):
                msg["tool_calls"] = [{"id": tc["id"], "type": "function",
                                      "function": {"name": tc["name"], "arguments": json.dumps(tc.get("args") or {})}}
                                     for tc in m["tool_calls"]]
            out.append(msg)
        elif m["role"] == "tool":
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m.get("content") or "(empty)"})
            if m.get("image_b64"):
                pending_imgs.append(m["image_b64"])
    flush_imgs()
    return out


def _chat_openai(cfg, model, system, messages, tools, max_tokens):
    body = {"model": model, "messages": _to_openai(system, messages)}
    if tools:
        body["tools"] = [{"type": "function", "function": t} for t in tools]
    headers = {"content-type": "application/json"}
    if cfg.get("api_key"):
        headers["authorization"] = f"Bearer {cfg['api_key']}"
    data = _post(f"{cfg['base_url']}/chat/completions", headers, body)
    choice = (data.get("choices") or [{}])[0].get("message", {}) or {}
    calls = []
    for tc in choice.get("tool_calls") or []:
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {"_raw": fn.get("arguments")}
        calls.append({"id": tc.get("id") or f"call_{uuid.uuid4().hex[:12]}", "name": fn.get("name"), "args": args})
    content = choice.get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    usage = data.get("usage", {}) or {}
    return {"role": "assistant", "text": (content or "").strip(), "tool_calls": calls,
            "usage": {"in": usage.get("prompt_tokens", 0), "out": usage.get("completion_tokens", 0)}}


def chat(provider, model, system, messages, tools=None, max_tokens=8192):
    cfg = provider_config(provider)
    model = model or cfg["model"]
    if not model:
        raise LLMError(f"No model set for provider '{provider}'. Set one in Settings.")
    if cfg["kind"] == "anthropic":
        if not cfg["api_key"]:
            raise LLMError("Anthropic API key missing. Add it in Settings.")
        return _chat_anthropic(cfg, model, system, messages, tools, max_tokens)
    if provider != "custom" and not cfg["api_key"]:
        raise LLMError(f"{cfg['label']} API key missing. Add it in Settings.")
    return _chat_openai(cfg, model, system, messages, tools, max_tokens)


def complete_json(prompt, system="You are a helpful assistant. Reply with JSON only.", provider=None, model=None):
    """One-shot call that returns parsed JSON (used for metadata + idea generation)."""
    if not provider:
        provider, model = default_provider_model()
    if not provider:
        raise LLMError("No default AI provider set. Choose one in Settings.")
    res = chat(provider, model, system, [{"role": "user", "text": prompt}], tools=None, max_tokens=4096)
    return parse_json(res["text"])


def parse_json(text):
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        for open_c, close_c in (("{", "}"), ("[", "]")):
            s, e = t.find(open_c), t.rfind(close_c)
            if s != -1 and e > s:
                try:
                    return json.loads(t[s:e + 1])
                except json.JSONDecodeError:
                    pass
    raise LLMError("Model did not return valid JSON:\n" + text[:800])


def test_provider(provider, model):
    res = chat(provider, model, "Reply with the single word: OK", [{"role": "user", "text": "ping"}], max_tokens=20)
    return res["text"]
