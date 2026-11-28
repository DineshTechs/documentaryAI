'use strict';
// Actions shared by the web API and the Telegram bot.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const agent = require('./agent');

function slugify(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'film';
  let slug = base, i = 2;
  while (store.projects().some((p) => p.slug === slug)) slug = `${base}-${i++}`;
  return slug;
}

function createProject(b, autostart = false) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('Title is required');
  const p = store.addProject({
    title, slug: slugify(title), topic: b.topic || title, brief: b.brief || '', duration_s: b.aspect === '9:16' ? Math.min(180, parseInt(b.duration_s || 60, 10)) : parseInt(b.duration_s || 90, 10),
    look: b.look || 'auto', aspect: b.aspect || '16:9', language: b.language || '', provider: b.provider || null, model: b.model || null, idea_id: b.idea_id || null,
  });
  fs.mkdirSync(path.join(agent.projectRoot(p), 'uploads'), { recursive: true });
  store.addEvent(p.id, 'system', 'Film created');
  if (b.idea_id) store.updateIdea(b.idea_id, { project_id: p.id, status: 'production' });
  if (autostart) agent.kickoff(p.id);
  return store.getProject(p.id);
}

function startOrResume(pid) {
  const p = store.getProject(pid);
  if (!p) throw new Error('Film not found');
  if (p.status === 'awaiting_approval') throw new Error('Waiting for your approval - approve or request changes first.');
  if (agent.isRunning(pid)) return 'already running';
  if (p.status === 'done' || p.stage === 'done') throw new Error('This film is finished. To change something, send the agent a message describing the change (for example "make the intro shorter").');
  if (!store.getMessages(p.id).length) { agent.kickoff(p.id); return 'started'; }
  store.addMessage(p.id, { role: 'user', text: 'Continue where you left off.' });
  store.addEvent(p.id, 'user', 'Continue');
  agent.start(p.id);
  return 'resumed';
}

function notifyUploads(pid, saved, caption = '') {
  if (!saved.length) return;
  store.addEvent(pid, 'system', `Uploaded: ${saved.join(', ')}${caption ? ` (${caption})` : ''}`);
  const note = `The user uploaded these files: ${saved.join(', ')}. Use them where they fit (own photos, a recorded voice-over, music).` +
    (caption ? ` The user's note about them: ${caption}` : '');
  if (agent.isRunning(pid)) agent.RUNNERS.get(Number(pid)).inbox.push(note);
  else store.addMessage(Number(pid), { role: 'user', text: note });
}

function makeFilmFromIdea(iid, autostart = true) {
  const idea = store.getIdea(iid);
  if (!idea) throw new Error('Idea not found');
  if (idea.project_id && store.getProject(idea.project_id)) return store.getProject(idea.project_id);
  return createProject({ title: idea.title, topic: idea.notes || idea.title, idea_id: idea.id }, autostart);
}

const safeFilename = (name) => String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

module.exports = { slugify, createProject, startOrResume, notifyUploads, makeFilmFromIdea, safeFilename };
