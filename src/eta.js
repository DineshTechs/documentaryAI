'use strict';
// Estimates how long the agent still needs to finish a film.
// Each stage costs "seconds of agent work per second of finished film". We start with rough defaults and learn real
// values from your own finished films (agent working time only; time spent waiting for your approval doesn't count).
const store = require('./store');

const STAGES = ['story', 'voice', 'images', 'scene', 'review', 'render'];
const DEFAULT_RATE = { story: 1.5, voice: 0.6, images: 1.5, scene: 2.5, review: 2.5, render: 4 }; // ≈ 14 min for a 70 s film, as measured on a first real run
const FLOOR = { story: 120, voice: 30, images: 90, scene: 120, review: 120, render: 60 }; // seconds, even for short films

function stats() { return store.getSetting('eta_stats', {}) || {}; }

function rate(stage) {
  const s = stats()[stage];
  return s && s.n ? s.rate : DEFAULT_RATE[stage];
}
const stageEstimate = (stage, dur) => Math.max(FLOOR[stage], rate(stage) * dur);

// Add the time one agent step took to the stage it ran in.
function addWork(pid, stage, seconds) {
  if (!STAGES.includes(stage) || !(seconds > 0)) return;
  const p = store.getProject(pid);
  if (!p) return;
  const st = { ...(p.stage_time || {}) };
  st[stage] = Math.round(((st[stage] || 0) + seconds) * 10) / 10;
  store.updateProject(pid, { stage_time: st });
}

// When a film is finished, fold its real stage times into the learned averages (recent films count more).
function learn(p) {
  const dur = Math.max(10, p.duration_s || 90), st = p.stage_time || {};
  const all = { ...stats() };
  for (const stage of STAGES) {
    if (!(st[stage] > 5)) continue;
    const r = st[stage] / dur;
    const prev = all[stage] || { n: 0, rate: DEFAULT_RATE[stage] };
    const w = Math.min(prev.n, 9); // moving average over about the last 10 films
    all[stage] = { n: prev.n + 1, rate: +((prev.rate * w + r) / (w + 1)).toFixed(3) };
  }
  store.setSetting('eta_stats', all);
}

// { total_s, left_s, done_s, learned_from } for a film
function estimate(p) {
  const dur = Math.max(10, p.duration_s || 90);
  if (p.stage === 'done' || p.status === 'done') {
    const done = Object.values(p.stage_time || {}).reduce((a, b) => a + b, 0);
    return { total_s: Math.round(done), left_s: 0, done_s: Math.round(done), learned_from: (stats().render || {}).n || 0 };
  }
  const ci = Math.max(0, STAGES.indexOf(p.stage || 'story'));
  const st = p.stage_time || {};
  let total = 0, left = 0, done = 0;
  STAGES.forEach((stage, i) => {
    const est = stageEstimate(stage, dur), spent = st[stage] || 0;
    done += spent;
    if (i < ci) total += spent || est;
    else if (i === ci) { const rest = Math.max(est - spent, est * 0.15); total += spent + rest; left += rest; }
    else { total += est; left += est; }
  });
  const learned = Math.min(...STAGES.map((s) => (stats()[s] || {}).n || 0));
  return { total_s: Math.round(total), left_s: Math.round(left), done_s: Math.round(done), learned_from: learned };
}

module.exports = { estimate, addWork, learn, STAGES, DEFAULT_RATE };
