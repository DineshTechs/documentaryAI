"""Shared actions used by both the web API and the Telegram bot."""
import re
import time

from . import agent, db


def slugify(s):
    base = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "film"
    slug, i = base, 2
    while db.q("SELECT 1 FROM projects WHERE slug=?", (slug,), one=True):
        slug, i = f"{base}-{i}", i + 1
    return slug


def create_project(b, autostart=False):
    title = (b.get("title") or "").strip()
    if not title:
        raise ValueError("Title is required")
    now = time.time()
    pid = db.x("""INSERT INTO projects(title, slug, topic, brief, duration_s, look, aspect, provider, model, idea_id,
                  created, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
               (title, slugify(title), b.get("topic") or title, b.get("brief") or "", int(b.get("duration_s") or 90),
                b.get("look") or "auto", b.get("aspect") or "16:9", b.get("provider") or None,
                b.get("model") or None, b.get("idea_id"), now, now))
    p = db.get_project(pid)
    (agent.project_root(p) / "uploads").mkdir(parents=True, exist_ok=True)
    db.add_event(pid, "system", "Project created")
    if b.get("idea_id"):
        db.x("UPDATE ideas SET project_id=?, status='production' WHERE id=?", (pid, b["idea_id"]))
    if autostart:
        agent.kickoff(pid)
    return db.get_project(pid)


def start_or_resume(pid):
    p = db.get_project(pid)
    if p["status"] == "awaiting_approval":
        raise ValueError("Waiting for your approval - approve or request changes first.")
    if agent.is_running(pid):
        return "already running"
    if not db.get_messages(pid):
        agent.kickoff(pid)
        return "started"
    db.add_message(pid, {"role": "user", "text": "Continue where you left off."})
    db.add_event(pid, "user", "Continue")
    agent.start(pid)
    return "resumed"


def notify_uploads(pid, saved, caption=""):
    """Tell the agent about files the user uploaded (never counts as an approval answer)."""
    if not saved:
        return
    db.add_event(pid, "system", "Uploaded: " + ", ".join(saved) + (f" ({caption})" if caption else ""))
    note = ("The user uploaded these files: " + ", ".join(saved) +
            ". Use them where they fit (own photos, a recorded voice-over, music)." +
            (f" The user's note about them: {caption}" if caption else ""))
    if agent.is_running(pid):
        agent.RUNNERS[pid].inbox.append(note)
    else:
        db.add_message(pid, {"role": "user", "text": note})


def make_film_from_idea(iid, autostart=True):
    idea = db.q("SELECT * FROM ideas WHERE id=?", (iid,), one=True)
    if not idea:
        raise ValueError("Idea not found")
    if idea.get("project_id") and db.get_project(idea["project_id"]):
        return db.get_project(idea["project_id"])
    return create_project({"title": idea["title"], "topic": idea.get("notes") or idea["title"], "idea_id": iid},
                          autostart=autostart)


def safe_filename(name):
    return re.sub(r"[^\w.\- ]+", "_", name or "file")
