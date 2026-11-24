"""Documentary Studio - web app around the cinematic-skill film pipeline."""
import functools
import hmac
import json
import re
import secrets
import subprocess
import time
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, request, send_file, send_from_directory, session

from . import agent, db, llm, services, telegram_bot, tts, youtube
from .config import APP_PASSWORD, BASE_URL, PYTHON_BIN, SECRET_KEY, SKILL_DIR, SKILL_SCRIPTS

STATIC = Path(__file__).resolve().parent.parent / "static"

app = Flask(__name__, static_folder=None)
app.secret_key = SECRET_KEY
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=BASE_URL.startswith("https"), MAX_CONTENT_LENGTH=4 * 1024 ** 3,
                  PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30)

db.init()
# Agents don't survive a restart; mark them so the UI offers "Resume".
db.x("UPDATE projects SET status='stopped' WHERE status='running'")


# ---------------------------------------------------------------- auth
def logged_in():
    return not APP_PASSWORD or session.get("ok") is True


@app.before_request
def guard():
    open_paths = ("/api/login", "/api/health", "/login", "/static/", "/favicon")
    if request.path.startswith(open_paths) or request.path == "/":
        return None
    if request.path.startswith(("/api/", "/oauth/")) and not logged_in():
        return jsonify(error="Not logged in"), 401
    return None


@app.post("/api/login")
def login():
    pw = (request.json or {}).get("password", "")
    if APP_PASSWORD and hmac.compare_digest(pw, APP_PASSWORD):
        session.permanent = True
        session["ok"] = True
        return jsonify(ok=True)
    time.sleep(1)
    return jsonify(error="Wrong password"), 403


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/health")
def health():
    return jsonify(ok=True, logged_in=logged_in())


def err(msg, code=400):
    return jsonify(error=msg), code


def handle_errors(f):
    @functools.wraps(f)
    def w(*a, **k):
        try:
            return f(*a, **k)
        except (llm.LLMError, RuntimeError, ValueError) as e:
            return err(str(e))
    return w


# ---------------------------------------------------------------- static
@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/static/<path:p>")
def static_files(p):
    return send_from_directory(STATIC, p)


# ---------------------------------------------------------------- settings
SECRET_RE = re.compile(r"(key|secret|token)$", re.I)
MASK = "••••"


def _mask(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("access_token", "refresh_token", "expires_at"):
                continue
            if SECRET_RE.search(k) and isinstance(v, str) and v:
                out[k] = MASK + v[-4:]
            else:
                out[k] = _mask(v)
        return out
    return obj


def _merge(new, old):
    if isinstance(new, dict):
        old = old if isinstance(old, dict) else {}
        out = dict(old)
        for k, v in new.items():
            if isinstance(v, str) and v.startswith(MASK):
                continue  # unchanged secret
            out[k] = _merge(v, old.get(k))
        return out
    return new


SETTING_KEYS = ["providers", "default_llm", "tts", "youtube", "channel", "search", "telegram"]


@app.get("/api/settings")
def get_settings():
    data = {k: db.get_setting(k, {}) or {} for k in SETTING_KEYS}
    data["telegram"] = {k: v for k, v in data["telegram"].items() if k not in ("allowed", "pair_code")}
    yt = data["youtube"]
    data["youtube_status"] = {"connected": bool(yt.get("refresh_token")), "channel": yt.get("channel_title"),
                              "redirect_uri": youtube.redirect_uri()}
    return jsonify(_mask(data))


@app.put("/api/settings")
def put_settings():
    body = request.json or {}
    if isinstance(body.get("telegram"), dict):  # pairing data is managed by its own endpoints
        body["telegram"] = {k: v for k, v in body["telegram"].items() if k not in ("allowed", "pair_code")}
    for k in SETTING_KEYS:
        if k in body:
            db.set_setting(k, _merge(body[k], db.get_setting(k, {}) or {}))
    return get_settings()


@app.post("/api/settings/test-llm")
@handle_errors
def test_llm():
    b = request.json or {}
    out = llm.test_provider(b.get("provider"), b.get("model"))
    return jsonify(ok=True, reply=out)


@app.post("/api/settings/test-tts")
@handle_errors
def test_tts():
    out = Path(agent.PROJECTS_DIR) / "_tts_test.mp3"
    tts.synthesize("This is a test of the narration voice for your documentary.", out)
    return send_file(out, mimetype="audio/mpeg")


@app.get("/api/meta")
def meta():
    return jsonify(providers={k: {"label": v["label"], "base_url": v["base_url"], "model_hint": v["model_hint"]}
                              for k, v in llm.PROVIDERS.items()},
                   tts_providers=tts.TTS_PROVIDERS, categories=youtube.CATEGORIES,
                   skill_installed=(SKILL_DIR / "SKILL.md").exists(), stages=agent.STAGES)


@app.get("/api/setup-check")
def setup_check():
    script = SKILL_SCRIPTS / "check_setup.py"
    if not script.exists():
        return jsonify(ok=False, output=f"cinematic-skill not found at {SKILL_DIR}")
    try:
        r = subprocess.run([PYTHON_BIN, str(script)], capture_output=True, text=True, timeout=120, cwd=SKILL_SCRIPTS)
        return jsonify(ok=r.returncode == 0, output=(r.stdout + r.stderr)[-6000:])
    except Exception as e:
        return jsonify(ok=False, output=str(e))


# ---------------------------------------------------------------- projects
def project_or_404(pid):
    p = db.get_project(pid)
    if not p:
        abort(404)
    return p


def project_json(p):
    d = dict(p)
    d["pending"] = json.loads(p["pending"]) if p.get("pending") else None
    d["running"] = agent.is_running(p["id"])
    return d


@app.get("/api/projects")
def list_projects():
    rows = db.q("SELECT * FROM projects ORDER BY updated DESC")
    metas = {m["project_id"]: m for m in db.q("SELECT project_id, youtube_id, upload_status, publish_at FROM metadata")}
    out = []
    for p in rows:
        d = project_json(p)
        d["youtube"] = metas.get(p["id"])
        out.append(d)
    return jsonify(out)


@app.post("/api/projects")
@handle_errors
def create_project():
    b = request.json or {}
    p = services.create_project(b, autostart=bool(b.get("autostart")))
    return jsonify(project_json(p))


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    return jsonify(project_json(project_or_404(pid)))


@app.patch("/api/projects/<int:pid>")
def patch_project(pid):
    project_or_404(pid)
    b = request.json or {}
    allowed = {k: b[k] for k in ("title", "topic", "brief", "duration_s", "look", "aspect", "provider", "model",
                                 "final_video", "final_srt") if k in b}
    db.update_project(pid, **allowed)
    return jsonify(project_json(db.get_project(pid)))


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    p = project_or_404(pid)
    agent.stop(pid)
    if request.args.get("files") == "1":
        agent.delete_workspace(p)
    for t in ("events", "messages", "metadata"):
        db.x(f"DELETE FROM {t} WHERE project_id=?", (pid,))
    db.x("UPDATE ideas SET project_id=NULL WHERE project_id=?", (pid,))
    db.x("DELETE FROM projects WHERE id=?", (pid,))
    return jsonify(ok=True)


@app.post("/api/projects/<int:pid>/start")
@handle_errors
def start_project(pid):
    project_or_404(pid)
    services.start_or_resume(pid)
    return jsonify(project_json(db.get_project(pid)))


@app.post("/api/projects/<int:pid>/stop")
def stop_project(pid):
    project_or_404(pid)
    agent.stop(pid)
    return jsonify(ok=True)


@app.post("/api/projects/<int:pid>/message")
def message_project(pid):
    project_or_404(pid)
    text = ((request.json or {}).get("text") or "").strip()
    if not text:
        return err("Empty message")
    return jsonify(result=agent.send_user_message(pid, text))


@app.post("/api/projects/<int:pid>/approve")
def approve_project(pid):
    project_or_404(pid)
    b = request.json or {}
    return jsonify(result=agent.respond_approval(pid, bool(b.get("approved")), b.get("feedback", "")))


@app.post("/api/projects/<int:pid>/reset")
def reset_project(pid):
    project_or_404(pid)
    agent.reset_conversation(pid)
    return jsonify(ok=True)


@app.get("/api/projects/<int:pid>/events")
def project_events(pid):
    after = int(request.args.get("after") or 0)
    rows = db.q("SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT 500", (pid, after))
    for r in rows:
        r["meta"] = json.loads(r["meta"]) if r.get("meta") else None
    p = project_or_404(pid)
    return jsonify(events=rows, project=project_json(p), live=agent.live_output(pid))


# ---------------------------------------------------------------- files
MEDIA = {".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".srt": "text/plain",
         ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
         ".svg": "image/svg+xml", ".md": "text/plain", ".txt": "text/plain", ".json": "application/json",
         ".py": "text/plain", ".csv": "text/plain", ".mov": "video/quicktime", ".webm": "video/webm"}


@app.get("/api/projects/<int:pid>/files")
def list_files(pid):
    p = project_or_404(pid)
    root = agent.project_root(p)
    root.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(root.rglob("*")):
        rel = f.relative_to(root)
        if any(part.startswith(".") or part in ("__pycache__", "frames", "_frames", "cache") for part in rel.parts):
            continue
        if f.is_file():
            st = f.stat()
            out.append({"path": str(rel), "size": st.st_size, "mtime": st.st_mtime})
        if len(out) > 3000:
            break
    return jsonify(out)


@app.get("/api/projects/<int:pid>/raw")
def raw_file(pid):
    p = project_or_404(pid)
    try:
        path = agent.safe_path(p, request.args.get("path", ""))
    except ValueError:
        abort(403)
    if not path.is_file():
        abort(404)
    mt = MEDIA.get(path.suffix.lower(), "application/octet-stream")
    return send_file(path, mimetype=mt, conditional=True, as_attachment=request.args.get("dl") == "1",
                     download_name=path.name, max_age=0)


@app.put("/api/projects/<int:pid>/file")
@handle_errors
def save_file(pid):
    p = project_or_404(pid)
    b = request.json or {}
    path = agent.safe_path(p, b.get("path", ""), write=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(b.get("content", ""))
    db.add_event(pid, "system", f"You edited {b.get('path')}")
    return jsonify(ok=True)


@app.post("/api/projects/<int:pid>/upload")
@handle_errors
def upload_files(pid):
    p = project_or_404(pid)
    sub = (request.form.get("dir") or "uploads").strip("/")
    dest = agent.safe_path(p, sub, write=True)
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in request.files.getlist("files"):
        name = re.sub(r"[^\w.\- ]+", "_", Path(f.filename or "file").name)
        f.save(dest / name)
        saved.append(f"{sub}/{name}")
    services.notify_uploads(pid, saved)
    return jsonify(saved=saved)


# ---------------------------------------------------------------- metadata + youtube
@app.get("/api/projects/<int:pid>/metadata")
def get_metadata(pid):
    project_or_404(pid)
    return jsonify(youtube.get_meta(pid))


@app.put("/api/projects/<int:pid>/metadata")
def put_metadata(pid):
    project_or_404(pid)
    return jsonify(youtube.save_meta(pid, request.json or {}))


@app.post("/api/projects/<int:pid>/metadata/generate")
@handle_errors
def gen_metadata(pid):
    return jsonify(youtube.generate_metadata(project_or_404(pid)))


@app.post("/api/projects/<int:pid>/thumbnail")
@handle_errors
def thumbnail(pid):
    p = project_or_404(pid)
    if request.files.get("file"):
        f = request.files["file"]
        ext = Path(f.filename or "t.jpg").suffix.lower() or ".jpg"
        if ext not in (".jpg", ".jpeg", ".png"):
            raise ValueError("Thumbnail must be JPG or PNG")
        rel = f"uploads/thumbnail{ext}"
        f.save(agent.project_root(p) / rel)
        youtube.save_meta(pid, {"thumbnail_path": rel})
        return jsonify(path=rel)
    secs = float((request.json or {}).get("seconds") or 0)
    return jsonify(path=youtube.extract_thumbnail(p, secs))


@app.post("/api/projects/<int:pid>/youtube-upload")
@handle_errors
def yt_upload(pid):
    p = project_or_404(pid)
    youtube.access_token()  # fail fast if not connected
    if not youtube.start_upload(p):
        return err("An upload is already running")
    return jsonify(ok=True)


@app.get("/api/youtube/connect")
@handle_errors
def yt_connect():
    state = secrets.token_urlsafe(16)
    session["yt_state"] = state
    return jsonify(url=youtube.auth_url(state))


@app.get(youtube.REDIRECT_PATH)
def yt_callback():
    if request.args.get("state") != session.get("yt_state"):
        return "Invalid OAuth state. Go back to the app and try again.", 400
    if request.args.get("error"):
        return redirect("/#/settings?yt=" + request.args["error"])
    try:
        youtube.exchange_code(request.args.get("code"))
    except Exception as e:
        return f"YouTube connection failed: {e}", 400
    return redirect("/#/settings?yt=connected")


@app.post("/api/youtube/disconnect")
def yt_disconnect():
    youtube.disconnect()
    return jsonify(ok=True)


# ---------------------------------------------------------------- ideas + calendar
@app.get("/api/ideas")
def list_ideas():
    return jsonify(db.q("SELECT * FROM ideas ORDER BY COALESCE(publish_date,'9999'), id DESC"))


@app.post("/api/ideas")
@handle_errors
def create_idea():
    b = request.json or {}
    if not (b.get("title") or "").strip():
        raise ValueError("Title is required")
    iid = db.x("INSERT INTO ideas(title, notes, status, publish_date, created) VALUES(?,?,?,?,?)",
               (b["title"].strip(), b.get("notes") or "", b.get("status") or "idea", b.get("publish_date") or None,
                time.time()))
    return jsonify(db.q("SELECT * FROM ideas WHERE id=?", (iid,), one=True))


@app.patch("/api/ideas/<int:iid>")
def patch_idea(iid):
    b = request.json or {}
    fields = {k: b[k] for k in ("title", "notes", "status", "publish_date") if k in b}
    if fields:
        db.x(f"UPDATE ideas SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), iid))
    return jsonify(db.q("SELECT * FROM ideas WHERE id=?", (iid,), one=True))


@app.delete("/api/ideas/<int:iid>")
def delete_idea(iid):
    db.x("DELETE FROM ideas WHERE id=?", (iid,))
    return jsonify(ok=True)


@app.post("/api/ideas/brainstorm")
@handle_errors
def brainstorm():
    b = request.json or {}
    channel = db.get_setting("channel", {}) or {}
    existing = [i["title"] for i in db.q("SELECT title FROM ideas")]
    n = max(1, min(int(b.get("count") or 8), 20))
    data = llm.complete_json(f"""Suggest {n} documentary video ideas for a YouTube channel.
Channel: {channel.get('name') or ''}. Style/audience: {channel.get('style') or ''}.
Theme or direction from the creator: {b.get('theme') or '(open)'}.
Videos are short narrated cinematic documentaries (history, true crime, science, tech) made from public-domain
archive photos, maps and documents - favour stories with rich public-domain imagery on Wikimedia Commons.
Avoid these existing ideas: {existing[:60]}
Return JSON: {{"ideas": [{{"title": "...", "notes": "hook, angle, why it would perform, key archive visuals"}}]}}""")
    created = []
    for it in (data.get("ideas") or [])[:n]:
        if it.get("title"):
            iid = db.x("INSERT INTO ideas(title, notes, status, created) VALUES(?,?,?,?)",
                       (it["title"], it.get("notes") or "", "idea", time.time()))
            created.append(db.q("SELECT * FROM ideas WHERE id=?", (iid,), one=True))
    return jsonify(created)


@app.get("/api/calendar")
def calendar():
    ideas = db.q("SELECT id, title, status, publish_date, project_id FROM ideas WHERE publish_date IS NOT NULL")
    scheduled = db.q("""SELECT m.project_id, m.publish_at, m.youtube_id, m.upload_status, p.title FROM metadata m
                        JOIN projects p ON p.id=m.project_id WHERE m.publish_at IS NOT NULL AND m.publish_at != ''""")
    return jsonify(ideas=ideas, uploads=scheduled)


# ---------------------------------------------------------------- telegram
@app.get("/api/telegram")
def tg_status():
    return jsonify(telegram_bot.public_status())


@app.post("/api/telegram/pair-code")
def tg_new_code():
    telegram_bot.new_pair_code()
    return jsonify(telegram_bot.public_status())


@app.post("/api/telegram/remove")
def tg_remove():
    telegram_bot.remove_user((request.json or {}).get("id"))
    return jsonify(telegram_bot.public_status())


@app.post("/api/telegram/test")
@handle_errors
def tg_test():
    telegram_bot.send_test()
    return jsonify(ok=True)


telegram_bot.start()


@app.errorhandler(404)
def nf(_):
    if request.path.startswith("/api/"):
        return err("Not found", 404)
    return send_from_directory(STATIC, "index.html")
