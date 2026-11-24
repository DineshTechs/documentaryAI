"""The film-making agent.

It replicates what Claude Code / Codex do with the cinematic-skill: it reads
SKILL.md, runs the skill's Python scripts in a per-project workspace, writes
the script and scene files, reviews renders, and pauses for the user's
approval at the skill's checkpoints (beat table, look, 30-second draft).
"""
import base64
import collections
import io
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import traceback
from pathlib import Path

import requests

from . import db, llm, tts
from .config import (AGENT_MAX_STEPS, BASH_DEFAULT_TIMEOUT, BASH_MAX_TIMEOUT, PROJECTS_DIR, PYTHON_BIN, SKILL_DIR,
                     SKILL_REPO, SKILL_SCRIPTS)

MAX_TOOL_OUTPUT = 12000
KEEP_FULL_RECENT = 24       # messages kept verbatim; older tool outputs get shortened
KEEP_IMAGES = 2             # only the N most recent view_image results carry pixels

STAGES = ["story", "voice", "images", "scene", "review", "render", "done"]


# ---------------------------------------------------------------- paths
def project_root(p) -> Path:
    return PROJECTS_DIR / p["slug"]


def film_dir(p) -> Path:
    return project_root(p) / "film"


def safe_path(p, rel: str, write=False) -> Path:
    """Resolve a path the model gave us; keep it inside the project (or the skill repo, read-only)."""
    root = project_root(p).resolve()
    rel = (rel or ".").strip()
    cand = Path(rel)
    if not cand.is_absolute():
        cand = root / cand
    cand = cand.resolve()
    if cand == root or root in cand.parents:
        return cand
    if not write and (cand == SKILL_REPO or SKILL_REPO in cand.parents):
        return cand
    raise ValueError(f"Path '{rel}' is outside the project workspace")


# ---------------------------------------------------------------- tools
TOOLS = [
    {"name": "bash",
     "description": "Run a bash command on the Linux render server. Working directory is the project workspace. "
                    "$SKILL_SCRIPTS points to the cinematic-film scripts folder and $FILM is this film's project "
                    "folder. Use for the skill's scripts (new_project.py, fetch_commons.py, render.py, ...), "
                    "ffmpeg, ls, etc. Long renders are fine: raise timeout (seconds, max 3600).",
     "parameters": {"type": "object", "properties": {
         "command": {"type": "string"},
         "timeout": {"type": "integer", "description": "seconds, default 600"}},
         "required": ["command"]}},
    {"name": "read_file",
     "description": "Read a text file from the project workspace or the cinematic-skill repo (e.g. the skill's "
                    "reference docs). Returns numbered lines.",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}},
         "required": ["path"]}},
    {"name": "write_file",
     "description": "Create or overwrite a text file in the project workspace (script, beat table, scene file...).",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "edit_file",
     "description": "Replace one exact, unique occurrence of old_text with new_text in a project file.",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}},
         "required": ["path", "old_text", "new_text"]}},
    {"name": "list_files",
     "description": "List files under a folder of the workspace (recursive, max 400 entries).",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}},
    {"name": "view_image",
     "description": "Look at an image (a rendered still, contact strip, photo) to review it visually.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "web_search",
     "description": "Search the web (or Wikipedia when no search key is configured) for research and fact-checking.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "web_fetch",
     "description": "Fetch a web page and return its readable text (for research / verifying facts).",
     "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "tts_generate",
     "description": "Generate final narration audio for one line of text with the TTS voice configured in the app "
                    "settings (OpenAI TTS, ElevenLabs or espeak-ng). Output format follows the file extension "
                    "(.wav, .mp3, .m4a).",
     "parameters": {"type": "object", "properties": {
         "text": {"type": "string"}, "out_path": {"type": "string"},
         "voice": {"type": "string", "description": "optional voice override"}},
         "required": ["text", "out_path"]}},
    {"name": "set_stage",
     "description": "Tell the app UI which pipeline stage you are in: story, voice, images, scene, review, render.",
     "parameters": {"type": "object", "properties": {"stage": {"type": "string", "enum": STAGES[:-1]},
                                                       "note": {"type": "string"}}, "required": ["stage"]}},
    {"name": "request_approval",
     "description": "Pause and ask the user to approve something (the beat table, the look, the 30-second draft, "
                    "or any decision). Work stops until they reply; their answer comes back as this tool's result. "
                    "List the files they should look at (relative paths) so the app can show them.",
     "parameters": {"type": "object", "properties": {
         "title": {"type": "string"}, "summary": {"type": "string", "description": "markdown"},
         "files": {"type": "array", "items": {"type": "string"}}},
         "required": ["title", "summary"]}},
    {"name": "finish",
     "description": "Call when the final film is rendered. Give the final MP4 path and the SRT captions path.",
     "parameters": {"type": "object", "properties": {
         "summary": {"type": "string"}, "video": {"type": "string"}, "srt": {"type": "string"}},
         "required": ["summary", "video"]}},
]


def _clip(s: str, n=MAX_TOOL_OUTPUT):
    if len(s) <= n:
        return s
    half = n // 2
    return s[:half] + f"\n\n... [{len(s) - n} characters cut] ...\n\n" + s[-half:]


def load_skill_text():
    md = SKILL_DIR / "SKILL.md"
    if not md.exists():
        return "(SKILL.md not found on this server. Check the cinematic-skill install with check_setup.py.)"
    text = md.read_text(errors="replace")
    return _clip(text, 60000)


def skill_tree():
    if not SKILL_DIR.exists():
        return "(skill folder missing)"
    lines = []
    for path in sorted(SKILL_DIR.rglob("*")):
        if any(part.startswith(".") or part == "__pycache__" for part in path.parts):
            continue
        if path.is_file():
            lines.append(str(path.relative_to(SKILL_DIR)))
        if len(lines) > 250:
            lines.append("...")
            break
    return "\n".join(lines)


def system_prompt(p):
    channel = db.get_setting("channel", {}) or {}
    tts_cfg = tts.tts_settings()
    return f"""You are the film-making agent inside "Documentary Studio", a web app for a YouTube documentary channel.
You make narrated cinematic films with the cinematic-film skill (repo: {SKILL_REPO}). You work like a coding agent:
you run the skill's scripts with the bash tool and write files with write_file / edit_file.

FOLLOW THE SKILL. Its SKILL.md is included below. Read any reference docs it points to with read_file
(paths relative to {SKILL_DIR}). Do not invent script flags: read a script's --help or source when unsure.

## This project
- Title: {p['title']}
- Topic / brief: {p.get('topic') or ''}
  {p.get('brief') or ''}
- Target length: about {p.get('duration_s') or 90} seconds
- Preferred look: {p.get('look') or 'auto'} (auto = pick the look that fits the subject, per the skill)
- Aspect ratio: {p.get('aspect') or '16:9'}
- Workspace (your working directory): {project_root(p)}
- Film project folder ($FILM): {film_dir(p)}  - create it with new_project.py if it does not exist yet
- User uploads (their own photos, voice recordings, music) land in: {project_root(p) / 'uploads'}
- Skill scripts ($SKILL_SCRIPTS): {SKILL_SCRIPTS}  - run them with `{PYTHON_BIN}`

## Channel
- Name: {channel.get('name') or '(not set)'}; style notes: {channel.get('style') or '(none)'}
- Language: {channel.get('language') or 'English'}

## Server facts (differences from the skill's defaults)
- This is a headless Linux server. macOS `say` is NOT available; use espeak-ng for the scratch voice
  (check whether tts_say.py supports it, otherwise generate scratch lines with espeak-ng yourself).
- Final voice: the app's configured TTS is "{tts_cfg.get('provider') or 'espeak'}". Use the tts_generate tool for
  the final narration lines unless the user uploaded a human recording in uploads/ - then use that.
- ffmpeg is installed. The server has no display; render stills and contact strips to files and inspect them with
  view_image.
- Images: only freely licensed images (the skill's Wikimedia Commons flow); keep credits.md accurate.

## Approval checkpoints (mandatory)
Wherever the skill says to pause for the user (beat table, look, 30-second draft), call request_approval with a
clear markdown summary and the files to review (e.g. the beat table file, still frames, out/draft_30s.mp4).
Never skip these. If the user asks for changes, make them and ask again.

## Progress
Call set_stage whenever you move to a new stage (story -> voice -> images -> scene -> review -> render).
Keep chat messages short; the user sees your tool activity in the app.

## Finish
Render the final film at 1920x1080 (or the project's aspect ratio) to out/final.mp4 with the final mixed audio,
write captions to out/final.srt, then call finish with both paths (relative to the workspace).
Also write out/chapters.txt with YouTube chapter timestamps ("0:00 Title" per line) based on the narration timing.

=============== SKILL.md ===============
{load_skill_text()}

=============== Files in the skill folder ===============
{skill_tree()}
"""


# ---------------------------------------------------------------- runner registry
class Runner:
    def __init__(self, pid):
        self.pid = pid
        self.cancel = threading.Event()
        self.thread = None
        self.proc = None
        self.live = collections.deque(maxlen=200)
        self.inbox = []
        self.current = None


RUNNERS: dict[int, Runner] = {}
_reg_lock = threading.Lock()


def is_running(pid):
    r = RUNNERS.get(pid)
    return bool(r and r.thread and r.thread.is_alive())


def live_output(pid):
    r = RUNNERS.get(pid)
    if not r:
        return {"running": False, "current": None, "lines": []}
    return {"running": is_running(pid), "current": r.current, "lines": list(r.live)[-60:]}


def start(pid):
    with _reg_lock:
        if is_running(pid):
            return False
        r = Runner(pid)
        RUNNERS[pid] = r
        r.thread = threading.Thread(target=_run, args=(r,), daemon=True, name=f"agent-{pid}")
        db.update_project(pid, status="running")
        r.thread.start()
        return True


def stop(pid):
    r = RUNNERS.get(pid)
    if r:
        r.cancel.set()
        if r.proc and r.proc.poll() is None:
            try:
                os.killpg(r.proc.pid, signal.SIGTERM)
            except Exception:
                pass
    if not is_running(pid):
        p = db.get_project(pid)
        if p and p["status"] == "running":
            db.update_project(pid, status="stopped")


def send_user_message(pid, text):
    p = db.get_project(pid)
    db.add_event(pid, "user", text)
    if is_running(pid):
        RUNNERS[pid].inbox.append(text)
        return "queued"
    if p["status"] == "awaiting_approval":
        return respond_approval(pid, False, text, already_logged=True)
    db.add_message(pid, {"role": "user", "text": text})
    start(pid)
    return "started"


def respond_approval(pid, approved, feedback="", already_logged=False):
    p = db.get_project(pid)
    pending = json.loads(p["pending"]) if p.get("pending") else None
    if not pending:
        return "no pending approval"
    if approved:
        content = "The user APPROVED this." + (f" Their note: {feedback}" if feedback else "") + " Continue."
    else:
        content = f"The user requested CHANGES: {feedback or '(no details)'}. Make them, then ask for approval again."
    if not already_logged:
        db.add_event(pid, "user", ("Approved" if approved else "Changes requested") + (f": {feedback}" if feedback else ""))
    db.add_message(pid, {"role": "tool", "tool_call_id": pending["tool_call_id"], "name": "request_approval",
                         "content": content})
    db.update_project(pid, pending=None, status="idle")
    start(pid)
    return "resumed"


def kickoff(pid):
    p = db.get_project(pid)
    if db.get_messages(pid):
        return start(pid)
    db.add_message(pid, {"role": "user", "text":
        f"Make the film \"{p['title']}\". Topic: {p.get('topic') or p['title']}. "
        f"{p.get('brief') or ''}\nStart with the Story stage: research, fact-check and write the script and beat "
        f"table as the skill describes, then ask me to approve the beat table."})
    db.add_event(pid, "system", "Agent started")
    return start(pid)


# ---------------------------------------------------------------- context preparation
def _image_payload(path: Path):
    from PIL import Image
    im = Image.open(path)
    im = im.convert("RGB")
    im.thumbnail((1400, 1400))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def prepare_messages(p, msgs):
    """Shorten old tool outputs and attach pixels only for the most recent images."""
    out = []
    n = len(msgs)
    img_idx = [i for i, m in enumerate(msgs) if m.get("role") == "tool" and m.get("image")]
    keep_img = set(img_idx[-KEEP_IMAGES:])
    for i, m in enumerate(msgs):
        m = dict(m)
        if m.get("role") == "tool":
            if i < n - KEEP_FULL_RECENT and len(m.get("content") or "") > 1500:
                m["content"] = m["content"][:700] + "\n...[older output shortened]...\n" + m["content"][-500:]
            if m.get("image"):
                if i in keep_img:
                    try:
                        m["image_b64"] = _image_payload(safe_path(p, m["image"]))
                    except Exception as e:
                        m["content"] += f" (image could not be loaded: {e})"
                else:
                    m["content"] += " (older image omitted)"
        out.append(m)
    # Repair: every tool call must have a result (a crash or a stop can leave one dangling).
    have = {m["tool_call_id"] for m in out if m.get("role") == "tool"}
    fixed = []
    for m in out:
        fixed.append(m)
        if m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                if tc["id"] not in have:
                    fixed.append({"role": "tool", "tool_call_id": tc["id"], "name": tc["name"],
                                  "content": "Interrupted: this call did not complete."})
    # Results must directly follow their assistant message: move any stray tool messages up.
    final, i = [], 0
    while i < len(fixed):
        m = fixed[i]
        final.append(m)
        if m.get("role") == "assistant" and m.get("tool_calls"):
            ids = {tc["id"] for tc in m["tool_calls"]}
            rest = fixed[i + 1:]
            results = [t for t in rest if t.get("role") == "tool" and t["tool_call_id"] in ids]
            others = [t for t in rest if not (t.get("role") == "tool" and t["tool_call_id"] in ids)]
            final.extend(results)
            fixed = final + others
            i = len(final)
            continue
        i += 1
    return final


# ---------------------------------------------------------------- tool execution
def _bash(r: Runner, p, command, timeout):
    timeout = max(5, min(int(timeout or BASH_DEFAULT_TIMEOUT), BASH_MAX_TIMEOUT))
    root = project_root(p)
    env = dict(os.environ)
    env.update({"SKILL_SCRIPTS": str(SKILL_SCRIPTS), "SKILL_DIR": str(SKILL_DIR), "FILM": str(film_dir(p)),
                "WORKSPACE": str(root), "PYTHONUNBUFFERED": "1"})
    for k in list(env):  # never leak the app's secrets to model-run commands
        if k in ("APP_PASSWORD", "SECRET_KEY"):
            env.pop(k)
    r.live.clear()
    proc = subprocess.Popen(["bash", "-lc", command], cwd=root, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True,
                            errors="replace")
    r.proc = proc
    chunks = []

    def reader():
        for line in proc.stdout:
            chunks.append(line)
            r.live.append(line.rstrip("\n")[-400:])

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    t0 = time.time()
    killed = None
    while proc.poll() is None:
        if r.cancel.is_set():
            killed = "stopped by user"
        elif time.time() - t0 > timeout:
            killed = f"timed out after {timeout}s"
        if killed:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass
            break
        time.sleep(0.25)
    proc.wait()
    t.join(timeout=5)
    r.proc = None
    out = "".join(chunks)
    status = f"[exit code {proc.returncode}" + (f", {killed}" if killed else "") + f", {time.time() - t0:.0f}s]"
    return _clip(out) + "\n" + status


def _strip_html(html):
    html = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header).*?</\1>", " ", html)
    html = re.sub(r"(?s)<br\s*/?>|</p>|</h\d>|</li>|</tr>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    import html as h
    text = h.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


UA = {"User-Agent": "DocumentaryStudio/1.0 (research bot; contact: site owner)"}


def _web_search(query):
    key = (db.get_setting("search", {}) or {}).get("brave_key")
    if key:
        r = requests.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": 10},
                         headers={"X-Subscription-Token": key, "Accept": "application/json"}, timeout=30)
        r.raise_for_status()
        res = r.json().get("web", {}).get("results", [])
        return "\n\n".join(f"{i+1}. {x.get('title')}\n{x.get('url')}\n{_strip_html(x.get('description',''))}"
                           for i, x in enumerate(res)) or "No results."
    r = requests.get("https://en.wikipedia.org/w/api.php", headers=UA, timeout=30, params={
        "action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": 10})
    r.raise_for_status()
    res = r.json().get("query", {}).get("search", [])
    return ("(Wikipedia search - add a Brave Search key in Settings for full web search)\n\n" +
            "\n\n".join(f"{i+1}. {x['title']}\nhttps://en.wikipedia.org/wiki/{x['title'].replace(' ', '_')}\n"
                        f"{_strip_html(x.get('snippet',''))}" for i, x in enumerate(res))) if res else "No results."


def _web_fetch(url):
    if not url.startswith(("http://", "https://")):
        return "Only http(s) URLs are allowed."
    m = re.match(r"https?://(\w+)\.wikipedia\.org/wiki/(.+)", url)
    if m:  # plain-text extract is much cleaner for Wikipedia
        r = requests.get(f"https://{m.group(1)}.wikipedia.org/w/api.php", headers=UA, timeout=30, params={
            "action": "query", "prop": "extracts", "explaintext": 1, "titles": requests.utils.unquote(m.group(2)),
            "format": "json", "redirects": 1})
        pages = r.json().get("query", {}).get("pages", {})
        txt = "\n\n".join(pg.get("extract", "") for pg in pages.values())
        if txt.strip():
            return _clip(txt, 20000)
    r = requests.get(url, headers=UA, timeout=40)
    ct = r.headers.get("content-type", "")
    if "html" in ct:
        return _clip(_strip_html(r.text), 20000)
    if ct.startswith("text/") or "json" in ct:
        return _clip(r.text, 20000)
    return f"Fetched {len(r.content)} bytes of {ct}; not text."


def execute_tool(r: Runner, p, name, args):
    """Returns (content, extra) where extra may hold {'image': path}."""
    if name == "bash":
        return _bash(r, p, args.get("command", ""), args.get("timeout")), {}
    if name == "read_file":
        path = safe_path(p, args.get("path", ""))
        if not path.exists():
            return f"File not found: {args.get('path')}", {}
        if path.is_dir():
            return "That is a folder; use list_files.", {}
        lines = path.read_text(errors="replace").splitlines()
        off = max(0, int(args.get("offset") or 1) - 1)
        lim = int(args.get("limit") or 800)
        sel = lines[off:off + lim]
        body = "\n".join(f"{i + off + 1:5d}  {ln}" for i, ln in enumerate(sel))
        more = f"\n... ({len(lines) - off - lim} more lines, use offset)" if len(lines) > off + lim else ""
        return _clip(body, 40000) + more, {}
    if name == "write_file":
        path = safe_path(p, args.get("path", ""), write=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args.get("content", ""))
        return f"Wrote {path.relative_to(project_root(p))} ({len(args.get('content', ''))} chars)", {}
    if name == "edit_file":
        path = safe_path(p, args.get("path", ""), write=True)
        if not path.exists():
            return "File not found.", {}
        text = path.read_text(errors="replace")
        old = args.get("old_text", "")
        cnt = text.count(old) if old else 0
        if cnt != 1:
            return f"old_text found {cnt} times; it must match exactly once.", {}
        path.write_text(text.replace(old, args.get("new_text", ""), 1))
        return "Edited.", {}
    if name == "list_files":
        base = safe_path(p, args.get("path") or ".")
        if not base.exists():
            return "Folder not found.", {}
        items = []
        for f in sorted(base.rglob("*")):
            if "__pycache__" in f.parts or any(x.startswith(".") for x in f.relative_to(base).parts):
                continue
            items.append(f"{f.relative_to(base)}{'/' if f.is_dir() else f'  ({f.stat().st_size} B)'}")
            if len(items) >= 400:
                items.append("... (truncated)")
                break
        return "\n".join(items) or "(empty)", {}
    if name == "view_image":
        path = safe_path(p, args.get("path", ""))
        if not path.exists():
            return "Image not found.", {}
        rel = str(path.relative_to(project_root(p))) if project_root(p).resolve() in path.parents else str(path)
        db.add_event(p["id"], "image", rel)
        return f"Image {rel} attached.", {"image": str(path)}
    if name == "web_search":
        return _web_search(args.get("query", "")), {}
    if name == "web_fetch":
        return _web_fetch(args.get("url", "")), {}
    if name == "tts_generate":
        out = safe_path(p, args.get("out_path", ""), write=True)
        return tts.synthesize(args.get("text", ""), out, args.get("voice")), {}
    if name == "set_stage":
        st = args.get("stage")
        if st in STAGES:
            db.update_project(p["id"], stage=st)
            db.add_event(p["id"], "stage", st, {"note": args.get("note")})
        return f"Stage set to {st}.", {}
    return f"Unknown tool {name}", {}


def _describe_call(name, args):
    if name == "bash":
        return args.get("command", "")
    if name in ("read_file", "write_file", "edit_file", "list_files", "view_image"):
        return args.get("path", "") or "."
    if name == "web_search":
        return args.get("query", "")
    if name == "web_fetch":
        return args.get("url", "")
    if name == "tts_generate":
        return f"{args.get('out_path')}: {args.get('text', '')[:80]}"
    return json.dumps(args)[:200]


# ---------------------------------------------------------------- main loop
def _run(r: Runner):
    pid = r.pid
    try:
        p = db.get_project(pid)
        project_root(p).mkdir(parents=True, exist_ok=True)
        (project_root(p) / "uploads").mkdir(exist_ok=True)
        provider, model = p.get("provider"), p.get("model")
        if not provider:
            provider, model = llm.default_provider_model()
        if not provider:
            raise llm.LLMError("No AI provider chosen. Set a default provider in Settings.")
        system = system_prompt(p)
        for _step in range(AGENT_MAX_STEPS):
            if r.cancel.is_set():
                db.update_project(pid, status="stopped")
                db.add_event(pid, "system", "Stopped")
                return
            while r.inbox:
                db.add_message(pid, {"role": "user", "text": r.inbox.pop(0)})
            p = db.get_project(pid)
            msgs = prepare_messages(p, db.get_messages(pid))
            r.current = "thinking"
            res = llm.chat(provider, model, system, msgs, TOOLS)
            r.current = None
            assistant = {"role": "assistant", "text": res["text"], "tool_calls": res["tool_calls"]}
            db.add_message(pid, assistant)
            if res["text"]:
                db.add_event(pid, "assistant", res["text"], {"usage": res.get("usage")})
            if not res["tool_calls"]:
                if r.inbox:
                    continue
                db.update_project(pid, status="idle")
                return
            paused = finished = False
            for tc in res["tool_calls"]:
                name, args = tc["name"], tc.get("args") or {}
                if paused or finished:
                    db.add_message(pid, {"role": "tool", "tool_call_id": tc["id"], "name": name,
                                         "content": "Not run: waiting for the user. Call it again later if needed."})
                    continue
                if name == "request_approval":
                    pending = {"tool_call_id": tc["id"], "title": args.get("title", "Approval needed"),
                               "summary": args.get("summary", ""), "files": args.get("files") or []}
                    db.update_project(pid, pending=json.dumps(pending), status="awaiting_approval")
                    db.add_event(pid, "approval", pending["title"], pending)
                    paused = True
                    continue
                if name == "finish":
                    db.update_project(pid, final_video=args.get("video"), final_srt=args.get("srt"),
                                      stage="done", status="done")
                    db.add_event(pid, "done", args.get("summary", "Film finished"), args)
                    db.add_message(pid, {"role": "tool", "tool_call_id": tc["id"], "name": name,
                                         "content": "Recorded. The user will review the final film."})
                    _after_finish(pid)
                    finished = True
                    continue
                db.add_event(pid, "tool", _describe_call(name, args), {"name": name})
                r.current = f"{name}: {_describe_call(name, args)[:120]}"
                try:
                    content, extra = execute_tool(r, p, name, args)
                except Exception as e:
                    content, extra = f"ERROR: {type(e).__name__}: {e}", {}
                r.current = None
                msg = {"role": "tool", "tool_call_id": tc["id"], "name": name, "content": content}
                if extra.get("image"):
                    msg["image"] = extra["image"]
                db.add_message(pid, msg)
                db.add_event(pid, "tool_result", _clip(content, 4000), {"name": name})
            if paused or finished:
                return
        db.update_project(pid, status="idle")
        db.add_event(pid, "system", f"Paused after {AGENT_MAX_STEPS} steps. Send 'continue' to keep going.")
    except llm.LLMError as e:
        db.update_project(pid, status="error")
        db.add_event(pid, "error", str(e))
    except Exception as e:
        db.update_project(pid, status="error")
        db.add_event(pid, "error", f"{type(e).__name__}: {e}\n{traceback.format_exc()[-2000:]}")
    finally:
        r.current = None


def _after_finish(pid):
    """Link the project to its calendar idea and seed chapters for metadata."""
    p = db.get_project(pid)
    if p.get("idea_id"):
        db.x("UPDATE ideas SET status='scheduled' WHERE id=? AND status IN ('idea','research','production')",
             (p["idea_id"],))


def reset_conversation(pid):
    stop(pid)
    db.x("DELETE FROM messages WHERE project_id=?", (pid,))
    db.update_project(pid, pending=None, status="idle")
    db.add_event(pid, "system", "Agent memory cleared. Files in the workspace were kept.")


def delete_workspace(p):
    shutil.rmtree(project_root(p), ignore_errors=True)
