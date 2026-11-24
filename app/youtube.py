"""YouTube: OAuth, resumable video upload, captions, thumbnails, and AI metadata."""
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

import requests

from . import db, llm
from .agent import project_root
from .config import BASE_URL

SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.force-ssl"]
REDIRECT_PATH = "/oauth/youtube/callback"

CATEGORIES = {"27": "Education", "22": "People & Blogs", "24": "Entertainment", "25": "News & Politics",
              "28": "Science & Technology", "19": "Travel & Events", "1": "Film & Animation", "17": "Sports"}


def redirect_uri():
    return BASE_URL + REDIRECT_PATH


def creds():
    return db.get_setting("youtube", {}) or {}


def auth_url(state):
    c = creds()
    if not c.get("client_id"):
        raise RuntimeError("Add your Google OAuth client ID and secret in Settings first.")
    params = {"client_id": c["client_id"], "redirect_uri": redirect_uri(), "response_type": "code",
              "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
              "include_granted_scopes": "true", "state": state}
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


def exchange_code(code):
    c = creds()
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "code": code, "client_id": c["client_id"], "client_secret": c["client_secret"],
        "redirect_uri": redirect_uri(), "grant_type": "authorization_code"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"Token exchange failed: {r.text[:400]}")
    tok = r.json()
    c["refresh_token"] = tok.get("refresh_token") or c.get("refresh_token")
    c["access_token"] = tok["access_token"]
    c["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    db.set_setting("youtube", c)
    try:
        info = requests.get("https://www.googleapis.com/youtube/v3/channels", params={"part": "snippet", "mine": "true"},
                            headers={"authorization": f"Bearer {c['access_token']}"}, timeout=30).json()
        item = (info.get("items") or [{}])[0]
        c["channel_title"] = item.get("snippet", {}).get("title")
        c["channel_id"] = item.get("id")
        db.set_setting("youtube", c)
    except Exception:
        pass


def access_token():
    c = creds()
    if c.get("access_token") and c.get("expires_at", 0) > time.time():
        return c["access_token"]
    if not c.get("refresh_token"):
        raise RuntimeError("YouTube is not connected. Connect your channel in Settings.")
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": c["client_id"], "client_secret": c["client_secret"],
        "refresh_token": c["refresh_token"], "grant_type": "refresh_token"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"Could not refresh YouTube token (reconnect in Settings): {r.text[:300]}")
    tok = r.json()
    c["access_token"] = tok["access_token"]
    c["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    db.set_setting("youtube", c)
    return c["access_token"]


def disconnect():
    c = creds()
    for k in ("refresh_token", "access_token", "expires_at", "channel_title", "channel_id"):
        c.pop(k, None)
    db.set_setting("youtube", c)


# ---------------------------------------------------------------- metadata
def get_meta(pid):
    m = db.q("SELECT * FROM metadata WHERE project_id=?", (pid,), one=True)
    if not m:
        db.x("INSERT INTO metadata(project_id) VALUES(?)", (pid,))
        m = db.q("SELECT * FROM metadata WHERE project_id=?", (pid,), one=True)
    for k in ("tags", "chapters", "title_options", "thumbnail_ideas"):
        try:
            m[k] = json.loads(m[k]) if m.get(k) else []
        except Exception:
            m[k] = []
    return m


def save_meta(pid, data):
    get_meta(pid)
    allowed = ["title", "description", "tags", "chapters", "title_options", "thumbnail_ideas", "category_id",
               "privacy", "publish_at", "language", "thumbnail_path"]
    fields = {}
    for k in allowed:
        if k in data:
            v = data[k]
            fields[k] = json.dumps(v) if isinstance(v, (list, dict)) else v
    if fields:
        db.x(f"UPDATE metadata SET {', '.join(f'{k}=?' for k in fields)} WHERE project_id=?",
             (*fields.values(), pid))
    return get_meta(pid)


def _read_if(path: Path, n=15000):
    try:
        return path.read_text(errors="replace")[:n]
    except Exception:
        return ""


def gather_context(p):
    root = project_root(p)
    parts = []
    texts = sorted([f for f in root.rglob("*") if f.suffix.lower() in (".md", ".txt", ".srt", ".json")
                    and f.stat().st_size < 400_000 and "uploads" not in f.parts and "node_modules" not in f.parts],
                   key=lambda f: (0 if re.search(r"script|beat|chapter|srt|credit", f.name, re.I) else 1, f.name))
    budget = 45000
    for f in texts[:25]:
        t = _read_if(f, 12000)
        if not t.strip():
            continue
        parts.append(f"--- {f.relative_to(root)} ---\n{t}")
        budget -= len(t)
        if budget <= 0:
            break
    return "\n\n".join(parts)


def generate_metadata(p):
    channel = db.get_setting("channel", {}) or {}
    ctx = gather_context(p)
    prompt = f"""Write YouTube metadata for a documentary video.

Channel: {channel.get('name') or ''}
Channel style / audience: {channel.get('style') or ''}
Default description footer: {channel.get('footer') or ''}
Language: {channel.get('language') or 'English'}
Video title (working): {p['title']}
Topic: {p.get('topic') or ''}

Project files (script, beat table, captions, credits, chapters):
{ctx or '(no files yet - use the topic)'}

Return JSON only, with this shape:
{{
 "title_options": ["5 strong, honest, curiosity-driven titles under 70 characters"],
 "title": "the best of them",
 "description": "2-3 hook paragraphs, then a CHAPTERS block (one 'M:SS Label' per line, first 0:00), then a SOURCES & IMAGE CREDITS block built from credits.md (keep every attribution and licence), then the footer. No hashtag spam; at most 3 hashtags at the very end.",
 "tags": ["15-25 search tags"],
 "chapters": [{{"time": "0:00", "label": "..."}}],
 "thumbnail_ideas": ["4 thumbnail concepts: image + 2-4 word overlay text"]
}}
Use the real narration timing (SRT or chapters.txt) for chapters when available. Never invent facts that are not in the script."""
    data = llm.complete_json(prompt)
    return save_meta(p["id"], {k: data.get(k) for k in
                               ("title", "description", "tags", "chapters", "title_options", "thumbnail_ideas")
                               if data.get(k) is not None})


def extract_thumbnail(p, seconds):
    root = project_root(p)
    video = root / (p.get("final_video") or "film/out/final.mp4")
    if not video.exists():
        raise RuntimeError("No final video yet.")
    out = root / "uploads" / f"thumb_{int(float(seconds) * 10)}.jpg"
    out.parent.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(seconds), "-i", str(video),
                    "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "2", str(out)], check=True)
    if not out.exists():
        raise RuntimeError(f"No frame at {seconds}s. The time is probably past the end of the video.")
    rel = str(out.relative_to(root))
    save_meta(p["id"], {"thumbnail_path": rel})
    return rel


# ---------------------------------------------------------------- upload
_uploads = {}


def _set(pid, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    db.x(f"UPDATE metadata SET {sets} WHERE project_id=?", (*kw.values(), pid))


def start_upload(p):
    pid = p["id"]
    t = _uploads.get(pid)
    if t and t.is_alive():
        return False
    get_meta(pid)
    _set(pid, upload_status="starting", upload_progress=0, upload_error=None)
    t = threading.Thread(target=_upload, args=(p,), daemon=True)
    _uploads[pid] = t
    t.start()
    return True


def _upload(p):
    pid = p["id"]
    try:
        m = get_meta(pid)
        root = project_root(p)
        video = root / (p.get("final_video") or "")
        if not p.get("final_video") or not video.exists():
            raise RuntimeError("Final video file not found. Finish the film first.")
        if not m.get("title"):
            raise RuntimeError("Add a title (or generate metadata) first.")
        status = {"privacyStatus": m.get("privacy") or "private", "selfDeclaredMadeForKids": False,
                  "containsSyntheticMedia": False}
        if m.get("publish_at"):
            # Scheduled publishing requires privacy 'private' + publishAt (RFC 3339).
            status["privacyStatus"] = "private"
            status["publishAt"] = m["publish_at"]  # stored as UTC ISO-8601 by the UI
        body = {"snippet": {"title": m["title"][:100], "description": (m.get("description") or "")[:5000],
                            "tags": m.get("tags") or [], "categoryId": m.get("category_id") or "27",
                            "defaultLanguage": m.get("language") or "en",
                            "defaultAudioLanguage": m.get("language") or "en"},
                "status": status}
        size = video.stat().st_size
        tok = access_token()
        r = requests.post("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
                          headers={"authorization": f"Bearer {tok}", "content-type": "application/json; charset=UTF-8",
                                   "x-upload-content-type": "video/mp4", "x-upload-content-length": str(size)},
                          data=json.dumps(body), timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"YouTube rejected the upload: {r.text[:600]}")
        session = r.headers["Location"]
        _set(pid, upload_status="uploading")
        chunk = 8 * 1024 * 1024
        sent = 0
        video_id = None
        with open(video, "rb") as f:
            while sent < size:
                f.seek(sent)
                data = f.read(chunk)
                end = sent + len(data) - 1
                for attempt in range(6):
                    try:
                        rr = requests.put(session, data=data, timeout=600, headers={
                            "authorization": f"Bearer {access_token()}",
                            "content-range": f"bytes {sent}-{end}/{size}"})
                    except requests.RequestException:
                        time.sleep(2 ** attempt)
                        continue
                    if rr.status_code in (500, 502, 503, 504):
                        time.sleep(2 ** attempt)
                        continue
                    break
                else:
                    raise RuntimeError("Upload kept failing; try again.")
                if rr.status_code == 308:
                    rng = rr.headers.get("Range")
                    sent = int(rng.split("-")[1]) + 1 if rng else sent
                elif rr.status_code in (200, 201):
                    video_id = rr.json()["id"]
                    sent = size
                else:
                    raise RuntimeError(f"Upload error {rr.status_code}: {rr.text[:500]}")
                _set(pid, upload_progress=round(sent / size * 100, 1))
        _set(pid, youtube_id=video_id, upload_status="processing captions/thumbnail", upload_progress=100)
        notes = []
        srt = root / (p.get("final_srt") or "")
        if p.get("final_srt") and srt.exists():
            try:
                _upload_captions(video_id, srt, m.get("language") or "en")
                notes.append("captions added")
            except Exception as e:
                notes.append(f"captions failed: {e}")
        if m.get("thumbnail_path") and (root / m["thumbnail_path"]).exists():
            try:
                _upload_thumbnail(video_id, root / m["thumbnail_path"])
                notes.append("thumbnail set")
            except Exception as e:
                notes.append(f"thumbnail failed (channel must be verified for custom thumbnails): {e}")
        _set(pid, upload_status="done" + (f" ({'; '.join(notes)})" if notes else ""))
        if p.get("idea_id"):
            db.x("UPDATE ideas SET status=? WHERE id=?",
                 ("scheduled" if m.get("publish_at") or status["privacyStatus"] == "private" else "published",
                  p["idea_id"]))
        db.add_event(pid, "system", f"Uploaded to YouTube: https://youtu.be/{video_id}")
    except Exception as e:
        _set(pid, upload_status="error", upload_error=str(e)[:1000])
        db.add_event(pid, "error", f"YouTube upload failed: {str(e)[:800]}")


def _upload_captions(video_id, srt_path: Path, lang):
    boundary = "docstudio" + str(int(time.time()))
    meta = json.dumps({"snippet": {"videoId": video_id, "language": lang, "name": "", "isDraft": False}})
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
            f"--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + srt_path.read_bytes() + \
        f"\r\n--{boundary}--".encode()
    r = requests.post("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet",
                      headers={"authorization": f"Bearer {access_token()}",
                               "content-type": f"multipart/related; boundary={boundary}"}, data=body, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(r.text[:300])


def _upload_thumbnail(video_id, path: Path):
    ctype = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    r = requests.post(f"https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={video_id}&uploadType=media",
                      headers={"authorization": f"Bearer {access_token()}", "content-type": ctype},
                      data=path.read_bytes(), timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(r.text[:300])
