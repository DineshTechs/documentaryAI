"""Tiny SQLite layer (stdlib only)."""
import json
import sqlite3
import threading
import time

from .config import DB_PATH

_local = threading.local()
_write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  topic TEXT,
  brief TEXT,
  duration_s INTEGER DEFAULT 90,
  look TEXT DEFAULT 'auto',
  aspect TEXT DEFAULT '16:9',
  provider TEXT,
  model TEXT,
  status TEXT DEFAULT 'new',        -- new | running | awaiting_approval | idle | done | error | stopped
  stage TEXT DEFAULT 'story',       -- story | voice | images | scene | review | render | done
  pending TEXT,                     -- JSON of pending approval
  final_video TEXT,
  final_srt TEXT,
  idea_id INTEGER,
  created REAL, updated REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,     -- assistant | tool | tool_result | user | system | error | approval
  text TEXT,
  meta TEXT,
  created REAL
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'idea',   -- idea | research | production | scheduled | published
  publish_date TEXT,            -- YYYY-MM-DD
  project_id INTEGER,
  created REAL
);
CREATE TABLE IF NOT EXISTS metadata (
  project_id INTEGER PRIMARY KEY,
  title TEXT, description TEXT, tags TEXT, chapters TEXT,
  title_options TEXT, thumbnail_ideas TEXT,
  category_id TEXT DEFAULT '27',
  privacy TEXT DEFAULT 'private',
  publish_at TEXT,
  language TEXT DEFAULT 'en',
  thumbnail_path TEXT,
  youtube_id TEXT,
  upload_status TEXT,
  upload_progress REAL DEFAULT 0,
  upload_error TEXT
);
CREATE INDEX IF NOT EXISTS ev_proj ON events(project_id, id);
CREATE INDEX IF NOT EXISTS msg_proj ON messages(project_id, id);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        _local.conn = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    c.commit()


def q(sql, args=(), one=False):
    cur = conn().execute(sql, args)
    rows = [dict(r) for r in cur.fetchall()]
    return (rows[0] if rows else None) if one else rows


def x(sql, args=()):
    with _write_lock:
        c = conn()
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid


# ---------- settings ----------
def get_setting(key, default=None):
    r = q("SELECT value FROM settings WHERE key=?", (key,), one=True)
    if not r:
        return default
    try:
        return json.loads(r["value"])
    except Exception:
        return r["value"]


def set_setting(key, value):
    x("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      (key, json.dumps(value)))


# ---------- events / messages ----------
def add_event(project_id, kind, text="", meta=None):
    return x("INSERT INTO events(project_id,kind,text,meta,created) VALUES(?,?,?,?,?)",
             (project_id, kind, text, json.dumps(meta) if meta is not None else None, time.time()))


def add_message(project_id, data):
    return x("INSERT INTO messages(project_id,data,created) VALUES(?,?,?)",
             (project_id, json.dumps(data), time.time()))


def get_messages(project_id):
    return [json.loads(r["data"]) for r in q("SELECT data FROM messages WHERE project_id=? ORDER BY id", (project_id,))]


def update_project(pid, **fields):
    if not fields:
        return
    fields["updated"] = time.time()
    keys = ", ".join(f"{k}=?" for k in fields)
    x(f"UPDATE projects SET {keys} WHERE id=?", (*fields.values(), pid))


def get_project(pid):
    return q("SELECT * FROM projects WHERE id=?", (pid,), one=True)
