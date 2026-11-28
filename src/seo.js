'use strict';
// YouTube SEO: a checklist with a score for the Publish tab, and the exact cleaned-up metadata that gets uploaded
// (so an upload never fails on a bad character or too many tags, and always carries chapters, hashtags, credits,
// the right language and a second-language title/description).
const fs = require('fs');
const path = require('path');

const LIMITS = { title: 100, description: 5000, tagsChars: 480 };

// YouTube rejects "<" and ">" in titles and descriptions
const clean = (s) => String(s || '').replace(/</g, '‹').replace(/>/g, '›').replace(/\r/g, '').trim();
const words = (s) => (String(s || '').match(/[\p{L}\p{N}]+/gu) || []).length;
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

function langCode(p, channelLang) {
  const l = String(p.language || channelLang || 'English').toLowerCase();
  const map = { hinglish: 'hi', hindi: 'hi', english: 'en', bengali: 'bn', marathi: 'mr', tamil: 'ta', telugu: 'te', kannada: 'kn', malayalam: 'ml', gujarati: 'gu', punjabi: 'pa', urdu: 'ur', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', arabic: 'ar' };
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(l) && Object.values(map).includes(l.slice(0, 2))) return l.slice(0, 2); // already a code
  return Object.entries(map).find(([k]) => l.includes(k))?.[1] || 'en';
}
// The metadata used to default to "en" for every film; trust it only when it matches the film or was changed on purpose.
function uploadLang(p, m, channelLang) {
  const film = langCode(p, channelLang);
  return m.language && !(m.language === 'en' && film !== 'en') ? m.language : film;
}

// Tags: no duplicates, no characters YouTube refuses, total length under the 500-character limit
// (YouTube counts a tag with spaces as if it had quotes around it).
function cleanTags(tags) {
  const out = [], seen = new Set();
  let total = 0;
  for (let t of tags || []) {
    t = String(t).replace(/[<>",#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (total + cost > LIMITS.tagsChars) break;
    seen.add(k); out.push(t); total += cost;
  }
  return out;
}

const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
const toSec = (t) => String(t).split(':').reduce((a, x) => a * 60 + Number(x), 0);

// Chapters YouTube will accept: first at 0:00, at least 3, each at least 10 s long.
function validChapters(chs, duration) {
  const list = (chs || []).map((c) => ({ s: toSec(c.time), label: String(c.label || '').trim() })).filter((c) => Number.isFinite(c.s) && c.label).sort((a, b) => a.s - b.s);
  if (!list.length) return [];
  list[0].s = 0;
  const out = [list[0]];
  for (const c of list.slice(1)) if (c.s - out[out.length - 1].s >= 10 && (!duration || duration - c.s >= 10)) out.push(c);
  return out.length >= 3 ? out.map((c) => ({ time: fmtTime(c.s), label: c.label.slice(0, 80) })) : [];
}
const hasChapterBlock = (d) => /(^|\n)\s*0?0:00\s+\S/.test(d);

// The final snippet that goes to YouTube, plus a list of what was fixed.
function prepare(p, m, root, opts = {}) {
  const fixes = [];
  const isShort = p.aspect === '9:16';
  let title = clean(m.title);
  if (title.length > LIMITS.title) { title = title.slice(0, LIMITS.title - 1).replace(/\s+\S*$/, '') + '…'; fixes.push('title shortened to 100 characters'); }
  if (title !== String(m.title || '').trim() && !fixes.length) fixes.push('removed < > from the title');

  let desc = clean(m.description);
  const footer = [];
  // chapters (long videos)
  const chapters = isShort ? [] : validChapters(m.chapters, opts.duration);
  if (chapters.length && !hasChapterBlock(desc)) { footer.push(['Chapters', chapters.map((c) => `${c.time} ${c.label}`).join('\n')]); fixes.push('added the chapters'); }
  // image credits (licences require them)
  let credits = '';
  try { credits = fs.readFileSync(path.join(root, 'credits.md'), 'utf8').trim(); } catch (_) { /* no images */ }
  if (credits && !/credit|licen[cs]e|wikimedia|cc by|public domain/i.test(desc)) {
    const short = credits.replace(/^#.*\n+/, '').split('\n').filter((l) => l.trim()).slice(0, 25).join('\n');
    footer.push(['Image credits', short]); fixes.push('added image credits');
  }
  // hashtags: YouTube shows the first 3 above the title and ignores all of them if there are more than 15
  let tagsInDesc = (desc.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).map((x) => x.trim());
  const want = [...(m.hashtags || []).map((h) => '#' + String(h).replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, ''))];
  if (isShort && !tagsInDesc.concat(want).some((h) => /^#shorts$/i.test(h))) want.unshift('#Shorts');
  const missing = want.filter((h) => h.length > 1 && !tagsInDesc.some((x) => x.toLowerCase() === h.toLowerCase())).slice(0, Math.max(0, 3 - tagsInDesc.length + (isShort ? 1 : 0)));
  for (const [h, body] of footer) desc += `\n\n${h}:\n${body}`;
  if (missing.length) { desc += `\n\n${missing.join(' ')}`; fixes.push('added hashtags'); tagsInDesc = tagsInDesc.concat(missing); }
  if (tagsInDesc.length > 15) fixes.push('more than 15 hashtags: YouTube will ignore them all');
  if (desc.length > LIMITS.description) { desc = desc.slice(0, LIMITS.description - 1) + '…'; fixes.push('description shortened to 5000 characters'); }

  const tags = cleanTags(m.tags);
  if (tags.length < (m.tags || []).length) fixes.push(`tags trimmed to ${tags.length} (YouTube allows about 500 characters in total)`);

  // second language (e.g. English title/description on a Hindi video), only for a different language than the video
  const lang = opts.lang;
  const localizations = {};
  for (const [code, loc] of Object.entries(m.localized || {})) {
    if (!loc || code === lang || !/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) continue;
    const t = clean(loc.title).slice(0, LIMITS.title), d = clean(loc.description).slice(0, LIMITS.description);
    if (t) localizations[code] = { title: t, description: d || desc };
  }
  return { title, description: desc, tags, localizations, fixes };
}

// Checklist + score for the Publish tab
function audit(p, m, root, opts = {}) {
  const isShort = p.aspect === '9:16';
  const checks = [];
  const add = (ok, weight, msg, tip) => checks.push({ ok: !!ok, weight, msg, tip: ok ? '' : tip || '' });
  const t = String(m.title || ''), d = String(m.description || '');
  const kw = norm(m.focus_keyword || (m.tags || [])[0] || '');
  const tags = m.tags || [];
  add(t.length >= 20 && t.length <= (isShort ? 60 : 70), 12, `Title length ${t.length} characters (best ${isShort ? '20-60' : '30-70'})`, 'Long titles get cut off on phones; very short ones carry no keywords.');
  add(kw && norm(t.slice(0, 55)).includes(kw.split(' ').slice(0, 3).join(' ')), 10, kw ? `Main keyword "${kw}" near the start of the title` : 'A main search keyword is set', 'Put the main search phrase in the first half of the title.');
  add(!/[<>]/.test(t + d), 4, 'No < or > characters', 'YouTube rejects them; the app replaces them on upload.');
  add(isShort ? d.length >= 40 : words(d) >= 120, 10, isShort ? 'Description has a short hook line' : `Description has ${words(d)} words (aim 150+)`, 'A fuller description with natural keywords helps search.');
  add(kw && norm(d.slice(0, 160)).includes(kw.split(' ')[0]), 8, 'Keyword in the first 2 lines of the description', 'Search results show only the first ~150 characters.');
  add(tags.length >= 8, 8, `${tags.length} tags (aim 10-25)`, 'Add spelling variants, the topic, names, places and the language.');
  const hs = (d.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length + (m.hashtags || []).length;
  add(hs >= 1 && hs <= 15, 6, 'Hashtags (1-3 shown above the title)', 'Add 2-3 specific hashtags; more than 15 makes YouTube ignore all of them.');
  if (!isShort) add(hasChapterBlock(d) || validChapters(m.chapters, opts.duration).length >= 3, 10, 'Chapters (timestamps) in the description', 'Chapters show up in search and keep viewers navigating instead of leaving.');
  add(p.final_srt && fs.existsSync(path.join(root, p.final_srt)), 8, 'Captions file is uploaded with the video', 'Captions are indexed by YouTube search.');
  if (!isShort) add(m.thumbnail_path && fs.existsSync(path.join(root, m.thumbnail_path)), 10, 'Custom thumbnail chosen', 'Click "✨ Design 3 thumbnails" and pick one.');
  add(Object.keys(m.localized || {}).length > 0, 6, 'Second-language title and description', 'Generate metadata again to add one; it lets YouTube show the video to more viewers.');
  add(!!m.pinned_comment, 4, 'Pinned comment question ready', 'A question in a pinned comment gets people commenting.');
  if (isShort) add(/#shorts/i.test(d) || (m.hashtags || []).some((h) => /shorts/i.test(h)), 4, '#Shorts in the description', 'The app adds it on upload.');
  let credits = false;
  try { credits = fs.existsSync(path.join(root, 'credits.md')); } catch (_) { /* */ }
  if (credits) add(/credit|licen[cs]e|wikimedia|public domain|cc by/i.test(d), 4, 'Image credits in the description', 'The app adds them on upload (the image licences require it).');
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  return { score: Math.round((got / total) * 100), checks };
}

module.exports = { prepare, audit, cleanTags, validChapters, langCode, uploadLang, clean };
