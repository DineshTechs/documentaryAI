"""Telegram bot: control Documentary Studio from your phone.

Runs inside the app process with long polling (no webhook or public port needed).
Only paired Telegram accounts can use it: pair with the code shown in Settings.

It does two things:
  1. Commands + buttons for every feature (films, approvals, agent chat, files, video, metadata,
     YouTube upload, ideas, calendar, models).
  2. Push notifications: approval requests (with the files to review), stage changes, errors,
     the agent waiting for you, finished films (with the video), and YouTube uploads.
"""
import concurrent.futures
import html
import json
import os
import re
import secrets
import subprocess
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import agent, db, llm, services, youtube
from .config import BASE_URL, DATA_DIR

API = "https://api.telegram.org"
MAX_SEND = 49 * 1024 * 1024        # bots may send files up to 50 MB
MAX_GET = 20 * 1024 * 1024         # ...and download files up to 20 MB

STATUS = {"running": False, "username": None, "error": None}
_state_lock = threading.Lock()
_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="tg")
_bot = None
_started = False

COMMANDS = [
    ("films", "List films"), ("film", "Film card: /film 3"), ("new", "New film: /new Title | topic | 90"),
    ("use", "Set active film: /use 3"), ("status", "What's running and what needs you"),
    ("approve", "Approve the pending step (optional note)"), ("changes", "Request changes: /changes text"),
    ("say", "Message the agent (or just type)"), ("resume", "Start / resume the agent"), ("stop", "Stop the agent"),
    ("log", "Recent agent activity"), ("files", "List files"), ("get", "Download a file: /get path"),
    ("video", "Send the film / latest render"), ("stills", "Send review stills"),
    ("meta", "YouTube metadata (generates if empty)"), ("title", "Set title: /title text"),
    ("tags", "Set tags: /tags a, b, c"), ("privacy", "private | unlisted | public"),
    ("schedule", "Schedule: /schedule 2026-12-01 18:00 (or off)"), ("thumb", "Thumbnail from frame: /thumb 4.5"),
    ("upload", "Upload to YouTube"), ("ideas", "Idea board"), ("idea", "Add idea: /idea Title | notes"),
    ("brainstorm", "AI ideas: /brainstorm theme"), ("makefilm", "Film from idea: /makefilm 5"),
    ("plan", "Release date: /plan 5 2026-12-10"), ("calendar", "Upcoming releases"),
    ("model", "Show/set model: /model anthropic claude-opus-5-5"), ("models", "Configured AI providers"),
    ("help", "All commands"),
]

HELP = """<b>Documentary Studio bot</b>

<b>Films</b>
/films · /film 3 · /use 3 (set the active film)
/new Title | topic | 90 | 16:9: create and start a film
/status: what's running and what needs you

<b>Agent</b> (acts on the active film, or add the film number)
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
/models · /model (show) · /model openai gpt-x (active film) · /model default anthropic claude-sonnet-5-5"""


class TGError(Exception):
    pass


class TG:
    def __init__(self, token):
        self.base = f"{API}/bot{token}"
        self.fbase = f"{API}/file/bot{token}"

    def call(self, method, files=None, http_timeout=60, **params):
        params = {k: v for k, v in params.items() if v is not None}
        if files:
            data = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}
            r = requests.post(f"{self.base}/{method}", data=data, files=files, timeout=http_timeout)
        else:
            r = requests.post(f"{self.base}/{method}", json=params, timeout=http_timeout)
        try:
            d = r.json()
        except ValueError:
            raise TGError(f"HTTP {r.status_code}")
        if not d.get("ok"):
            raise TGError(d.get("description") or f"HTTP {r.status_code}")
        return d["result"]

    def download(self, file_id, dest: Path):
        info = self.call("getFile", file_id=file_id)
        with requests.get(f"{self.fbase}/{info['file_path']}", stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
        return dest


# ---------------------------------------------------------------- settings / state
def cfg():
    return db.get_setting("telegram", {}) or {}


def save_cfg(c):
    db.set_setting("telegram", c)


def state():
    return db.get_setting("telegram_state", {}) or {}


def update_state(fn):
    with _state_lock:
        s = state()
        fn(s)
        db.set_setting("telegram_state", s)
        return s


def chat_state(chat_id):
    return (state().get("chats") or {}).get(str(chat_id), {})


def set_chat(chat_id, **kw):
    def f(s):
        c = s.setdefault("chats", {}).setdefault(str(chat_id), {})
        c.update(kw)
    update_state(f)


def allowed_ids():
    return [a["id"] for a in (cfg().get("allowed") or [])]


def pair_code():
    c = cfg()
    if not c.get("pair_code"):
        c["pair_code"] = secrets.token_hex(4)
        save_cfg(c)
    return c["pair_code"]


def new_pair_code():
    c = cfg()
    c["pair_code"] = secrets.token_hex(4)
    save_cfg(c)
    return c["pair_code"]


def remove_user(uid):
    c = cfg()
    c["allowed"] = [a for a in (c.get("allowed") or []) if a["id"] != int(uid)]
    save_cfg(c)


def tzinfo():
    name = cfg().get("timezone") or "UTC"
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def public_status():
    code = pair_code()
    u = STATUS.get("username")
    return {**STATUS, "pair_code": code, "link": f"https://t.me/{u}?start={code}" if u else None,
            "allowed": cfg().get("allowed") or []}


# ---------------------------------------------------------------- formatting
def e(s):
    return html.escape(str(s or ""), quote=False)


def md_to_html(s, limit=3000):
    s = str(s or "")
    if len(s) > limit:
        s = s[:limit] + "\n…"
    t = e(s)
    t = re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", t)
    t = re.sub(r"(?m)^#{1,4}\s+(.+)$", r"<b>\1</b>", t)
    t = re.sub(r"(?m)^\s*\|?[\s:|-]+\|[\s:|-]*$\n?", "", t)  # table separator rows
    return t


STATUS_ICON = {"running": "🟡", "awaiting_approval": "✋", "done": "✅", "error": "⚠️", "idle": "⏸", "stopped": "⏹",
               "new": "🆕"}


def status_of(p):
    st = "running" if agent.is_running(p["id"]) else p["status"]
    return st, STATUS_ICON.get(st, "•"), {"awaiting_approval": "needs approval", "new": "not started"}.get(st, st)


def fmt_size(b):
    return f"{b / 1e6:.1f} MB" if b > 1e6 else f"{b / 1e3:.0f} KB" if b > 1e3 else f"{b} B"


def btn(text, data=None, url=None):
    return {"text": text, "url": url} if url else {"text": text, "callback_data": data[:64]}


def kb(*rows):
    return {"inline_keyboard": [r for r in rows if r]}


def app_link_row(pid):
    if BASE_URL.startswith("https://"):
        return [btn("🌐 Open in web app", url=f"{BASE_URL}/#/films/{pid}")]
    return None


# ---------------------------------------------------------------- sending helpers
def send(chat, text, markup=None):
    bot = _bot
    if not bot:
        return
    parts = [text[i:i + 4000] for i in range(0, max(len(text), 1), 4000)] or [""]
    for i, part in enumerate(parts):
        try:
            bot.call("sendMessage", chat_id=chat, text=part, parse_mode="HTML", disable_web_page_preview=True,
                     reply_markup=markup if i == len(parts) - 1 else None)
        except TGError as ex:
            if "parse" in str(ex).lower():  # fall back to plain text if our HTML was off
                bot.call("sendMessage", chat_id=chat, text=re.sub(r"<[^>]+>", "", html.unescape(part)),
                         reply_markup=markup if i == len(parts) - 1 else None)
            else:
                raise


def send_file(chat, path: Path, caption=None, kind=None):
    size = path.stat().st_size
    if size > MAX_SEND:
        send(chat, f"📦 <code>{e(path.name)}</code> is {fmt_size(size)}, over Telegram's 50 MB bot limit. "
                   f"Download it from the web app.")
        return
    suf = path.suffix.lower()
    kind = kind or ("video" if suf in (".mp4", ".mov") else "photo" if suf in (".jpg", ".jpeg", ".png", ".webp")
                    and size < 10 * 1024 * 1024 else "audio" if suf in (".mp3", ".m4a") else "document")
    method = {"video": "sendVideo", "photo": "sendPhoto", "audio": "sendAudio"}.get(kind, "sendDocument")
    with open(path, "rb") as f:
        extra = {"supports_streaming": True} if kind == "video" else {}
        _bot.call(method, files={kind: (path.name, f)}, chat_id=chat, http_timeout=600,
                  caption=(caption or "")[:1000] or None, parse_mode="HTML" if caption else None, **extra)


def send_images(chat, paths, caption=None):
    paths = [p for p in paths if p.exists() and p.stat().st_size < 10 * 1024 * 1024][:10]
    if not paths:
        return
    if len(paths) == 1:
        return send_file(chat, paths[0], caption, kind="photo")
    files, media = {}, []
    handles = []
    try:
        for i, p in enumerate(paths):
            h = open(p, "rb")
            handles.append(h)
            files[f"f{i}"] = (p.name, h)
            media.append({"type": "photo", "media": f"attach://f{i}", **({"caption": caption[:1000], "parse_mode": "HTML"}
                                                                       if i == 0 and caption else {})})
        _bot.call("sendMediaGroup", files=files, chat_id=chat, media=media, http_timeout=300)
    finally:
        for h in handles:
            h.close()


def broadcast(text, markup=None):
    for uid in allowed_ids():
        try:
            send(uid, text, markup)
        except Exception:
            pass


# ---------------------------------------------------------------- film helpers
def resolve_pid(chat, arg=None):
    if arg and str(arg).lstrip("#").isdigit():
        pid = int(str(arg).lstrip("#"))
    else:
        pid = chat_state(chat).get("active")
    if not pid or not db.get_project(pid):
        raise ValueError("No film selected. Use /films then /use <number>, or add the number, e.g. /video 3")
    return pid


def split_pid(chat, args):
    """'/cmd 3 rest' or '/cmd rest' -> (pid, rest)."""
    parts = args.split(maxsplit=1)
    if parts and parts[0].lstrip("#").isdigit() and db.get_project(int(parts[0].lstrip("#"))):
        return int(parts[0].lstrip("#")), (parts[1] if len(parts) > 1 else "")
    return resolve_pid(chat), args


def film_card(chat, pid):
    p = db.get_project(pid)
    st, icon, label = status_of(p)
    m = youtube.get_meta(pid)
    lines = [f"🎞 <b>#{pid} {e(p['title'])}</b>",
             f"{icon} {e(label)} · stage <b>{e(p['stage'])}</b> · {p['duration_s']}s · {e(p['aspect'])} · {e(p['look'])}",
             f"<i>{e((p.get('topic') or '')[:300])}</i>",
             f"AI: {e(p.get('provider') or 'default')}{(' · ' + e(p['model'])) if p.get('model') else ''}"]
    if p.get("final_video"):
        lines.append(f"🎬 Final: <code>{e(p['final_video'])}</code>")
    if m.get("youtube_id"):
        lines.append(f"▶️ https://youtu.be/{e(m['youtube_id'])}")
    elif m.get("upload_status"):
        lines.append(f"⬆️ Upload: {e(m['upload_status'])} {m.get('upload_progress') or 0}%")
    if chat_state(chat).get("active") == pid:
        lines.append("📌 Active film")
    run = [btn("■ Stop", f"st:{pid}")] if st == "running" else \
        [btn("✓ Approve", f"ap:{pid}:y"), btn("✎ Changes", f"ap:{pid}:n")] if st == "awaiting_approval" else \
        [btn("▶ Start" if st == "new" else "▶ Resume", f"go:{pid}")]
    markup = kb(run + [btn("📜 Log", f"lg:{pid}")],
                [btn("📁 Files", f"fl:{pid}"), btn("🎬 Video", f"vd:{pid}"), btn("🖼 Stills", f"sl:{pid}")],
                [btn("📝 Metadata", f"md:{pid}"), btn("⬆ YouTube", f"up:{pid}"), btn("📌 Use", f"use:{pid}")],
                app_link_row(pid))
    send(chat, "\n".join(lines), markup)


def latest_files(p, pred, n):
    root = agent.project_root(p)
    if not root.exists():
        return []
    fs = [f for f in root.rglob("*") if f.is_file() and pred(f) and "__pycache__" not in f.parts
          and not any(x.startswith(".") for x in f.relative_to(root).parts)]
    return sorted(fs, key=lambda f: f.stat().st_mtime, reverse=True)[:n]


def show_meta(chat, pid, regenerate=False):
    p = db.get_project(pid)
    m = youtube.get_meta(pid)
    if regenerate or not m.get("title"):
        send(chat, "✨ Writing title, description, tags and chapters…")
        m = youtube.generate_metadata(p)
    opts = m.get("title_options") or []
    sched = ""
    if m.get("publish_at"):
        try:
            sched = datetime.fromisoformat(m["publish_at"].replace("Z", "+00:00")).astimezone(tzinfo()).strftime(
                "%Y-%m-%d %H:%M %Z")
        except Exception:
            sched = m["publish_at"]
    text = [f"📝 <b>#{pid} YouTube metadata</b>", f"<b>Title:</b> {e(m.get('title'))}"]
    if opts:
        text.append("<b>Options:</b>\n" + "\n".join(f"{i + 1}. {e(t)}" for i, t in enumerate(opts)))
    text.append(f"<b>Tags:</b> {e(', '.join(m.get('tags') or []))}")
    text.append(f"<b>Visibility:</b> {e(m.get('privacy'))}" + (f" · <b>scheduled</b> {e(sched)}" if sched else ""))
    if m.get("chapters"):
        text.append("<b>Chapters:</b>\n" + "\n".join(f"{e(c.get('time'))} {e(c.get('label'))}" for c in m["chapters"][:20]))
    text.append(f"<b>Thumbnail:</b> {e(m.get('thumbnail_path') or 'none')}")
    text.append("<b>Description:</b>\n" + e((m.get("description") or "")[:1500]))
    markup = kb([btn(f"Use title {i + 1}", f"tt:{pid}:{i}") for i in range(min(len(opts), 5))][:3],
                [btn(f"Use title {i + 1}", f"tt:{pid}:{i}") for i in range(3, min(len(opts), 5))],
                [btn("🔒 private", f"pv:{pid}:private"), btn("🔗 unlisted", f"pv:{pid}:unlisted"),
                 btn("🌍 public", f"pv:{pid}:public")],
                [btn("🔄 Regenerate", f"mg:{pid}"), btn("⬆ Upload to YouTube", f"up:{pid}")])
    send(chat, "\n\n".join(text), markup)
    if m.get("thumbnail_path"):
        tp = agent.project_root(p) / m["thumbnail_path"]
        if tp.exists():
            send_file(chat, tp, "Current thumbnail", kind="photo")


def confirm_upload(chat, pid):
    p = db.get_project(pid)
    m = youtube.get_meta(pid)
    yt = youtube.creds()
    if not yt.get("refresh_token"):
        return send(chat, "YouTube isn't connected. Connect your channel in the web app: Settings → YouTube.")
    if not p.get("final_video"):
        return send(chat, "This film isn't finished yet, so there's no final video to upload.")
    if not m.get("title"):
        return send(chat, "No title yet. Run /meta first.")
    when = f"scheduled for {m['publish_at']} (UTC)" if m.get("publish_at") else m.get("privacy") or "private"
    send(chat, f"⬆️ Upload <b>{e(m['title'])}</b> to <b>{e(yt.get('channel_title') or 'your channel')}</b> as "
               f"<b>{e(when)}</b>?", kb([btn("✅ Yes, upload", f"upok:{pid}"), btn("Cancel", f"x:{pid}")]))


def log_text(pid, n=15):
    rows = db.q("SELECT * FROM events WHERE project_id=? AND kind!='tool_result' ORDER BY id DESC LIMIT ?", (pid, n))
    out = []
    for r in reversed(rows):
        t = (r["text"] or "").replace("\n", " ")
        icon = {"assistant": "🤖", "user": "🧑", "tool": "🔧", "error": "⚠️", "approval": "✋", "stage": "▸",
                "done": "🎬", "image": "🖼"}.get(r["kind"], "·")
        if r["kind"] == "tool":
            t = f"{json.loads(r['meta'] or '{}').get('name', '')}: {t}"
        out.append(f"{icon} {e(t[:240])}")
    return "\n".join(out) or "No activity yet."


# ---------------------------------------------------------------- command handlers
def cmd_films(chat, args):
    rows = db.q("SELECT * FROM projects ORDER BY updated DESC LIMIT 20")
    if not rows:
        return send(chat, "No films yet. Create one with\n<code>/new Title | topic | 90</code>")
    lines, buttons = [], []
    active = chat_state(chat).get("active")
    for p in rows:
        _, icon, label = status_of(p)
        lines.append(f"{icon} <b>#{p['id']}</b> {e(p['title'])}: {e(label)}, {e(p['stage'])}"
                     + (" 📌" if p["id"] == active else ""))
        buttons.append(btn(f"#{p['id']} {p['title'][:20]}", f"f:{p['id']}"))
    send(chat, "🎞 <b>Films</b>\n" + "\n".join(lines),
         kb(*[buttons[i:i + 2] for i in range(0, min(len(buttons), 12), 2)]))


def cmd_new(chat, args):
    if not args.strip():
        set_chat(chat, wait={"kind": "new"})
        return send(chat, "Send the new film as:\n<code>Title | topic and angle | seconds | 16:9</code>\n"
                          "Only the title is required. Example:\n"
                          "<code>Titanic: The Last Night | the final 160 minutes, minute by minute | 120</code>")
    parts = [x.strip() for x in args.split("|")]
    body = {"title": parts[0], "topic": parts[1] if len(parts) > 1 and parts[1] else parts[0]}
    if len(parts) > 2 and parts[2].isdigit():
        body["duration_s"] = int(parts[2])
    if len(parts) > 3 and parts[3] in ("16:9", "9:16", "1:1"):
        body["aspect"] = parts[3]
    p = services.create_project(body, autostart=True)
    set_chat(chat, active=p["id"], wait=None)
    send(chat, f"🎬 Created <b>#{p['id']} {e(p['title'])}</b> and started the agent. It's now your active film.\n"
               f"I'll message you when it needs your approval.", kb(app_link_row(p["id"])))


def cmd_status(chat, args):
    rows = db.q("SELECT * FROM projects ORDER BY updated DESC")
    running = [p for p in rows if agent.is_running(p["id"])]
    waiting = [p for p in rows if p["status"] == "awaiting_approval"]
    errors = [p for p in rows if p["status"] == "error" and not agent.is_running(p["id"])]
    ups = db.q("""SELECT m.*, p.title FROM metadata m JOIN projects p ON p.id=m.project_id
                  WHERE m.upload_status IS NOT NULL AND m.upload_status NOT LIKE 'done%' AND m.upload_status!='error'""")
    prov, model = llm.default_provider_model()
    yt = youtube.creds()
    lines = ["📊 <b>Status</b>",
             f"🟡 Working: " + (", ".join(f"#{p['id']} {e(p['title'])}" + (f" ({e(agent.live_output(p['id'])['current'] or '')[:60]})")
                                         for p in running) or "none"),
             f"✋ Needs approval: " + (", ".join(f"#{p['id']} {e(p['title'])}" for p in waiting) or "none"),
             f"⚠️ Errors: " + (", ".join(f"#{p['id']} {e(p['title'])}" for p in errors) or "none"),
             f"⬆️ Uploads: " + (", ".join(f"#{u['project_id']} {u['upload_progress']}%" for u in ups) or "none"),
             f"🤖 Default AI: {e(prov or 'not set')} {e(model or '')}",
             f"▶️ YouTube: {e(yt.get('channel_title') or ('connected' if yt.get('refresh_token') else 'not connected'))}"]
    buttons = [btn(f"✋ #{p['id']} review", f"f:{p['id']}") for p in waiting[:4]]
    send(chat, "\n".join(lines), kb(buttons) if buttons else None)


def cmd_approve(chat, args, approved=True):
    pid, note = split_pid(chat, args)
    p = db.get_project(pid)
    if p["status"] != "awaiting_approval":
        return send(chat, f"#{pid} isn't waiting for approval right now.")
    if not approved and not note.strip():
        set_chat(chat, wait={"kind": "feedback", "pid": pid})
        return send(chat, f"What should change in #{pid}? Send it as your next message.")
    r = agent.respond_approval(pid, approved, note.strip())
    set_chat(chat, wait=None)
    send(chat, ("✅ Approved" if approved else "✎ Changes sent") + f". #{pid} agent {e(r)}.")


def cmd_say(chat, args):
    pid, text = split_pid(chat, args)
    if not text.strip():
        return send(chat, "Usage: /say [film] your message. Or just type a message.")
    p = db.get_project(pid)
    r = agent.send_user_message(pid, text.strip())
    note = " (treated as a change request for the pending approval)" if p["status"] == "awaiting_approval" else ""
    send(chat, f"📨 Sent to #{pid}: {e(r)}{note}")


def cmd_resume(chat, args):
    pid = resolve_pid(chat, args.strip() or None)
    r = services.start_or_resume(pid)
    send(chat, f"▶ #{pid}: {e(r)}")


def cmd_stop(chat, args):
    pid = resolve_pid(chat, args.strip() or None)
    agent.stop(pid)
    send(chat, f"■ Stopping #{pid}…")


def cmd_log(chat, args):
    """/log [film] [n]"""
    nums = [int(x.lstrip("#")) for x in args.split() if x.lstrip("#").isdigit()]
    pid, n = None, 15
    if len(nums) >= 2:
        pid, n = nums[0], nums[1]
    elif len(nums) == 1:
        if args.strip().startswith("#") or db.get_project(nums[0]):
            pid = nums[0]
        else:
            n = nums[0]
    pid = resolve_pid(chat, pid)
    live = agent.live_output(pid)
    tail = ""
    if live["running"] and live["lines"]:
        tail = "\n\n<b>Live output</b>\n<pre>" + e("\n".join(live["lines"][-10:]))[-1500:] + "</pre>"
    send(chat, f"📜 <b>#{pid} activity</b>\n" + log_text(pid, min(n, 50)) + tail)


def cmd_files(chat, args):
    pid, flt = split_pid(chat, args)
    p = db.get_project(pid)
    fs = latest_files(p, lambda f: flt.lower() in str(f).lower(), 40)
    root = agent.project_root(p)
    if not fs:
        return send(chat, "No files yet." if not flt else "No matching files.")
    send(chat, f"📁 <b>#{pid} newest files</b>{(' matching ' + e(flt)) if flt else ''}\n" +
         "\n".join(f"<code>{e(f.relative_to(root))}</code> · {fmt_size(f.stat().st_size)}" for f in fs) +
         "\n\nGet one with <code>/get path</code>")


def cmd_get(chat, args):
    pid, path = split_pid(chat, args)
    if not path.strip():
        return send(chat, "Usage: /get film/beats.md")
    p = db.get_project(pid)
    f = agent.safe_path(p, path.strip())
    if not f.is_file():
        return send(chat, "File not found. See /files")
    send_file(chat, f, kind="document" if f.suffix.lower() not in (".mp4", ".mov") else None)


def cmd_video(chat, args):
    pid = resolve_pid(chat, args.strip() or None)
    p = db.get_project(pid)
    root = agent.project_root(p)
    f = root / p["final_video"] if p.get("final_video") else None
    if not f or not f.exists():
        vids = latest_files(p, lambda x: x.suffix.lower() in (".mp4", ".mov"), 1)
        f = vids[0] if vids else None
    if not f:
        return send(chat, "No video rendered yet.")
    send(chat, f"🎬 Sending <code>{e(f.relative_to(root))}</code> ({fmt_size(f.stat().st_size)})…")
    send_file(chat, f, f"#{pid} {e(p['title'])}")
    srt = root / p["final_srt"] if p.get("final_srt") else None
    if srt and srt.exists():
        send_file(chat, srt, kind="document")


def cmd_stills(chat, args):
    pid = resolve_pid(chat, args.strip() or None)
    p = db.get_project(pid)
    imgs = latest_files(p, lambda f: f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
                        and "uploads" not in f.parts, 10)
    if not imgs:
        return send(chat, "No stills yet.")
    send_images(chat, imgs, f"#{pid} latest stills")


def cmd_meta(chat, args):
    pid, rest = split_pid(chat, args)
    show_meta(chat, pid, regenerate=rest.strip().lower() in ("new", "regenerate", "again"))


def cmd_title(chat, args):
    pid, t = split_pid(chat, args)
    if not t.strip():
        return send(chat, "Usage: /title Your new title")
    youtube.save_meta(pid, {"title": t.strip()[:100]})
    send(chat, f"✓ Title set: <b>{e(t.strip()[:100])}</b>")


def cmd_tags(chat, args):
    pid, t = split_pid(chat, args)
    tags = [x.strip() for x in t.split(",") if x.strip()]
    youtube.save_meta(pid, {"tags": tags})
    send(chat, f"✓ {len(tags)} tags saved.")


def cmd_privacy(chat, args):
    pid, v = split_pid(chat, args)
    v = v.strip().lower()
    if v not in ("private", "unlisted", "public"):
        return send(chat, "Usage: /privacy private | unlisted | public")
    youtube.save_meta(pid, {"privacy": v})
    send(chat, f"✓ Visibility: {v}")


def cmd_schedule(chat, args):
    pid, v = split_pid(chat, args)
    v = v.strip()
    if v.lower() in ("off", "none", "clear", ""):
        youtube.save_meta(pid, {"publish_at": ""})
        return send(chat, "✓ Schedule cleared.")
    try:
        local = datetime.strptime(v, "%Y-%m-%d %H:%M").replace(tzinfo=tzinfo())
    except ValueError:
        return send(chat, "Usage: /schedule 2026-12-01 18:00 (your timezone from Settings → Telegram)")
    if local < datetime.now(timezone.utc) + timedelta(minutes=15):
        return send(chat, "Pick a time at least 15 minutes from now.")
    iso = local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    youtube.save_meta(pid, {"publish_at": iso})
    send(chat, f"✓ #{pid} will go public at {e(local.strftime('%Y-%m-%d %H:%M %Z'))}. Upload it with /upload "
               f"(it uploads as private until then).")


def cmd_thumb(chat, args):
    parts = args.split()
    if len(parts) >= 2:
        pid, v = resolve_pid(chat, parts[0]), parts[1]
    else:
        pid, v = resolve_pid(chat), (parts[0] if parts else "")
    try:
        secs = float(v.strip() or 3)
    except ValueError:
        return send(chat, "Usage: /thumb 4.5 (seconds into the final video)")
    rel = youtube.extract_thumbnail(db.get_project(pid), secs)
    send_file(chat, agent.project_root(db.get_project(pid)) / rel, f"✓ Thumbnail set from {secs}s", kind="photo")


def cmd_upload(chat, args):
    confirm_upload(chat, resolve_pid(chat, args.strip() or None))


def cmd_ideas(chat, args):
    rows = db.q("SELECT * FROM ideas WHERE status!='published' ORDER BY COALESCE(publish_date,'9999'), id DESC LIMIT 40")
    if not rows:
        return send(chat, "No ideas yet. /idea Title | notes, or /brainstorm a theme")
    groups = {}
    for i in rows:
        groups.setdefault(i["status"], []).append(i)
    names = {"idea": "💡 Ideas", "research": "🔎 Research", "production": "🎞 In production", "scheduled": "📅 Scheduled"}
    text = []
    for k in ("idea", "research", "production", "scheduled"):
        if groups.get(k):
            text.append(f"<b>{names[k]}</b>\n" + "\n".join(
                f"#{i['id']} {e(i['title'])}" + (f" · 📅 {i['publish_date']}" if i.get("publish_date") else "")
                + (f" · film #{i['project_id']}" if i.get("project_id") else "") for i in groups[k]))
    makeable = [i for i in rows if not i.get("project_id")][:6]
    send(chat, "\n\n".join(text) + "\n\n/makefilm &lt;id&gt; · /plan &lt;id&gt; YYYY-MM-DD",
         kb(*[[btn(f"🎞 Make #{i['id']}", f"mk:{i['id']}") for i in makeable[j:j + 3]] for j in range(0, len(makeable), 3)]))


def cmd_idea(chat, args):
    if not args.strip():
        return send(chat, "Usage: /idea Title | notes")
    title, _, notes = args.partition("|")
    iid = db.x("INSERT INTO ideas(title, notes, status, created) VALUES(?,?,?,?)",
               (title.strip(), notes.strip(), "idea", time.time()))
    send(chat, f"💡 Idea #{iid} saved.", kb([btn("🎞 Make film now", f"mk:{iid}")]))


def cmd_brainstorm(chat, args):
    send(chat, "✨ Brainstorming…")
    channel = db.get_setting("channel", {}) or {}
    existing = [i["title"] for i in db.q("SELECT title FROM ideas")]
    data = llm.complete_json(f"""Suggest 8 documentary video ideas for a YouTube channel.
Channel: {channel.get('name') or ''}. Style/audience: {channel.get('style') or ''}.
Theme: {args.strip() or '(open)'}.
Short narrated cinematic documentaries built from public-domain archive photos, maps and documents.
Avoid: {existing[:60]}
Return JSON: {{"ideas": [{{"title": "...", "notes": "hook, angle, key archive visuals"}}]}}""")
    made = []
    for it in (data.get("ideas") or [])[:8]:
        if it.get("title"):
            iid = db.x("INSERT INTO ideas(title, notes, status, created) VALUES(?,?,?,?)",
                       (it["title"], it.get("notes") or "", "idea", time.time()))
            made.append((iid, it))
    send(chat, "💡 <b>New ideas</b>\n\n" + "\n\n".join(f"<b>#{i} {e(it['title'])}</b>\n{e(it.get('notes', ''))[:300]}"
                                                      for i, it in made),
         kb(*[[btn(f"🎞 Make #{i}", f"mk:{i}") for i, _ in made[j:j + 4]] for j in range(0, len(made), 4)]))


def cmd_makefilm(chat, args):
    if not args.strip().lstrip("#").isdigit():
        return send(chat, "Usage: /makefilm <idea id> (see /ideas)")
    p = services.make_film_from_idea(int(args.strip().lstrip("#")))
    set_chat(chat, active=p["id"])
    send(chat, f"🎬 Film <b>#{p['id']} {e(p['title'])}</b> created and the agent is working. It's your active film.")


def cmd_plan(chat, args):
    parts = args.split()
    if len(parts) != 2 or not parts[0].lstrip("#").isdigit() or not re.match(r"^\d{4}-\d{2}-\d{2}$", parts[1]):
        return send(chat, "Usage: /plan <idea id> 2026-12-10")
    db.x("UPDATE ideas SET publish_date=? WHERE id=?", (parts[1], int(parts[0].lstrip("#"))))
    send(chat, f"📅 Idea #{parts[0].lstrip('#')} planned for {parts[1]}.")


def cmd_calendar(chat, args):
    today = datetime.now(tzinfo()).date()
    until = today + timedelta(days=60)
    items = []
    for i in db.q("SELECT * FROM ideas WHERE publish_date IS NOT NULL"):
        try:
            d = datetime.strptime(i["publish_date"], "%Y-%m-%d").date()
        except ValueError:
            continue
        if today - timedelta(days=1) <= d <= until:
            items.append((d, None, f"💡 #{i['id']} {e(i['title'])} ({e(i['status'])})"))
    for u in db.q("""SELECT m.*, p.title FROM metadata m JOIN projects p ON p.id=m.project_id
                     WHERE m.publish_at IS NOT NULL AND m.publish_at!=''"""):
        try:
            dt = datetime.fromisoformat(u["publish_at"].replace("Z", "+00:00")).astimezone(tzinfo())
        except ValueError:
            continue
        if today - timedelta(days=1) <= dt.date() <= until:
            items.append((dt.date(), dt.strftime("%H:%M"), f"▶️ film #{u['project_id']} {e(u['title'])}"
                          + (" · uploaded" if u.get("youtube_id") else " · not uploaded yet")))
    if not items:
        return send(chat, "📅 Nothing planned in the next 60 days. Use /plan or /schedule.")
    items.sort(key=lambda x: (x[0], x[1] or ""))
    send(chat, "📅 <b>Next 60 days</b>\n" + "\n".join(
        f"<b>{d.strftime('%a %d %b')}</b>{(' ' + t) if t else ''}: {s}" for d, t, s in items))


def cmd_models(chat, args):
    saved = db.get_setting("providers", {}) or {}
    prov, model = llm.default_provider_model()
    lines = ["🤖 <b>AI providers</b>"]
    for k, v in llm.PROVIDERS.items():
        c = saved.get(k) or {}
        ok = bool(c.get("api_key")) or (k == "custom" and c.get("base_url"))
        lines.append(f"{'✅' if ok else '▫️'} <code>{k}</code> {e(v['label'])}" + (f" · {e(c.get('model'))}" if c.get("model") else ""))
    lines.append(f"\nDefault: <b>{e(prov or 'not set')}</b> {e(model or '')}")
    lines.append("Add keys in the web app (Settings → AI models).")
    send(chat, "\n".join(lines))


def cmd_model(chat, args):
    parts = args.split()
    if not parts:
        pid = resolve_pid(chat)
        p = db.get_project(pid)
        prov, model = llm.default_provider_model()
        return send(chat, f"#{pid} uses <b>{e(p.get('provider') or prov or 'default')}</b> "
                          f"{e(p.get('model') or '(provider default)')}\n"
                          f"Change: <code>/model openrouter some/model</code> · default: <code>/model default anthropic claude-sonnet-5-5</code>")
    if parts[0] == "default":
        if len(parts) < 2 or parts[1] not in llm.PROVIDERS:
            return send(chat, "Usage: /model default <provider> [model]")
        db.set_setting("default_llm", {"provider": parts[1], "model": parts[2] if len(parts) > 2 else ""})
        return send(chat, f"✓ Default AI: {e(parts[1])} {e(parts[2] if len(parts) > 2 else '')}")
    pid, rest = split_pid(chat, args)
    rp = rest.split()
    if not rp or rp[0] not in llm.PROVIDERS:
        return send(chat, "Usage: /model <provider> [model]. Providers: " + ", ".join(llm.PROVIDERS))
    db.update_project(pid, provider=rp[0], model=rp[1] if len(rp) > 1 else None)
    send(chat, f"✓ #{pid} now uses {e(rp[0])} {e(rp[1] if len(rp) > 1 else '(provider default)')}. "
               f"It applies the next time the agent starts (/stop then /resume to switch now).")


def cmd_use(chat, args):
    pid = resolve_pid(chat, args.strip())
    set_chat(chat, active=pid)
    send(chat, f"📌 Active film is now #{pid}.")
    film_card(chat, pid)


HANDLERS = {
    "films": cmd_films, "film": lambda c, a: film_card(c, resolve_pid(c, a.strip() or None)), "new": cmd_new,
    "use": cmd_use, "status": cmd_status, "approve": cmd_approve,
    "changes": lambda c, a: cmd_approve(c, a, approved=False), "say": cmd_say, "resume": cmd_resume,
    "start_agent": cmd_resume, "stop": cmd_stop, "log": cmd_log, "files": cmd_files, "get": cmd_get,
    "video": cmd_video, "stills": cmd_stills, "meta": cmd_meta, "title": cmd_title, "tags": cmd_tags,
    "privacy": cmd_privacy, "schedule": cmd_schedule, "thumb": cmd_thumb, "upload": cmd_upload,
    "ideas": cmd_ideas, "idea": cmd_idea, "brainstorm": cmd_brainstorm, "makefilm": cmd_makefilm,
    "plan": cmd_plan, "calendar": cmd_calendar, "models": cmd_models, "model": cmd_model,
    "help": lambda c, a: send(c, HELP),
}


# ---------------------------------------------------------------- update routing
def handle_update(u):
    if "callback_query" in u:
        return handle_callback(u["callback_query"])
    msg = u.get("message")
    if not msg:
        return
    chat = msg["chat"]["id"]
    user = msg.get("from") or {}
    text = (msg.get("text") or "").strip()

    if user.get("id") not in allowed_ids():
        m = re.match(r"^/start(?:@\w+)?\s+(\S+)", text)
        if m and m.group(1) == pair_code():
            c = cfg()
            c.setdefault("allowed", []).append({"id": user["id"], "name": " ".join(
                x for x in (user.get("first_name"), user.get("last_name")) if x) or user.get("username") or str(user["id"])})
            c["pair_code"] = secrets.token_hex(4)  # one-time code
            save_cfg(c)
            send(chat, "✅ Paired! This chat now controls Documentary Studio and gets notifications.\n\n" + HELP)
            return
        send(chat, f"🔒 This bot is private. To pair, open the web app → Settings → Telegram and use the pairing "
                   f"link or send <code>/start CODE</code>. Your Telegram user ID is <code>{user.get('id')}</code>.")
        return

    try:
        if text.startswith("/"):
            cmd, _, args = text[1:].partition(" ")
            cmd = cmd.split("@")[0].lower()
            if cmd == "start":
                return send(chat, HELP)
            if cmd != "changes":
                set_chat(chat, wait=None)
            h = HANDLERS.get(cmd)
            if not h:
                return send(chat, "Unknown command. /help")
            return h(chat, args)
        if any(k in msg for k in ("photo", "document", "audio", "voice", "video")):
            return handle_media(chat, msg)
        if text:
            wait = chat_state(chat).get("wait") or {}
            if wait.get("kind") == "new":
                set_chat(chat, wait=None)
                return cmd_new(chat, text)
            if wait.get("kind") == "feedback":
                set_chat(chat, wait=None)
                r = agent.respond_approval(wait["pid"], False, text)
                return send(chat, f"✎ Changes sent to #{wait['pid']}: agent {e(r)}.")
            return cmd_say(chat, text)
    except (ValueError, RuntimeError, llm.LLMError) as ex:
        send(chat, f"⚠️ {e(ex)}")


def handle_media(chat, msg):
    pid = resolve_pid(chat)
    p = db.get_project(pid)
    caption = (msg.get("caption") or "").strip()
    if "photo" in msg:
        obj, name = msg["photo"][-1], f"photo_{msg['message_id']}.jpg"
    elif "document" in msg:
        obj = msg["document"]
        name = obj.get("file_name") or f"file_{msg['message_id']}"
    elif "audio" in msg:
        obj = msg["audio"]
        name = obj.get("file_name") or f"audio_{msg['message_id']}.mp3"
    elif "voice" in msg:
        obj, name = msg["voice"], f"voice_{msg['message_id']}.ogg"
    else:
        obj = msg["video"]
        name = obj.get("file_name") or f"video_{msg['message_id']}.mp4"
    if (obj.get("file_size") or 0) > MAX_GET:
        return send(chat, "That file is over Telegram's 20 MB bot download limit. Upload it in the web app instead.")
    up = agent.project_root(p) / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    dest = up / services.safe_filename(name)
    _bot.download(obj["file_id"], dest)
    saved = [f"uploads/{dest.name}"]
    if dest.suffix.lower() == ".ogg":
        wav = dest.with_suffix(".wav")
        try:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(dest), str(wav)], check=True)
            saved = [f"uploads/{wav.name}"]
            dest.unlink()
        except Exception:
            pass
    if caption.lower().startswith("thumb") and dest.suffix.lower() in (".jpg", ".jpeg", ".png"):
        youtube.save_meta(pid, {"thumbnail_path": saved[0]})
        return send(chat, f"🖼 Thumbnail for #{pid} set.")
    services.notify_uploads(pid, saved, caption)
    send(chat, f"📥 Saved <code>{e(saved[0])}</code> to #{pid} and told the agent.")


def handle_callback(q):
    user = q.get("from") or {}
    chat = (q.get("message") or {}).get("chat", {}).get("id") or user.get("id")
    try:
        _bot.call("answerCallbackQuery", callback_query_id=q["id"])
    except Exception:
        pass
    if user.get("id") not in allowed_ids():
        return
    data = q.get("data") or ""
    kind, _, rest = data.partition(":")
    try:
        if kind == "mk":
            return cmd_makefilm(chat, rest)
        pid = int(rest.split(":")[0]) if rest else None
        if pid and not db.get_project(pid):
            return send(chat, "That film no longer exists.")
        arg = rest.split(":")[1] if ":" in rest else ""
        if kind == "f":
            film_card(chat, pid)
        elif kind == "use":
            cmd_use(chat, str(pid))
        elif kind == "go":
            cmd_resume(chat, str(pid))
        elif kind == "st":
            cmd_stop(chat, str(pid))
        elif kind == "lg":
            send(chat, f"📜 <b>#{pid} activity</b>\n" + log_text(pid))
        elif kind == "fl":
            cmd_files(chat, str(pid))
        elif kind == "vd":
            cmd_video(chat, str(pid))
        elif kind == "sl":
            cmd_stills(chat, str(pid))
        elif kind == "md":
            show_meta(chat, pid)
        elif kind == "mg":
            show_meta(chat, pid, regenerate=True)
        elif kind == "tt":
            opts = youtube.get_meta(pid).get("title_options") or []
            if arg.isdigit() and int(arg) < len(opts):
                youtube.save_meta(pid, {"title": opts[int(arg)]})
                send(chat, f"✓ Title: <b>{e(opts[int(arg)])}</b>")
        elif kind == "pv":
            cmd_privacy(chat, f"{pid} {arg}")
        elif kind == "up":
            confirm_upload(chat, pid)
        elif kind == "upok":
            youtube.access_token()
            if youtube.start_upload(db.get_project(pid)):
                send(chat, f"⬆️ Uploading #{pid}… I'll tell you when it's on YouTube.")
            else:
                send(chat, "An upload is already running.")
        elif kind == "ap":
            if arg == "y":
                cmd_approve(chat, str(pid), approved=True)
            else:
                cmd_approve(chat, str(pid), approved=False)
        elif kind == "x":
            send(chat, "Cancelled.")
    except (ValueError, RuntimeError, llm.LLMError) as ex:
        send(chat, f"⚠️ {e(ex)}")


# ---------------------------------------------------------------- notifications
def _project_line(pid):
    p = db.get_project(pid)
    return f"#{pid} {e(p['title'])}" if p else f"#{pid}"


def notify_event(ev):
    pid, kind = ev["project_id"], ev["kind"]
    p = db.get_project(pid)
    if not p:
        return
    meta = json.loads(ev["meta"]) if ev.get("meta") else {}
    level = cfg().get("notify") or "important"
    root = agent.project_root(p)
    for chat in allowed_ids():
        try:
            if kind == "approval":
                send(chat, f"✋ <b>{_project_line(pid)}: needs your approval</b>\n\n<b>{e(meta.get('title'))}</b>\n\n"
                           f"{md_to_html(meta.get('summary'))}\n\nReply with a message to request changes, or tap a button.",
                     kb([btn("✓ Approve & continue", f"ap:{pid}:y"), btn("✎ Request changes", f"ap:{pid}:n")],
                        app_link_row(pid)))
                files = []
                for rel in (meta.get("files") or [])[:12]:
                    try:
                        f = agent.safe_path(p, rel)
                        if f.is_file():
                            files.append(f)
                    except ValueError:
                        pass
                imgs = [f for f in files if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")]
                if imgs:
                    send_images(chat, imgs)
                for f in files:
                    if f not in imgs:
                        send_file(chat, f, kind="video" if f.suffix.lower() in (".mp4", ".mov") else "document")
                set_chat(chat, active=pid)
            elif kind == "done":
                send(chat, f"🎬 <b>{_project_line(pid)} is finished!</b>\n\n{md_to_html(ev['text'], 1500)}",
                     kb([btn("📝 Metadata", f"md:{pid}"), btn("⬆ Upload to YouTube", f"up:{pid}")], app_link_row(pid)))
                if p.get("final_video") and (root / p["final_video"]).exists():
                    send_file(chat, root / p["final_video"], f"#{pid} {e(p['title'])}")
            elif kind == "error":
                send(chat, f"⚠️ <b>{_project_line(pid)}</b>\n<pre>{e((ev['text'] or '')[:1200])}</pre>",
                     kb([btn("▶ Retry / resume", f"go:{pid}"), btn("📜 Log", f"lg:{pid}")]))
            elif kind == "stage":
                send(chat, f"▸ {_project_line(pid)} → <b>{e(ev['text'])}</b> stage")
            elif kind == "system" and (ev["text"] or "").startswith("Uploaded to YouTube"):
                send(chat, f"✅ {_project_line(pid)}: {e(ev['text'])}")
            elif kind == "assistant" and level == "all":
                send(chat, f"🤖 {_project_line(pid)}\n{md_to_html(ev['text'], 2500)}")
        except Exception as ex:
            STATUS["error"] = f"notify: {ex}"


def notify_waiting(pid):
    """Agent finished a run without calling a tool: it's probably asking you something."""
    if (cfg().get("notify") or "important") == "all":
        return  # assistant messages were already forwarded
    last = db.q("SELECT text FROM events WHERE project_id=? AND kind='assistant' ORDER BY id DESC LIMIT 1", (pid,), one=True)
    text = md_to_html((last or {}).get("text") or "The agent paused.", 2500)
    for chat in allowed_ids():
        try:
            send(chat, f"💬 <b>{_project_line(pid)}: agent is waiting for you</b>\n\n{text}\n\nReply to answer.",
                 kb([btn("▶ Continue", f"go:{pid}"), btn("📜 Log", f"lg:{pid}")]))
            set_chat(chat, active=pid)
        except Exception:
            pass


def _notify_loop():
    prev_status = None
    while True:
        try:
            if not _bot:
                time.sleep(3)
                continue
            st = state()
            last = st.get("last_event")
            if last is None:
                last = (db.q("SELECT MAX(id) AS m FROM events", one=True) or {}).get("m") or 0
                update_state(lambda s: s.__setitem__("last_event", last))
            rows = db.q("SELECT * FROM events WHERE id>? ORDER BY id LIMIT 50", (last,))
            for ev in rows:
                notify_event(ev)
                last = ev["id"]
            if rows:
                update_state(lambda s: s.__setitem__("last_event", last))
            cur = {p["id"]: ("running" if agent.is_running(p["id"]) else p["status"])
                   for p in db.q("SELECT id, status FROM projects")}
            if prev_status is not None:
                for pid, s in cur.items():
                    if s == "idle" and prev_status.get(pid) == "running":
                        notify_waiting(pid)
            prev_status = cur
        except Exception as ex:
            STATUS["error"] = f"notify loop: {ex}"
        time.sleep(3)


# ---------------------------------------------------------------- polling loop
def _poll_loop():
    global _bot
    token_seen = None
    while True:
        c = cfg()
        tok = (c.get("bot_token") or "").strip()
        if not c.get("enabled") or not tok:
            _bot, token_seen = None, None
            STATUS.update(running=False, username=None)
            time.sleep(5)
            continue
        if tok != token_seen:
            try:
                bot = TG(tok)
                me = bot.call("getMe")
                bot.call("deleteWebhook")
                bot.call("setMyCommands", commands=[{"command": k, "description": d} for k, d in COMMANDS])
                _bot, token_seen = bot, tok
                STATUS.update(running=True, username=me.get("username"), error=None)
            except Exception as ex:
                STATUS.update(running=False, error=f"Could not start bot: {ex}")
                time.sleep(30)
                continue
        try:
            updates = _bot.call("getUpdates", http_timeout=40, offset=state().get("offset"), timeout=25,
                                allowed_updates=["message", "callback_query"])
        except Exception as ex:
            if "Conflict" in str(ex):
                STATUS["error"] = "Another program is using this bot token (getUpdates conflict)."
            time.sleep(5)
            continue
        for u in updates:
            update_state(lambda s, uid=u["update_id"]: s.__setitem__("offset", uid + 1))
            _pool.submit(_safe_handle, u)


def _safe_handle(u):
    try:
        handle_update(u)
    except Exception as ex:
        STATUS["error"] = f"{type(ex).__name__}: {ex}"
        traceback.print_exc()
        chat = ((u.get("message") or {}).get("chat") or {}).get("id") or \
            ((u.get("callback_query") or {}).get("from") or {}).get("id")
        if chat and (((u.get("message") or {}).get("from") or (u.get("callback_query") or {}).get("from") or {})
                     .get("id") in allowed_ids()):
            try:
                send(chat, f"⚠️ Something went wrong: {e(ex)}")
            except Exception:
                pass


def start():
    """Start the bot threads once per server (a file lock stops a second process from polling too)."""
    global _started, _lockf
    if _started or os.environ.get("TELEGRAM_DISABLED") == "1":
        return
    try:
        import fcntl
        _lockf = open(DATA_DIR / "telegram.lock", "w")
        fcntl.flock(_lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        return  # another worker owns the bot
    _started = True
    threading.Thread(target=_poll_loop, daemon=True, name="tg-poll").start()
    threading.Thread(target=_notify_loop, daemon=True, name="tg-notify").start()


def send_test():
    if not _bot:
        raise RuntimeError("Bot is not running. Save a valid token and enable it first.")
    if not allowed_ids():
        raise RuntimeError("No Telegram account is paired yet.")
    broadcast("👋 Test message from Documentary Studio. Notifications are working.")
