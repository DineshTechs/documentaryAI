'use strict';
// Storage. The app works on an in-memory copy (fast, simple) and saves every change in the background to:
//   - MongoDB, when MONGODB_URI is set (recommended for hosting), or
//   - JSON files in data/ (default, no setup):
//       data/db.json              settings, projects, ideas, metadata
//       data/messages/<id>.json   agent conversation per film
//       data/events/<id>.jsonl    activity feed per film
// Film media (images, audio, videos) always stay on disk in data/projects/.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DB_FILE = path.join(DATA_DIR, 'db.json');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const EV_DIR = path.join(DATA_DIR, 'events');
fs.mkdirSync(MSG_DIR, { recursive: true });
fs.mkdirSync(EV_DIR, { recursive: true });

const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB = process.env.MONGODB_DB || 'documentary_studio';
const now = () => Date.now() / 1000;

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- in-memory state
const blank = () => ({ settings: {}, projects: [], ideas: [], metadata: {}, seq: { project: 0, idea: 0, event: 0 } });
let db = blank();
const msgCache = new Map();   // pid -> messages[]
const evCache = new Map();    // pid -> events[]
let mode = 'file';            // 'file' | 'mongo'
let mongo = null;             // { client, db }
let dbStatus = { ok: true, backend: 'files', error: null };

function loadFiles() {
  try { db = { ...blank(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (_) { db = blank(); }
  db.seq = { project: 0, idea: 0, event: 0, ...(db.seq || {}) };
}
loadFiles();

// ---------------------------------------------------------------- persistence: files
let saveTimer = null;
function fileSave(nowFlag) {
  const write = () => atomicWrite(DB_FILE, JSON.stringify(db, null, 1));
  if (nowFlag) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } write(); return; }
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; write(); }, 150);
}
process.on('exit', () => { if (mode === 'file' && saveTimer) atomicWrite(DB_FILE, JSON.stringify(db, null, 1)); });

// ---------------------------------------------------------------- persistence: MongoDB (write-behind)
const dirty = { settings: new Set(), projects: new Set(), ideas: new Set(), metadata: new Set(), messages: new Set(), seq: false };
const deleted = { projects: new Set(), ideas: new Set(), metadata: new Set() };
const pendingEvents = [];
let flushTimer = null, flushing = null;

function markDirty(kind, id) {
  if (mode !== 'mongo') { if (kind !== 'messages') fileSave(); return; }
  if (kind === 'seq') dirty.seq = true; else dirty[kind].add(id);
  scheduleFlush();
}
function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 250);
}

const MAX_MSG_BYTES = 12 * 1024 * 1024; // MongoDB documents are limited to 16 MB
function messagesDoc(pid) {
  let list = getMessages(pid);
  if (JSON.stringify(list).length > MAX_MSG_BYTES) {
    list = list.map((m, i) => (m.role === 'tool' && i < list.length - 40 && (m.content || '').length > 600 ? { ...m, content: m.content.slice(0, 600) + ' …[trimmed]' } : m));
  }
  return { _id: Number(pid), list };
}

async function flush() {
  if (mode !== 'mongo') return;
  if (flushing) { await flushing; if (anyDirty()) return flush(); return; }
  flushing = (async () => {
    const m = mongo.db;
    try {
      const take = (set) => { const a = [...set]; set.clear(); return a; };
      const ops = [];
      const settings = take(dirty.settings);
      if (settings.length) ops.push(m.collection('settings').bulkWrite(settings.map((k) =>
        (k in db.settings ? { replaceOne: { filter: { _id: k }, replacement: { _id: k, value: db.settings[k] }, upsert: true } } : { deleteOne: { filter: { _id: k } } })), { ordered: false }));
      for (const [kind, list, key] of [['projects', db.projects, 'id'], ['ideas', db.ideas, 'id']]) {
        const ids = take(dirty[kind]);
        const del = take(deleted[kind]);
        const writes = ids.map((id) => list.find((x) => x[key] === id)).filter(Boolean)
          .map((doc) => ({ replaceOne: { filter: { _id: doc[key] }, replacement: { _id: doc[key], ...doc }, upsert: true } }));
        for (const id of del) writes.push({ deleteOne: { filter: { _id: id } } });
        if (writes.length) ops.push(m.collection(kind).bulkWrite(writes, { ordered: false }));
      }
      const metas = take(dirty.metadata), mdel = take(deleted.metadata);
      const mw = metas.filter((id) => db.metadata[id]).map((id) => ({ replaceOne: { filter: { _id: Number(id) }, replacement: { _id: Number(id), ...db.metadata[id] }, upsert: true } }));
      for (const id of mdel) mw.push({ deleteOne: { filter: { _id: Number(id) } } });
      if (mw.length) ops.push(m.collection('metadata').bulkWrite(mw, { ordered: false }));
      for (const pid of take(dirty.messages)) ops.push(m.collection('messages').replaceOne({ _id: Number(pid) }, messagesDoc(pid), { upsert: true }));
      if (dirty.seq) { dirty.seq = false; ops.push(m.collection('counters').replaceOne({ _id: 'seq' }, { _id: 'seq', ...db.seq }, { upsert: true })); }
      const evs = pendingEvents.splice(0);
      if (evs.length) ops.push(m.collection('events').insertMany(evs.map((e) => ({ _id: e.id, ...e })), { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; }));
      await Promise.all(ops);
      dbStatus = { ok: true, backend: 'mongodb', db: MONGO_DB, error: null };
    } catch (e) {
      dbStatus = { ok: false, backend: 'mongodb', db: MONGO_DB, error: e.message };
      console.error('MongoDB save failed, will retry:', e.message);
      // everything is still in memory: mark it all dirty again and retry shortly
      for (const k of Object.keys(db.settings)) dirty.settings.add(k);
      for (const p of db.projects) dirty.projects.add(p.id);
      for (const i of db.ideas) dirty.ideas.add(i.id);
      for (const k of Object.keys(db.metadata)) dirty.metadata.add(k);
      for (const k of msgCache.keys()) dirty.messages.add(k);
      dirty.seq = true;
      setTimeout(scheduleFlush, 5000);
    }
  })();
  try { await flushing; } finally { flushing = null; }
  return null;
}
const anyDirty = () => Object.values(dirty).some((v) => (v instanceof Set ? v.size : v)) || pendingEvents.length > 0 ||
  Object.values(deleted).some((s) => s.size);

async function initMongo() {
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); }
  catch (_) { throw new Error('MONGODB_URI is set but the "mongodb" package is missing. Run "npm install".'); }
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 20000, appName: 'documentary-studio' });
  await client.connect();
  const m = client.db(MONGO_DB);
  mongo = { client, db: m };
  await m.collection('events').createIndex({ project_id: 1, _id: 1 }).catch(() => {});
  const seqDoc = await m.collection('counters').findOne({ _id: 'seq' });
  if (!seqDoc) {
    // empty database: copy the local JSON data in once (so nothing is lost when switching to MongoDB).
    // Read the local history files first, while still in file mode.
    const files = fs.existsSync(MSG_DIR) ? fs.readdirSync(MSG_DIR).filter((f) => f.endsWith('.json')) : [];
    for (const f of files) { const pid = Number(f.replace('.json', '')); getMessages(pid); dirty.messages.add(pid); }
    for (const p of db.projects) {
      dirty.projects.add(p.id);
      pendingEvents.push(...getEvents(p.id));
    }
    mode = 'mongo';
    for (const k of Object.keys(db.settings)) dirty.settings.add(k);
    for (const i of db.ideas) dirty.ideas.add(i.id);
    for (const k of Object.keys(db.metadata)) dirty.metadata.add(k);
    dirty.seq = true;
    await flush();
    if (!dbStatus.ok) throw new Error(dbStatus.error);
    const moved = db.projects.length + db.ideas.length;
    if (moved) console.log(`MongoDB: copied ${db.projects.length} films and ${db.ideas.length} ideas from local files.`);
    return;
  }
  // load everything from MongoDB into memory
  const strip = ({ _id, ...rest }) => rest;
  const [settings, projects, ideas, metadata, messages, events] = await Promise.all(
    ['settings', 'projects', 'ideas', 'metadata', 'messages', 'events'].map((c) => m.collection(c).find({}).toArray()));
  db = blank();
  for (const s of settings) db.settings[s._id] = s.value;
  db.projects = projects.map(strip).sort((a, b) => a.id - b.id);
  db.ideas = ideas.map(strip).sort((a, b) => a.id - b.id);
  for (const md of metadata) db.metadata[md._id] = strip(md);
  db.seq = { ...db.seq, ...strip(seqDoc) };
  msgCache.clear(); evCache.clear();
  for (const mm of messages) msgCache.set(Number(mm._id), mm.list || []);
  for (const e of events.sort((a, b) => a._id - b._id)) {
    const ev = strip(e);
    if (!evCache.has(ev.project_id)) evCache.set(ev.project_id, []);
    evCache.get(ev.project_id).push(ev);
  }
  for (const p of db.projects) if (!evCache.has(p.id)) evCache.set(p.id, []);
  for (const p of db.projects) if (!msgCache.has(p.id)) msgCache.set(p.id, []);
  mode = 'mongo';
}

// Call once at startup (before serving requests).
async function init() {
  if (!MONGO_URI) { dbStatus = { ok: true, backend: 'files', error: null }; return dbStatus; }
  try {
    await initMongo();
    dbStatus = { ok: true, backend: 'mongodb', db: MONGO_DB, error: null };
  } catch (e) {
    // keep running on local files so the app still opens; Settings > Server check shows the problem
    mode = 'file';
    dbStatus = { ok: false, backend: 'files (MongoDB failed)', db: MONGO_DB, error: e.message };
    console.error('MongoDB connection failed, using local files instead:', e.message);
  }
  return dbStatus;
}
const status = () => ({ ...dbStatus, mode });
async function close() { if (mode === 'mongo') { await flush(); await mongo.client.close(); } else fileSave(true); }

function save(nowFlag = false) { if (mode === 'file') fileSave(nowFlag); }

// ---------------------------------------------------------------- settings
const getSetting = (k, def = null) => (k in db.settings ? db.settings[k] : def);
function setSetting(k, v) { db.settings[k] = v; markDirty('settings', k); }

// ---------------------------------------------------------------- projects
const projects = () => db.projects;
const getProject = (id) => db.projects.find((p) => p.id === Number(id)) || null;
function addProject(p) {
  const id = ++db.seq.project;
  const row = { id, status: 'new', stage: 'story', pending: null, final_video: null, final_srt: null, created: now(), updated: now(), ...p };
  db.projects.push(row);
  markDirty('projects', id); markDirty('seq');
  return row;
}
function updateProject(id, fields) {
  const p = getProject(id);
  if (!p) return null;
  Object.assign(p, fields, { updated: now() });
  markDirty('projects', p.id);
  return p;
}
function deleteProject(id) {
  id = Number(id);
  db.projects = db.projects.filter((p) => p.id !== id);
  delete db.metadata[id];
  for (const i of db.ideas) if (i.project_id === id) { i.project_id = null; markDirty('ideas', i.id); }
  msgCache.delete(id); evCache.delete(id);
  for (const f of [path.join(MSG_DIR, `${id}.json`), path.join(EV_DIR, `${id}.jsonl`)]) fs.rmSync(f, { force: true });
  if (mode === 'mongo') {
    deleted.projects.add(id); deleted.metadata.add(id); dirty.projects.delete(id); dirty.metadata.delete(id); dirty.messages.delete(id);
    mongo.db.collection('messages').deleteOne({ _id: id }).catch(() => {});
    mongo.db.collection('events').deleteMany({ project_id: id }).catch(() => {});
    scheduleFlush();
  } else fileSave();
}

// ---------------------------------------------------------------- messages (agent memory)
function getMessages(pid) {
  pid = Number(pid);
  if (!msgCache.has(pid)) {
    let m = [];
    if (mode === 'file' || !mongo) { try { m = JSON.parse(fs.readFileSync(path.join(MSG_DIR, `${pid}.json`), 'utf8')); } catch (_) { /* none */ } }
    msgCache.set(pid, m);
  }
  return msgCache.get(pid);
}
function addMessage(pid, msg) {
  pid = Number(pid);
  getMessages(pid).push(msg);
  if (mode === 'mongo') markDirty('messages', pid);
  else atomicWrite(path.join(MSG_DIR, `${pid}.json`), JSON.stringify(getMessages(pid)));
}
function clearMessages(pid) {
  pid = Number(pid);
  msgCache.set(pid, []);
  if (mode === 'mongo') markDirty('messages', pid);
  else fs.rmSync(path.join(MSG_DIR, `${pid}.json`), { force: true });
}

// ---------------------------------------------------------------- events (activity feed)
function getEvents(pid) {
  pid = Number(pid);
  if (!evCache.has(pid)) {
    const list = [];
    if (mode === 'file' || !mongo) {
      try { for (const line of fs.readFileSync(path.join(EV_DIR, `${pid}.jsonl`), 'utf8').split('\n')) if (line) list.push(JSON.parse(line)); } catch (_) { /* none */ }
    }
    evCache.set(pid, list);
  }
  return evCache.get(pid);
}
const listeners = new Set();
function addEvent(pid, kind, text = '', meta = null) {
  const ev = { id: ++db.seq.event, project_id: Number(pid), kind, text: String(text ?? ''), meta, created: now() };
  getEvents(pid).push(ev);
  if (mode === 'mongo') { pendingEvents.push(ev); markDirty('seq'); }
  else { fs.appendFileSync(path.join(EV_DIR, `${pid}.jsonl`), JSON.stringify(ev) + '\n'); fileSave(); }
  for (const fn of listeners) { try { fn(ev); } catch (_) { /* listener errors don't matter */ } }
  return ev;
}
const eventsAfter = (pid, after, limit = 500) => getEvents(pid).filter((e) => e.id > after).slice(0, limit);
const onEvent = (fn) => listeners.add(fn);
const lastEventId = () => db.seq.event;

// ---------------------------------------------------------------- ideas
const ideas = () => db.ideas;
const getIdea = (id) => db.ideas.find((i) => i.id === Number(id)) || null;
function addIdea(i) {
  const row = { id: ++db.seq.idea, title: '', notes: '', status: 'idea', publish_date: null, project_id: null, created: now(), ...i };
  db.ideas.push(row);
  markDirty('ideas', row.id); markDirty('seq');
  return row;
}
function updateIdea(id, fields) { const i = getIdea(id); if (i) { Object.assign(i, fields); markDirty('ideas', i.id); } return i; }
function deleteIdea(id) {
  id = Number(id);
  db.ideas = db.ideas.filter((i) => i.id !== id);
  if (mode === 'mongo') { deleted.ideas.add(id); dirty.ideas.delete(id); scheduleFlush(); } else fileSave();
}

// ---------------------------------------------------------------- YouTube metadata per film
function getMeta(pid) {
  pid = Number(pid);
  if (!db.metadata[pid]) {
    db.metadata[pid] = { project_id: pid, title: '', description: '', tags: [], chapters: [], title_options: [], thumbnail_ideas: [],
      category_id: '27', privacy: 'private', publish_at: '', language: 'en', thumbnail_path: null, youtube_id: null,
      upload_status: null, upload_progress: 0, upload_error: null };
    markDirty('metadata', pid);
  }
  return db.metadata[pid];
}
function saveMeta(pid, fields) { Object.assign(getMeta(pid), fields); markDirty('metadata', Number(pid)); return getMeta(pid); }
const allMeta = () => Object.values(db.metadata);

module.exports = {
  init, status, close, flush, save, getSetting, setSetting,
  projects, getProject, addProject, updateProject, deleteProject,
  getMessages, addMessage, clearMessages,
  addEvent, eventsAfter, onEvent, lastEventId, getEvents,
  ideas, getIdea, addIdea, updateIdea, deleteIdea,
  getMeta, saveMeta, allMeta,
};
