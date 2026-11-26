'use strict';
// Storage in plain JSON files (no database to install). Writes are atomic (write temp file, then rename).
//   data/db.json                  settings, projects, ideas, metadata
//   data/messages/<id>.json       agent conversation per film
//   data/events/<id>.jsonl        activity feed per film (append-only)
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DB_FILE = path.join(DATA_DIR, 'db.json');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const EV_DIR = path.join(DATA_DIR, 'events');
fs.mkdirSync(MSG_DIR, { recursive: true });
fs.mkdirSync(EV_DIR, { recursive: true });

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

let db = { settings: {}, projects: [], ideas: [], metadata: {}, seq: { project: 0, idea: 0, event: 0 } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (_) { /* first run */ }
db.seq = { project: 0, idea: 0, event: 0, ...(db.seq || {}) };

let saveTimer = null;
function save(now = false) {
  if (now) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    atomicWrite(DB_FILE, JSON.stringify(db, null, 1));
    return;
  }
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; atomicWrite(DB_FILE, JSON.stringify(db, null, 1)); }, 150);
}
process.on('exit', () => { if (saveTimer) atomicWrite(DB_FILE, JSON.stringify(db, null, 1)); });

const now = () => Date.now() / 1000;

// ---------------------------------------------------------------- settings
const getSetting = (k, def = null) => (k in db.settings ? db.settings[k] : def);
function setSetting(k, v) { db.settings[k] = v; save(); }

// ---------------------------------------------------------------- projects
const projects = () => db.projects;
const getProject = (id) => db.projects.find((p) => p.id === Number(id)) || null;
function addProject(p) {
  const id = ++db.seq.project;
  const row = { id, status: 'new', stage: 'story', pending: null, final_video: null, final_srt: null, created: now(), updated: now(), ...p };
  db.projects.push(row);
  save();
  return row;
}
function updateProject(id, fields) {
  const p = getProject(id);
  if (!p) return null;
  Object.assign(p, fields, { updated: now() });
  save();
  return p;
}
function deleteProject(id) {
  db.projects = db.projects.filter((p) => p.id !== Number(id));
  delete db.metadata[id];
  for (const i of db.ideas) if (i.project_id === Number(id)) i.project_id = null;
  for (const f of [path.join(MSG_DIR, `${id}.json`), path.join(EV_DIR, `${id}.jsonl`)]) fs.rmSync(f, { force: true });
  save();
}

// ---------------------------------------------------------------- messages (agent memory)
const msgCache = new Map();
function getMessages(pid) {
  if (!msgCache.has(pid)) {
    let m = [];
    try { m = JSON.parse(fs.readFileSync(path.join(MSG_DIR, `${pid}.json`), 'utf8')); } catch (_) { /* none */ }
    msgCache.set(pid, m);
  }
  return msgCache.get(pid);
}
function addMessage(pid, msg) {
  const m = getMessages(pid);
  m.push(msg);
  atomicWrite(path.join(MSG_DIR, `${pid}.json`), JSON.stringify(m));
}
function clearMessages(pid) {
  msgCache.set(pid, []);
  fs.rmSync(path.join(MSG_DIR, `${pid}.json`), { force: true });
}

// ---------------------------------------------------------------- events (activity feed)
const evCache = new Map();
function getEvents(pid) {
  if (!evCache.has(pid)) {
    const list = [];
    try {
      for (const line of fs.readFileSync(path.join(EV_DIR, `${pid}.jsonl`), 'utf8').split('\n')) if (line) list.push(JSON.parse(line));
    } catch (_) { /* none */ }
    evCache.set(pid, list);
  }
  return evCache.get(pid);
}
const listeners = new Set();
function addEvent(pid, kind, text = '', meta = null) {
  const ev = { id: ++db.seq.event, project_id: Number(pid), kind, text: String(text ?? ''), meta, created: now() };
  getEvents(pid).push(ev);
  fs.appendFileSync(path.join(EV_DIR, `${pid}.jsonl`), JSON.stringify(ev) + '\n');
  save();
  for (const fn of listeners) { try { fn(ev); } catch (_) { /* listener errors don't matter */ } }
  return ev;
}
function eventsAfter(pid, after, limit = 500) {
  return getEvents(pid).filter((e) => e.id > after).slice(0, limit);
}
const onEvent = (fn) => listeners.add(fn);
const lastEventId = () => db.seq.event;

// ---------------------------------------------------------------- ideas
const ideas = () => db.ideas;
const getIdea = (id) => db.ideas.find((i) => i.id === Number(id)) || null;
function addIdea(i) {
  const row = { id: ++db.seq.idea, title: '', notes: '', status: 'idea', publish_date: null, project_id: null, created: now(), ...i };
  db.ideas.push(row);
  save();
  return row;
}
function updateIdea(id, fields) { const i = getIdea(id); if (i) { Object.assign(i, fields); save(); } return i; }
function deleteIdea(id) { db.ideas = db.ideas.filter((i) => i.id !== Number(id)); save(); }

// ---------------------------------------------------------------- YouTube metadata per film
function getMeta(pid) {
  if (!db.metadata[pid]) {
    db.metadata[pid] = { project_id: Number(pid), title: '', description: '', tags: [], chapters: [], title_options: [], thumbnail_ideas: [],
      category_id: '27', privacy: 'private', publish_at: '', language: 'en', thumbnail_path: null, youtube_id: null,
      upload_status: null, upload_progress: 0, upload_error: null };
    save();
  }
  return db.metadata[pid];
}
function saveMeta(pid, fields) { Object.assign(getMeta(pid), fields); save(); return getMeta(pid); }
const allMeta = () => Object.values(db.metadata);

module.exports = {
  save, getSetting, setSetting,
  projects, getProject, addProject, updateProject, deleteProject,
  getMessages, addMessage, clearMessages,
  addEvent, eventsAfter, onEvent, lastEventId, getEvents,
  ideas, getIdea, addIdea, updateIdea, deleteIdea,
  getMeta, saveMeta, allMeta,
};
