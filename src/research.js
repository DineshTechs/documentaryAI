'use strict';
// Research tools for the agent: web search (Brave or Wikipedia), page reading, and Wikimedia Commons images.
const fs = require('fs');
const path = require('path');
const store = require('./store');

// Wikimedia requires a descriptive User-Agent with a way to contact the operator, or it throttles/blocks requests.
const UA = { 'User-Agent': 'DocumentaryStudio/2.1 (https://github.com/DineshTechs/documentaryAI; documentary research tool) Node.js', 'Api-User-Agent': 'DocumentaryStudio/2.1 (https://github.com/DineshTechs/documentaryAI)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request to Wikimedia at a time, at a polite pace, and wait-and-retry when it says "slow down" (429/503).
let wmQueue = Promise.resolve(), wmLast = 0;
function wmFetch(url, opts = {}, gapMs = 1000) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = wmLast + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      wmLast = Date.now();
      const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
      if ((r.status === 429 || r.status === 503) && attempt < 3) {
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        const ms = Math.min(60000, (Number.isFinite(ra) ? ra * 1000 : 0) || [5000, 15000, 40000][attempt]);
        try { await r.arrayBuffer(); } catch (_) { /* drain */ }
        await sleep(ms);
        continue;
      }
      return r;
    }
  };
  const p = wmQueue.then(run, run);
  wmQueue = p.catch(() => {});
  return p;
}
const isWikimedia = (url) => /(^|\.)(wikimedia|wikipedia)\.org$/.test(new URL(url).hostname);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s);

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function getJson(url, headers = {}) {
  const opts = { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(90000) };
  const r = isWikimedia(url) ? await wmFetch(url, opts) : await fetch(url, opts);
  if (r.status === 429) throw new Error(`Wikimedia is rate-limiting right now (HTTP 429), even after waiting. Wait 2-3 minutes, then try again; don't run many searches at once.`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

async function webSearch(query) {
  const key = (store.getSetting('search', {}) || {}).brave_key;
  if (key) {
    const d = await getJson(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(query)}`, { 'X-Subscription-Token': key, Accept: 'application/json' });
    const res = (d.web && d.web.results) || [];
    return res.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${stripHtml(x.description)}`).join('\n\n') || 'No results.';
  }
  const d = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=${encodeURIComponent(query)}`);
  const res = (d.query && d.query.search) || [];
  if (!res.length) return 'No results.';
  return '(Wikipedia search. Add a Brave Search key in Settings for full web search.)\n\n' +
    res.map((x, i) => `${i + 1}. ${x.title}\nhttps://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}\n${stripHtml(x.snippet)}`).join('\n\n');
}

async function webFetch(url) {
  if (!/^https?:\/\//.test(url)) return 'Only http(s) URLs are allowed.';
  const m = url.match(/^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/);
  if (m) {
    const d = await getJson(`https://${m[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${m[2]}`);
    const txt = Object.values((d.query && d.query.pages) || {}).map((p) => p.extract || '').join('\n\n');
    if (txt.trim()) return clip(txt, 20000);
  }
  const opts = { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) };
  const r = isWikimedia(url) ? await wmFetch(url, opts) : await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('html')) return clip(stripHtml(await r.text()), 20000);
  if (ct.startsWith('text/') || ct.includes('json')) return clip(await r.text(), 20000);
  return `Fetched ${ct || 'binary'} content; not text.`;
}

// ---------------------------------------------------------------- Wikimedia Commons
const FREE = /^(public domain|pd|cc0|cc by|cc-by|cc by-sa|cc-by-sa|no restrictions|attribution|gfdl|fal)/i;

async function commonsSearch(query, limit = 12) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6' +
    `&gsrlimit=${Math.min(30, limit)}&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}` +
    '&prop=imageinfo&iiprop=url|size|mime|extmetadata';
  const d = await getJson(url);
  const pages = Object.values((d.query && d.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo || [])[0];
    if (!ii || !/image\/(jpeg|png|webp|gif|tiff)/.test(ii.mime || '')) continue;
    const md = ii.extmetadata || {};
    const lic = stripHtml(md.LicenseShortName?.value || md.License?.value || '');
    out.push({
      title: p.title, width: ii.width, height: ii.height, license: lic, free: FREE.test(lic),
      author: stripHtml(md.Artist?.value || '').slice(0, 120), date: stripHtml(md.DateTimeOriginal?.value || '').slice(0, 40),
      description: stripHtml(md.ImageDescription?.value || '').slice(0, 220), page: ii.descriptionurl,
    });
  }
  return out;
}

async function commonsDownload(projectDir, fileTitle, saveAs) {
  const title = fileTitle.startsWith('File:') ? fileTitle : `File:${fileTitle}`;
  const d = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
    `&iiprop=url|size|mime|extmetadata&iiurlwidth=1920&titles=${encodeURIComponent(title)}`);
  const page = Object.values((d.query && d.query.pages) || {})[0];
  const ii = page && (page.imageinfo || [])[0];
  if (!ii) throw new Error(`Not found on Wikimedia Commons: ${title}`);
  const md = ii.extmetadata || {};
  const license = stripHtml(md.LicenseShortName?.value || '');
  if (!FREE.test(license)) throw new Error(`"${title}" is licensed "${license || 'unknown'}", not a free licence. Pick another image.`);
  // 1920 px is one of Commons' standard thumbnail sizes (cached, lightly limited); small originals are used as they are
  const src = ii.width && ii.width <= 1920 && /image\/(jpeg|png|webp)/.test(ii.mime || '') ? ii.url : (ii.thumburl || ii.url);
  const r = await wmFetch(src, { signal: AbortSignal.timeout(180000) }, 1500);
  if (r.status === 429) throw new Error('Wikimedia is rate-limiting downloads right now (HTTP 429), even after waiting. Wait 2-3 minutes and try again, one image at a time.');
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let ext = (path.extname(new URL(src).pathname) || '.jpg').toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) ext = '.jpg';
  const base = (saveAs || title.replace(/^File:/, '')).replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const rel = `images/${base}${ext}`;
  fs.mkdirSync(path.join(projectDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, rel), buf);
  const credit = {
    file: rel, title, page: ii.descriptionurl, license, licenseUrl: md.LicenseUrl?.value || '',
    author: stripHtml(md.Artist?.value || 'Unknown').slice(0, 200), credit: stripHtml(md.Credit?.value || '').slice(0, 200),
  };
  addCredit(projectDir, credit);
  return { file: rel, bytes: buf.length, ...credit };
}

function addCredit(projectDir, credit) {
  const f = path.join(projectDir, 'credits.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* new */ }
  list = list.filter((c) => c.file !== credit.file);
  list.push(credit);
  fs.writeFileSync(f, JSON.stringify(list, null, 1));
  const md = ['# Image credits', '', ...list.map((c) => `- ${c.title.replace(/^File:/, '')}: ${c.author} (${c.license}${c.licenseUrl ? ', ' + c.licenseUrl : ''}), via Wikimedia Commons, ${c.page}`)];
  fs.writeFileSync(path.join(projectDir, 'credits.md'), md.join('\n') + '\n');
}

module.exports = { webSearch, webFetch, commonsSearch, commonsDownload, addCredit, stripHtml };
