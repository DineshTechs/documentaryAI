/* Documentary Studio - single-page frontend (no build step). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STAGES = ["story", "voice", "images", "scene", "review", "render", "done"];
let LOOKS = { auto: "Auto (the AI picks per subject)" };
const IDEA_COLS = [["idea", "Ideas"], ["research", "Research"], ["production", "In production"], ["scheduled", "Scheduled"], ["published", "Published"]];
let META = null;
let pollTimer = null;

// ------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const o = { method: opts.method || "GET", headers: {} };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.body = JSON.stringify(opts.body); o.headers["content-type"] = "application/json"; }
  const r = await fetch(path, o);
  if (r.status === 401) { renderLogin(); throw new Error("Please log in"); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.blob();
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
function toast(msg, bad = false) {
  const d = document.createElement("div");
  d.textContent = msg; if (bad) d.className = "bad";
  $("#toast").appendChild(d);
  setTimeout(() => d.remove(), bad ? 7000 : 3500);
}
async function act(btn, fn) {
  const old = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${old}`; }
  try { return await fn(); } catch (e) { toast(e.message, true); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : b > 1e3 ? Math.round(b / 1e3) + " KB" : b + " B";
const ago = (t) => { const s = Date.now() / 1000 - t; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
const ext = (p) => (p.split(".").pop() || "").toLowerCase();
const isImg = (p) => ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext(p));
const isVid = (p) => ["mp4", "mov", "webm"].includes(ext(p));
const isAud = (p) => ["m4a", "mp3", "wav", "aac", "ogg"].includes(ext(p));
const isText = (p) => ["md", "txt", "py", "json", "srt", "csv", "yaml", "yml", "toml", "log", "html", "css", "js"].includes(ext(p));
const rawUrl = (pid, path, dl) => `/api/projects/${pid}/raw?path=${encodeURIComponent(path)}${dl ? "&dl=1" : ""}&t=${Date.now()}`;
const statusLabel = (s) => ({ awaiting_approval: "needs approval", new: "not started" }[s] || s);

function md(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  let html = "", i = 0;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<i>$2</i>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { let c = []; i++; while (i < lines.length && !/^```/.test(lines[i])) c.push(lines[i++]); i++; html += `<pre class="live">${esc(c.join("\n"))}</pre>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      html += "<table>" + body.map((r, k) => "<tr>" + cells(r).map((c) => k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</table>";
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); let items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      html += `<${ordered ? "ol" : "ul"}>` + items.map((x) => `<li>${inline(x)}</li>`).join("") + `</${ordered ? "ol" : "ul"}>`; continue;
    }
    if (!l.trim()) { i++; continue; }
    let para = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|```|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    html += `<p>${inline(para.join(" "))}</p>`;
  }
  return html;
}

function modal(html, onMount) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  const bg = $(".modal-bg", root);
  const close = () => (root.innerHTML = "");
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
  $$("[data-close]", root).forEach((b) => (b.onclick = close));
  if (onMount) onMount($(".modal", root), close);
  return close;
}

// ------------------------------------------------------------ shell + routing
function renderLogin() {
  stopPoll();
  $("#app").innerHTML = `<div class="login"><form class="card" id="lf">
    <div class="brand" style="padding:0 0 18px"><div class="reel"></div><div><b>Documentary Studio</b><small>cinematic films</small></div></div>
    <label>Password</label><input type="password" id="pw" autofocus>
    <button class="primary" style="width:100%;margin-top:16px;justify-content:center">Log in</button></form></div>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/login", { method: "POST", body: { password: $("#pw").value } }); route(); }
    catch (err) { toast(err.message, true); }
  };
}

function shell(active, inner) {
  const nav = [["films", "#/", "🎞", "Films"], ["ideas", "#/ideas", "🗂", "Ideas & calendar"], ["settings", "#/settings", "⚙", "Settings"]];
  $("#app").innerHTML = `<div class="shell"><aside class="side">
    <div class="brand"><div class="reel"></div><div><b>Documentary<br>Studio</b><small>documentary films</small></div></div>
    <nav class="nav">${nav.map(([k, h, ic, t]) => `<a href="${h}" class="${k === active ? "on" : ""}"><span>${ic}</span>${t}</a>`).join("")}</nav>
    <div class="foot"><a href="#" id="logout">Log out</a></div>
  </aside><main class="main" id="main">${inner}</main></div>`;
  $("#logout").onclick = async (e) => { e.preventDefault(); await api("/api/logout", { method: "POST" }); renderLogin(); };
  return $("#main");
}

function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

async function route() {
  stopPoll();
  $("#modal-root").innerHTML = "";
  try {
    const h = await api("/api/health");
    if (!h.logged_in) return renderLogin();
    if (!META) { META = await api("/api/meta"); LOOKS = { auto: "Auto (the AI picks per subject)", ...(META.looks || {}) }; }
  } catch (e) { return; }
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path] = hash.split("?");
  let m;
  if ((m = path.match(/^\/films\/(\d+)/))) return viewProject(+m[1]);
  if (path === "/ideas") return viewIdeas();
  if (path === "/settings" || path.startsWith("/settings/")) return viewSettings(path.split("/")[2] || "overview");
  return viewFilms();
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------ films dashboard
function miniSteps(stage) {
  const ci = STAGES.indexOf(stage);
  return `<div class="mini-steps">${STAGES.slice(0, 6).map((s, i) => `<i class="${i < ci || stage === "done" ? "done" : i === ci ? "cur" : ""}" title="${s}"></i>`).join("")}</div>`;
}

async function viewFilms() {
  const main = shell("films", `<div class="top"><div class="grow"><h1>Films</h1><div class="sub">Each film goes through story → voice → images → scene → review → render, with your approval at each key step.</div></div>
    <button id="new-short" title="Vertical 9:16 video for YouTube Shorts">＋ New Short</button> <button class="primary" id="new">＋ New film</button></div><div id="body"><div class="spin"></div></div>`);
  $("#new").onclick = () => newFilmModal();
  $("#new-short").onclick = () => newFilmModal({ aspect: "9:16" });
  const list = await api("/api/projects");
  const n = (f) => list.filter(f).length;
  const body = $("#body");
  if (!list.length) {
    body.innerHTML = `<div class="card empty"><h2>No films yet</h2><p>Start with a topic, e.g. “The night the Titanic sank, in 90 seconds”.<br>The agent researches it, writes the script and asks you to approve each step.</p>
      <button class="primary" id="new2">＋ Make your first film</button> <a class="btn" href="#/settings" style="margin-left:6px">Set up AI provider first</a></div>`;
    $("#new2").onclick = () => newFilmModal();
    return;
  }
  body.innerHTML = `<div class="stats">
      <div class="card stat"><b>${list.length}</b><span>Films</span></div>
      <div class="card stat"><b>${n((p) => p.running)}</b><span>Rendering / working</span></div>
      <div class="card stat"><b style="color:#f2c66d">${n((p) => p.status === "awaiting_approval")}</b><span>Need your approval</span></div>
      <div class="card stat"><b style="color:var(--green)">${n((p) => p.youtube && p.youtube.youtube_id)}</b><span>On YouTube</span></div></div>
    <div class="grid">${list.map((p) => `<div class="card film" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><h3>${esc(p.title)}</h3><span class="pill ${p.running ? "running" : p.status}">${statusLabel(p.running ? "running" : p.status)}</span></div>
      <div class="topic">${esc(p.topic || "")}</div>${miniSteps(p.stage)}
      <div class="hint" style="display:flex;justify-content:space-between"><span>Stage: <b style="color:var(--text)">${p.stage}</b> · ${p.duration_s}s · ${esc(p.look)}</span><span>${p.aspect === "9:16" ? '<span class="tag short">Short</span> ' : ""}${p.language && p.language !== "English" ? `<span class="tag">${esc(p.language)}</span> ` : ""}${p.usage && p.usage.calls ? `💰 ${costLabel(p.usage)} · ` : ""}${p.eta && p.stage !== "done" && p.status !== "done" && p.status !== "new" ? `⏱ ≈ ${fmtDur(p.eta.left_s)} left · ` : ""}${ago(p.updated)}</span></div>
      ${p.youtube && p.youtube.youtube_id ? `<div class="hint" style="color:var(--green);margin-top:6px">▶ youtu.be/${esc(p.youtube.youtube_id)}</div>` : ""}
    </div>`).join("")}</div>`;
  $$(".film", body).forEach((c) => (c.onclick = () => (location.hash = `#/films/${c.dataset.id}`)));
}

// ------------------------------------------------------------ cost counter helpers
const usd = (x) => (!x ? "$0" : x < 0.01 ? "<$0.01" : "$" + (x < 10 ? x.toFixed(2) : x.toFixed(1)));
const toks = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0));
const totalToks = (u) => (u.in || 0) + (u.out || 0) + (u.cache_read || 0) + (u.cache_write || 0);
const costLabel = (u) => (u && u.calls ? `${usd(u.cost)}${u.unpriced_calls ? "+" : ""}` : "");
function usageTable(byModel) {
  const rows = Object.entries(byModel || {}).sort((a, b) => b[1].cost - a[1].cost);
  if (!rows.length) return `<div class="hint">No AI calls yet.</div>`;
  return `<table class="usage"><tr><th>Model</th><th>Calls</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr>${rows.map(([k, u]) => {
    const [pr, ...m] = k.split(":");
    return `<tr><td>${esc(m.join(":") || "?")}<div class="hint">${esc((META.providers[pr] || {}).label || pr)}</div></td><td>${u.calls}</td><td>${toks(u.in)}</td><td>${toks(u.cache_read + u.cache_write)}</td><td>${toks(u.out)}</td>
      <td><b>${usd(u.cost)}</b>${u.unpriced_calls ? `<div class="hint">+ ${u.unpriced_calls} calls with no price</div>` : ""}</td></tr>`; }).join("")}</table>`;
}

function providerOptions(sel, allowDefault = true) {
  return (allowDefault ? `<option value="">Priority list (from Settings)</option>` : "") +
    Object.entries(META.providers).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)}</option>`).join("");
}

// per-film model dropdown: lists the models of the chosen provider (or the default one)
function filmModelCombo(provId, modelId, root) {
  delete LISTS[modelId];
  const load = async (fresh) => (await api(`/api/llm/models/${$(`#${provId}`).value || "default"}${fresh ? "?fresh=1" : ""}`)).models;
  const loaders = { [modelId]: load };
  wireCombos(root, loaders);
  loadCombo(modelId, loaders);
  $(`#${provId}`).addEventListener("change", () => { delete LISTS[modelId]; loadCombo(modelId, loaders); });
}

// ------------------------------------------------------------ film language + format pickers
const FILM_LANGS = [["English", "English"], ["Hindi", "हिंदी · Hindi"], ["Hinglish", "Hinglish · Hindi + English mix"]];
function languageOptions(sel) {
  const def = (META && META.channel_language) || "English";
  return `<option value="">Channel default (${esc(def)})</option>` +
    FILM_LANGS.map(([v, t]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${t}</option>`).join("") +
    (sel && !FILM_LANGS.some(([v]) => v === sel) ? `<option value="${esc(sel)}" selected>${esc(sel)}</option>` : "");
}
const FORMATS = [["16:9", "Long video · 16:9 landscape"], ["9:16", "YouTube Short · 9:16 vertical, max 3 min"], ["1:1", "Square · 1:1"]];
const formatOptions = (sel) => FORMATS.map(([v, t]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${t}</option>`).join("");
const LENGTHS_LONG = [[60, "60 s"], [90, "90 s"], [120, "2 min"], [180, "3 min"], [300, "5 min"], [480, "8 min"], [600, "10 min"]];
const LENGTHS_SHORT = [[20, "20 s"], [30, "30 s"], [45, "45 s"], [60, "60 s"], [90, "90 s"], [120, "2 min"], [180, "3 min (Shorts max)"]];
const lengthOptions = (aspect, sel) => (aspect === "9:16" ? LENGTHS_SHORT : LENGTHS_LONG).map(([v, t]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${t}</option>`).join("");

function newFilmModal(prefill = {}) {
  modal(`<h2>${prefill.aspect === "9:16" ? "New YouTube Short" : "New film"}</h2>
    <label>Title</label><input id="f-title" value="${esc(prefill.title || "")}" placeholder="The Wright Brothers: 12 Seconds">
    <label>Topic & angle</label><textarea id="f-topic" placeholder="What is the story? What should the viewer feel or learn?">${esc(prefill.notes || "")}</textarea>
    <label>Extra brief (optional)</label><textarea id="f-brief" style="min-height:60px" placeholder="Must-include facts, sources to use, tone, things to avoid…"></textarea>
    <div class="row"><div><label>Video type</label><select id="f-aspect">${formatOptions(prefill.aspect || "16:9")}</select></div>
      <div><label>Length</label><select id="f-dur">${lengthOptions(prefill.aspect || "16:9", prefill.aspect === "9:16" ? 60 : 90)}</select></div></div>
    <div class="hint" id="f-short-hint" style="display:${prefill.aspect === "9:16" ? "" : "none"}">Vertical 1080×1920 for the Shorts feed: fast hook, big text, one photo per scene. YouTube counts vertical videos up to 3 minutes as Shorts; 45–60 s usually performs best.</div>
    <label>Language of the film</label><select id="f-lang">${languageOptions("")}</select>
    <div class="hint" id="f-eta"></div>
    <label>Look</label><select id="f-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <div class="row"><div><label>AI provider</label><select id="f-prov">${providerOptions("")}</select></div>${combo("f-model", "Model", "", { load: true, empty: "(provider default)", ph: "exact model id" })}</div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="f-auto" checked style="width:auto"> Start the agent right away</label>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="f-go">Create film</button></div>`, (m, close) => {
    filmModelCombo("f-prov", "f-model", m);
    const showEta = async () => {
      try {
        const e = await api(`/api/eta?duration=${$("#f-dur", m).value}`);
        $("#f-eta", m).innerHTML = `⏱ About <b>${fmtDur(e.total_s)}</b> of agent work, plus the time you take for the 3 approvals` + (e.learned_from ? ` (based on your last ${Math.min(e.learned_from, 10)} films).` : ` (rough first guess; it gets more accurate after each film you finish).`);
      } catch (_) { /* estimate is optional */ }
    };
    $("#f-aspect", m).onchange = () => {
      const a = $("#f-aspect", m).value;
      $("#f-dur", m).innerHTML = lengthOptions(a, a === "9:16" ? 60 : 90);
      $("#f-short-hint", m).style.display = a === "9:16" ? "" : "none";
      showEta();
    };
    $("#f-dur", m).onchange = showEta; showEta();
    $("#f-go", m).onclick = (e) => act(e.target, async () => {
      const p = await api("/api/projects", { method: "POST", body: {
        title: $("#f-title", m).value, topic: $("#f-topic", m).value || $("#f-title", m).value, brief: $("#f-brief", m).value,
        duration_s: +$("#f-dur", m).value, aspect: $("#f-aspect", m).value, language: $("#f-lang", m).value, look: $("#f-look", m).value,
        provider: $("#f-prov", m).value, model: $("#f-model", m).value, autostart: $("#f-auto", m).checked, idea_id: prefill.id || null } });
      close(); location.hash = `#/films/${p.id}`;
    });
  });
}

// ------------------------------------------------------------ project view
const PV = { pid: null, after: 0, files: [], tab: "files", selected: null, project: null, lastFileRefresh: 0 };

async function viewProject(pid) {
  Object.assign(PV, { pid, after: 0, loaded: false, unseen: 0, selected: null, tab: PV.pid === pid ? PV.tab : "files" });
  const main = shell("films", `<div class="spin"></div>`);
  let p;
  try { p = await api(`/api/projects/${pid}`); } catch (e) { main.innerHTML = `<div class="empty">Film not found. <a href="#/">Back</a></div>`; return; }
  PV.project = p;
  main.innerHTML = `
    <div class="top"><a href="#/" class="btn ghost">←</a><div class="grow"><h1 id="p-title" style="margin:0">${esc(p.title)}</h1><div class="sub" id="p-sub"></div></div>
      <span id="p-pill"></span><span id="p-actions"></span>
      <button class="ghost" id="p-more" title="More">⋯</button></div>
    <div class="stepper" id="stepper"></div><div class="eta hint" id="eta"></div>
    <div class="proj">
      <section class="card"><div id="approval"></div>
        <h3 style="display:flex;justify-content:space-between;align-items:center">Agent <span style="display:flex;gap:10px;align-items:center"><span class="hint" id="p-model"></span><label class="follow" title="Keep scrolling to the newest entry as the agent works"><input type="checkbox" id="feed-follow"> Follow</label><button class="sm ghost" id="clear-log" title="Clear this film's activity log. The agent's memory and the files stay.">🧹 Clear log</button></span></h3>
        <div class="feed-wrap"><div class="feed" id="feed"></div><button class="sm feed-new" id="feed-new" style="display:none"></button></div><div id="live"></div>
        <div class="composer"><textarea id="msg" placeholder="Message the agent… (Ctrl+Enter to send)"></textarea><button class="primary" id="send">Send</button></div>
      </section>
      <section class="card"><div class="tabs" id="tabs">
        ${[["files", "Files"], ["preview", "Preview"], ["publish", "Publish to YouTube"], ["details", "Details"]].map(([k, t]) => `<button data-t="${k}">${t}</button>`).join("")}
        </div><div id="tab"></div></section>
    </div>`;
  $("#send").onclick = sendMsg;
  $("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMsg(); });
  try { $("#feed-follow").checked = localStorage.getItem("feedFollow") === "1"; } catch (_) {}
  $("#feed-follow").onchange = (e) => { try { localStorage.setItem("feedFollow", e.target.checked ? "1" : "0"); } catch (_) {} if (e.target.checked) { $("#feed").scrollTop = $("#feed").scrollHeight; PV.unseen = 0; $("#feed-new").style.display = "none"; } };
  $("#feed-new").onclick = () => { $("#feed").scrollTop = $("#feed").scrollHeight; PV.unseen = 0; $("#feed-new").style.display = "none"; };
  $("#feed").addEventListener("scroll", () => { const f = $("#feed"); if (f.scrollHeight - f.scrollTop - f.clientHeight < 40) { PV.unseen = 0; $("#feed-new").style.display = "none"; } });
  $("#clear-log").onclick = (e) => act(e.target, async () => {
    if (!confirm("Clear this film's activity log? The agent's memory and the film's files are kept.")) return;
    await api(`/api/projects/${p.id}/events`, { method: "DELETE" });
    $("#feed").innerHTML = `<div class="ev system">Log cleared.</div>`;
  });
  $("#p-more").onclick = moreMenu;
  $$("#tabs button").forEach((b) => (b.onclick = () => { PV.tab = b.dataset.t; renderTab(); }));
  renderHeader(p);
  renderTab();
  poll();
}

function renderHeader(p) {
  PV.project = p;
  const st = p.running ? "running" : p.status;
  $("#p-pill").innerHTML = `<span class="pill ${st}">${statusLabel(st)}</span>`;
  $("#p-sub").innerHTML = esc(`${p.topic || ""}`.slice(0, 160)) + (p.usage && p.usage.calls
    ? ` <span class="cost-chip" title="AI cost so far (estimate). Breakdown: Details tab.">💰 ${costLabel(p.usage)} · ${toks(totalToks(p.usage))} tokens</span>` : "");
  $("#p-model").textContent = `${p.provider || "priority list"}${p.model ? " · " + p.model : ""}`;
  const acts = $("#p-actions");
  if (p.running) acts.innerHTML = `<button class="danger" id="b-stop">■ Stop</button>`;
  else if (p.status === "awaiting_approval") acts.innerHTML = "";
  else acts.innerHTML = `<button class="primary" id="b-start">${p.status === "new" ? "▶ Start agent" : p.status === "done" ? "▶ Continue" : "▶ Resume"}</button>`;
  const b1 = $("#b-start"), b2 = $("#b-stop");
  if (b1) b1.onclick = (e) => act(e.target, async () => { renderHeader(await api(`/api/projects/${p.id}/start`, { method: "POST" })); });
  if (b2) b2.onclick = (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/stop`, { method: "POST" }); toast("Stopping…"); });
  const ci = STAGES.indexOf(p.stage);
  $("#stepper").innerHTML = STAGES.map((s, i) => `<div class="st ${i < ci || p.stage === "done" ? "done" : i === ci ? "cur" : ""}"><i></i>${s}</div>`).join("");
  $("#eta").innerHTML = etaText(p);
  renderApproval(p);
}

function fileThumb(pid, f) {
  if (isImg(f)) return `<button class="thumb" data-open="${esc(f)}" title="${esc(f)}"><img loading="lazy" src="${rawUrl(pid, f)}"></button>`;
  return `<button class="thumb" data-open="${esc(f)}">${isVid(f) ? "▶ " : isAud(f) ? "♪ " : "📄 "}${esc(f.split("/").pop())}</button>`;
}

function renderApproval(p) {
  const box = $("#approval");
  if (!p.pending || p.status !== "awaiting_approval") { box.innerHTML = ""; box.dataset.key = ""; return; }
  const key = p.pending.tool_call_id;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const files = p.pending.files || [];
  box.innerHTML = `<div class="approval"><h3>✋ ${esc(p.pending.title)}</h3><div class="md">${md(p.pending.summary)}</div>
    ${files.length ? `<div class="files thumbs">${files.map((f) => fileThumb(p.id, f)).join("")}</div>` : ""}
    <textarea id="fb" placeholder="Notes or requested changes (optional for approval)"></textarea>
    <div style="display:flex;gap:8px"><button class="primary" id="ap-yes">✓ Approve & continue</button><button id="ap-no">Request changes</button></div></div>`;
  $$("[data-open]", box).forEach((b) => (b.onclick = () => openFile(b.dataset.open)));
  $("#ap-yes").onclick = (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/approve`, { method: "POST", body: { approved: true, feedback: $("#fb").value } }); box.innerHTML = ""; box.dataset.key = ""; });
  $("#ap-no").onclick = (e) => act(e.target, async () => {
    if (!$("#fb").value.trim()) { $("#fb").focus(); throw new Error("Describe the changes you want"); }
    await api(`/api/projects/${p.id}/approve`, { method: "POST", body: { approved: false, feedback: $("#fb").value } }); box.innerHTML = ""; box.dataset.key = "";
  });
}

// "≈ 14 min" style durations for the time estimate
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 90) return `${Math.max(1, Math.round(sec / 60))} min`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim();
}
function etaText(p) {
  const e = p.eta;
  if (!e) return "";
  const basis = e.learned_from ? `based on your last ${Math.min(e.learned_from, 10)} film${e.learned_from === 1 ? "" : "s"}` : "first rough guess; it learns from your finished films";
  if (p.stage === "done" || p.status === "done") return e.done_s ? `<span title="Agent working time, not counting your approvals">⏱ made in ${fmtDur(e.done_s)} of agent work</span>` : "";
  const lead = p.status === "awaiting_approval" ? "waiting for your approval, then" : p.running || p.status === "running" ? "" : "when started,";
  return `<span title="Agent working time still needed (${basis}). Time you take for approvals is extra.">⏱ ${lead} ≈ ${fmtDur(e.left_s)} left</span>`;
}

// time of a log entry: "18:26:03", with the date in front when it isn't today
function evTime(ev) {
  if (!ev.created) return "";
  const d = new Date(ev.created * 1000), today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const day = d.toDateString() === today.toDateString() ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " ";
  return `<span class="ev-time" title="${esc(d.toLocaleString())}">${day}${time}</span>`;
}
function eventHtml(ev) {
  // put the time stamp inside the entry's first tag
  return eventBody(ev).replace(/^(<div[^>]*>)/, `$1${evTime(ev)}`);
}
function eventBody(ev) {
  const t = esc(ev.text || "");
  switch (ev.kind) {
    case "assistant": return `<div class="ev assistant md">${md(ev.text)}</div>`;
    case "user": return `<div class="ev user">${t}</div>`;
    case "tool": return `<div class="ev tool" data-tool="${ev.id}"><b>${esc(ev.meta?.name || "tool")}</b> ${t.length > 220 ? t.slice(0, 220) + "…" : t}<pre class="out">…</pre></div>`;
    case "tool_result": return null;
    case "waiting": return null;
    case "image": return `<div class="ev image"><div class="hint">Agent reviewed ${t}</div><img loading="lazy" src="${rawUrl(PV.pid, ev.text)}" data-open="${t}"></div>`;
    case "stage": return `<div class="ev stage">— ${t} stage —</div>`;
    case "approval": return `<div class="ev system">✋ Asked for approval: ${t}</div>`;
    case "error": return `<div class="ev error">${t}</div>`;
    case "done": return `<div class="ev done md"><b>🎬 Film finished</b>${md(ev.text)}</div>`;
    default: return `<div class="ev system">${t}</div>`;
  }
}

async function poll() {
  if (location.hash !== `#/films/${PV.pid}`) return;
  try {
    const d = await api(`/api/projects/${PV.pid}/events?after=${PV.after}`);
    const feed = $("#feed");
    if (!feed) return;
    const first = !PV.loaded; // on opening a film, jump to the latest entry once
    const follow = (() => { try { return localStorage.getItem("feedFollow") === "1"; } catch (_) { return false; } })();
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    let added = 0;
    let lastTool = $$(".ev.tool", feed).pop();
    for (const ev of d.events) {
      PV.after = ev.id;
      if (ev.kind === "tool_result") {
        if (lastTool) $(".out", lastTool).textContent = ev.text;
        continue;
      }
      const h = eventHtml(ev);
      if (!h) continue;
      feed.insertAdjacentHTML("beforeend", h); added++;
      if (ev.kind === "tool") lastTool = feed.lastElementChild;
    }
    $$(".ev.tool", feed).forEach((el) => (el.onclick = () => el.classList.toggle("open")));
    $$(".ev.image img", feed).forEach((el) => (el.onclick = () => openFile(el.dataset.open)));
    if (first || (follow && atBottom && added)) feed.scrollTop = feed.scrollHeight;
    else if (added && !atBottom) { PV.unseen = (PV.unseen || 0) + added; } // the reader is scrolled up: leave them there
    PV.loaded = true;
    const pill = $("#feed-new");
    if (pill) {
      if (atBottom && !added) PV.unseen = 0;
      pill.style.display = PV.unseen ? "" : "none";
      pill.textContent = `↓ ${PV.unseen} new`;
    }
    const prev = PV.project;
    renderHeader(d.project);
    const L = d.live;
    $("#live").innerHTML = L.running && (L.current || L.lines.length)
      ? `<div class="live"><div class="now">${L.current ? "● " + esc(L.current) : ""}</div>${esc(L.lines.slice(-14).join("\n"))}</div>` : "";
    const changed = d.events.some((e) => ["tool_result", "done", "system"].includes(e.kind));
    if (changed && Date.now() - PV.lastFileRefresh > 4000 && ["files", "preview"].includes(PV.tab)) { PV.lastFileRefresh = Date.now(); refreshFiles(); }
    if (prev && prev.status !== d.project.status && PV.tab === "publish") renderTab();
  } catch (e) { /* transient */ }
  const fast = PV.project && (PV.project.running || PV.project.status === "running");
  pollTimer = setTimeout(poll, fast ? 1500 : 4000);
}

async function sendMsg() {
  const t = $("#msg").value.trim();
  if (!t) return;
  $("#msg").value = "";
  try { await api(`/api/projects/${PV.pid}/message`, { method: "POST", body: { text: t } }); } catch (e) { toast(e.message, true); }
}

function moreMenu() {
  const p = PV.project;
  modal(`<h2>${esc(p.title)}</h2>
    <p class="hint">Workspace folder on the server: <code>projects/${esc(p.slug)}</code></p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">
      <button id="m-clearlog">🧹 Clear activity log</button>
      <button id="m-reset">↺ Clear agent memory (keep files)</button>
      <button class="danger" id="m-del">🗑 Delete film (keep files on server)</button>
      <button class="danger" id="m-delall">🗑 Delete film and all its files</button></div>
    <div class="actions"><button data-close>Close</button></div>`, (m, close) => {
    $("#m-clearlog", m).onclick = (e) => act(e.target, async () => { if (!confirm("Clear this film's activity log? Memory and files are kept.")) return; await api(`/api/projects/${p.id}/events`, { method: "DELETE" }); close(); viewProject(p.id); });
    $("#m-reset", m).onclick = (e) => act(e.target, async () => { if (!confirm("The agent will forget the conversation. Files stay. Continue?")) return; await api(`/api/projects/${p.id}/reset`, { method: "POST" }); close(); viewProject(p.id); });
    const del = (files) => act(null, async () => {
      if (!confirm(files ? "Delete this film AND all its rendered files? This cannot be undone." : "Delete this film from the app?")) return;
      await api(`/api/projects/${p.id}${files ? "?files=1" : ""}`, { method: "DELETE" }); close(); location.hash = "#/";
    });
    $("#m-del", m).onclick = () => del(false);
    $("#m-delall", m).onclick = () => del(true);
  });
}

// ---------- tabs
function renderTab() {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === PV.tab));
  const el = $("#tab");
  if (PV.tab === "files") return tabFiles(el);
  if (PV.tab === "preview") return tabPreview(el);
  if (PV.tab === "publish") return tabPublish(el);
  return tabDetails(el);
}

async function refreshFiles() {
  try { PV.files = await api(`/api/projects/${PV.pid}/files`); } catch (e) { return; }
  if (PV.tab === "files") drawTree();
  if (PV.tab === "preview") tabPreview($("#tab"));
}

function tabFiles(el) {
  el.innerHTML = `<div class="tree" id="tree"><div class="hint" style="padding:10px">Loading…</div></div>
    <div class="drop" id="drop">⬆ Drop your own photos, voice recording or music here (or click). They go to <code>uploads/</code> and the agent is told about them.<input type="file" id="up" multiple hidden></div>
    <div class="viewer" id="viewer"></div>`;
  const drop = $("#drop"), up = $("#up");
  drop.onclick = () => up.click();
  up.onchange = () => uploadFiles(up.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); };
  refreshFiles();
  if (PV.selected) openFile(PV.selected, true);
}

async function uploadFiles(list) {
  if (!list.length) return;
  const fd = new FormData();
  [...list].forEach((f) => fd.append("files", f));
  fd.append("dir", "uploads");
  try { const r = await api(`/api/projects/${PV.pid}/upload`, { method: "POST", body: fd }); toast(`Uploaded ${r.saved.length} file(s)`); refreshFiles(); }
  catch (e) { toast(e.message, true); }
}

function drawTree() {
  const tree = $("#tree");
  if (!tree) return;
  if (!PV.files.length) { tree.innerHTML = `<div class="hint" style="padding:12px">No files yet. The agent creates them as it works.</div>`; return; }
  const groups = {};
  PV.files.forEach((f) => { const d = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "."; (groups[d] = groups[d] || []).push(f); });
  tree.innerHTML = Object.keys(groups).sort().map((d) => `<div class="dir">${esc(d === "." ? "workspace" : d)}</div>` +
    groups[d].map((f) => `<div class="f ${f.path === PV.selected ? "on" : ""}" data-p="${esc(f.path)}"><span>${esc(f.path.split("/").pop())}</span><span>${fmtSize(f.size)}</span></div>`).join("")).join("");
  $$(".f", tree).forEach((x) => (x.onclick = () => openFile(x.dataset.p)));
}

async function openFile(path, noTabSwitch) {
  if (PV.tab !== "files" && !noTabSwitch) { PV.selected = path; PV.tab = "files"; renderTab(); return; }
  PV.selected = path;
  $$("#tree .f").forEach((x) => x.classList.toggle("on", x.dataset.p === path));
  const v = $("#viewer");
  if (!v) return;
  const head = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><code>${esc(path)}</code><a class="btn sm" href="${rawUrl(PV.pid, path, true)}">⬇ Download</a></div>`;
  if (isImg(path)) v.innerHTML = head + `<img src="${rawUrl(PV.pid, path)}">`;
  else if (isVid(path)) v.innerHTML = head + `<video controls src="${rawUrl(PV.pid, path)}"></video>`;
  else if (isAud(path)) v.innerHTML = head + `<audio controls src="${rawUrl(PV.pid, path)}"></audio>`;
  else if (isText(path)) {
    const blob = await api(rawUrl(PV.pid, path)).catch(() => null);
    const text = blob instanceof Blob ? await blob.text() : JSON.stringify(blob, null, 2);
    v.innerHTML = head + `<textarea class="code" id="ed" spellcheck="false">${esc(text)}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="primary sm" id="save">Save</button><button class="sm" id="tell">Save & tell the agent</button>
      ${ext(path) === "md" ? '<button class="sm ghost" id="prev">Preview</button>' : ""}</div><div id="mdprev" class="md"></div>`;
    const save = async (tell) => {
      await api(`/api/projects/${PV.pid}/file`, { method: "PUT", body: { path, content: $("#ed").value } });
      if (tell) await api(`/api/projects/${PV.pid}/message`, { method: "POST", body: { text: `I edited ${path} myself. Re-read it and use my version.` } });
      toast("Saved");
    };
    $("#save").onclick = (e) => act(e.target, () => save(false));
    $("#tell").onclick = (e) => act(e.target, () => save(true));
    if ($("#prev")) $("#prev").onclick = () => ($("#mdprev").innerHTML = md($("#ed").value));
  } else v.innerHTML = head + `<div class="hint">No preview for this file type.</div>`;
}

function tabPreview(el) {
  const p = PV.project;
  const vids = PV.files.filter((f) => isVid(f.path)).sort((a, b) => b.mtime - a.mtime);
  const stills = PV.files.filter((f) => isImg(f.path) && !f.path.startsWith("uploads/") && /still|contact|strip|review|frame|preview|out\//i.test(f.path)).sort((a, b) => b.mtime - a.mtime).slice(0, 24);
  if (!PV.files.length) { refreshFiles(); }
  const main = p.final_video || (vids[0] && vids[0].path);
  const renderBar = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap"><button class="sm" id="r-draft" ${p.running ? "disabled" : ""}>Render 30 s draft</button><button class="sm" id="r-final" ${p.running ? "disabled" : ""}>Render final film</button><span class="hint">Renders film.json as it is now, without the agent.</span></div>`;
  el.innerHTML = renderBar + (main ? `<div class="viewer" style="margin:0"><video controls id="pv" src="${rawUrl(p.id, main)}"></video>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><code>${esc(main)}</code>
      <span><a class="btn sm" href="${rawUrl(p.id, main, true)}">⬇ MP4</a> ${p.final_srt ? `<a class="btn sm" href="${rawUrl(p.id, p.final_srt, true)}">⬇ SRT</a>` : ""}</span></div></div>`
    : `<div class="empty" style="padding:30px">No video rendered yet. Drafts and the final film show up here.</div>`);
  if (vids.length > 1) el.innerHTML += `<h3 style="margin-top:18px">All renders</h3><div class="chips">${vids.map((v) => `<span class="chip" data-v="${esc(v.path)}">${esc(v.path)} · ${ago(v.mtime)}</span>`).join("")}</div>`;
  if (stills.length) el.innerHTML += `<h3 style="margin-top:18px">Review stills</h3><div class="thumbs">${stills.map((s) => fileThumb(p.id, s.path)).join("")}</div>`;
  $$("[data-v]", el).forEach((c) => (c.onclick = () => { $("#pv").src = rawUrl(p.id, c.dataset.v); }));
  const manual = (q) => (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/render`, { method: "POST", body: { quality: q } }); toast("Rendering… progress shows in the Agent panel"); });
  if ($("#r-draft", el)) $("#r-draft", el).onclick = manual("draft");
  if ($("#r-final", el)) $("#r-final", el).onclick = manual("final");
  $$("[data-open]", el).forEach((b) => (b.onclick = () => openFile(b.dataset.open)));
}

async function tabPublish(el) {
  let designed = [];
  try { const fl = await api(`/api/projects/${PV.pid}/files`); designed = (Array.isArray(fl) ? fl : fl.files || []).map((f) => f.path || f).filter((f) => /^out\/thumb_\d\.png$/.test(f)).sort(); } catch (_) {}
  const p = PV.project;
  el.innerHTML = `<div class="spin"></div>`;
  const [m, settings] = await Promise.all([api(`/api/projects/${p.id}/metadata`), api("/api/settings")]);
  const yt = settings.youtube_status;
  const localDT = (iso) => { if (!iso) return ""; const d = new Date(iso); const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div class="hint">${yt.connected ? `Connected to <b style="color:var(--text)">${esc(yt.channel || "your channel")}</b>` : `YouTube not connected. <a href="#/settings">Connect it in Settings</a>`}</div>
      <button class="primary" id="gen">✨ Generate with AI</button></div>
    <div class="seo-card" id="seo-card"><div class="hint">Checking SEO…</div></div>
    ${(m.title_options || []).length ? `<label>Title options (click to use) — best first</label><div class="title-opts">${m.title_options.map((o) => { const t = typeof o === "string" ? { title: o } : o;
      return `<button type="button" class="topt" data-title="${esc(t.title)}"><span>${esc(t.title)}</span>${t.score ? `<b class="score s${t.score >= 8 ? "hi" : t.score >= 6 ? "mid" : "lo"}">${t.score}/10</b>` : ""}${t.why ? `<small>${esc(t.why)}</small>` : ""}</button>`; }).join("")}</div>` : ""}
    <label>Title <span class="hint" id="tlen"></span></label><input id="m-title" maxlength="100" value="${esc(m.title || "")}">
    <label>Description</label><textarea id="m-desc" style="min-height:220px">${esc(m.description || "")}</textarea>
    <label>Tags (comma separated)</label><input id="m-tags" value="${esc((m.tags || []).join(", "))}">
    ${(m.chapters || []).length ? `<label>Chapters</label><pre class="live" style="max-height:none">${esc(m.chapters.map((c) => `${c.time} ${c.label}`).join("\n"))}</pre>` : ""}
    <div class="row"><div><label>Category</label><select id="m-cat">${Object.entries(META.categories).map(([k, v]) => `<option value="${k}" ${k === (m.category_id || "27") ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div><label>Visibility</label><select id="m-priv">${["private", "unlisted", "public"].map((v) => `<option ${v === m.privacy ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div><label>Language</label><input id="m-lang" value="${esc(m.language || "")}" placeholder="auto (from the film)"></div></div>
    <label>Schedule publish (optional, your local time)</label><input type="datetime-local" id="m-at" value="${localDT(m.publish_at)}">
    <div class="hint">When scheduled, the video uploads as private and YouTube makes it public at that time.</div>
    ${m.pinned_comment || (m.hashtags || []).length ? `<div class="seo-extra">
      ${m.pinned_comment ? `<label>Pinned comment (post it yourself after upload and pin it: questions get people commenting)</label>
        <div class="copyrow"><input id="m-pin" value="${esc(m.pinned_comment)}" readonly><button type="button" class="sm" data-copy="#m-pin">Copy</button></div>` : ""}
      ${(m.hashtags || []).length ? `<div class="hint">Hashtags: ${m.hashtags.map((h) => esc(String(h).startsWith("#") ? h : "#" + h)).join(" ")} (also at the end of the description)</div>` : ""}
    </div>` : ""}
    <hr><h3 style="display:flex;justify-content:space-between;align-items:center">Thumbnail <button class="sm" id="t-design" title="The AI picks the best photos and writes short, clickable text">✨ Design 3 thumbnails</button></h3>
    ${designed.length ? `<div class="thumb-pick">${designed.map((f) => `<button class="tp ${f === m.thumbnail_path ? "on" : ""}" data-use="${esc(f)}" title="Use this one"><img src="${rawUrl(p.id, f)}?v=${Date.now()}"><span>${f === m.thumbnail_path ? "✓ Selected" : "Use this"}</span></button>`).join("")}</div>` : ""}
    ${(m.thumbnail_ideas || []).length && !designed.length ? `<div class="md" style="color:var(--muted)"><ul>${m.thumbnail_ideas.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <div style="width:240px">${m.thumbnail_path ? `<img src="${rawUrl(p.id, m.thumbnail_path)}" style="width:100%;border-radius:8px;border:1px solid var(--line)">` : `<div class="thumb">no thumbnail</div>`}</div>
      <div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;gap:6px"><input id="t-sec" type="number" step="0.1" min="0" value="3" style="width:90px"><button class="sm" id="t-grab">Grab frame at seconds</button></div>
        <button class="sm" id="t-up">⬆ Upload my own (1280×720 JPG/PNG)</button><input type="file" id="t-file" accept="image/png,image/jpeg" hidden>
        <div class="hint">Custom thumbnails need a verified YouTube channel.</div></div></div>
    <hr>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button id="m-save">Save</button>
      <button class="primary" id="m-upload" ${!p.final_video || !yt.connected ? "disabled" : ""}>⬆ Upload to YouTube</button>
      ${!p.final_video ? '<span class="hint">Available once the film is finished.</span>' : ""}</div>
    <div id="upstat"></div>`;
  const tl = () => ($("#tlen").textContent = `${$("#m-title").value.length}/100`); tl(); $("#m-title").oninput = tl;
  $$("[data-title]", el).forEach((c) => (c.onclick = () => { $("#m-title").value = c.dataset.title; tl(); }));
  $$("[data-copy]", el).forEach((b) => (b.onclick = async () => { const i = $(b.dataset.copy); i.select(); try { await navigator.clipboard.writeText(i.value); } catch (_) { document.execCommand("copy"); } toast("Copied"); }));
  const collect = () => ({ title: $("#m-title").value, description: $("#m-desc").value,
    tags: $("#m-tags").value.split(",").map((s) => s.trim()).filter(Boolean), category_id: $("#m-cat").value,
    privacy: $("#m-priv").value, language: $("#m-lang").value, publish_at: $("#m-at").value ? new Date($("#m-at").value).toISOString().replace(/\.\d+Z$/, "Z") : "" });
  const save = () => api(`/api/projects/${p.id}/metadata`, { method: "PUT", body: collect() });
  $("#m-save").onclick = (e) => act(e.target, async () => { await save(); toast("Saved"); });
  $("#gen").onclick = (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/metadata/generate`, { method: "POST" }); toast("Metadata generated"); tabPublish(el); });
  $("#t-grab").onclick = (e) => act(e.target, async () => { await save(); await api(`/api/projects/${p.id}/thumbnail`, { method: "POST", body: { seconds: +$("#t-sec").value } }); tabPublish(el); });
  $("#t-design").onclick = (e) => act(e.target, async () => { await save(); toast("Designing thumbnails… (about 20 s)"); await api(`/api/projects/${p.id}/thumbnails/design`, { method: "POST" }); tabPublish(el); });
  $$("[data-use]", el).forEach((b) => (b.onclick = (e) => act(b, async () => { await api(`/api/projects/${p.id}/thumbnail`, { method: "POST", body: { path: b.dataset.use } }); tabPublish(el); })));
  $("#t-up").onclick = () => $("#t-file").click();
  $("#t-file").onchange = () => act(null, async () => { await save(); const fd = new FormData(); fd.append("file", $("#t-file").files[0]); await api(`/api/projects/${p.id}/thumbnail`, { method: "POST", body: fd }); tabPublish(el); });
  $("#m-upload").onclick = (e) => act(e.target, async () => {
    const d = collect();
    if (!d.title) throw new Error("Add a title first");
    if (!confirm(`Upload "${d.title}" to ${yt.channel || "YouTube"} as ${d.publish_at ? "scheduled for " + new Date(d.publish_at).toLocaleString() : d.privacy}?`)) return;
    await save(); await api(`/api/projects/${p.id}/youtube-upload`, { method: "POST" }); watchUpload(p.id);
  });
  if (m.upload_status && m.upload_status !== "done") watchUpload(p.id); else showUpload(m);
  showSeo(p, el);
}

async function showSeo(p, el) {
  const box = $("#seo-card");
  if (!box) return;
  let r;
  try { r = await api(`/api/projects/${p.id}/seo`); } catch (e) { box.innerHTML = `<div class="hint">SEO check failed: ${esc(e.message)}</div>`; return; }
  const cls = r.score >= 80 ? "hi" : r.score >= 55 ? "mid" : "lo";
  const pv = r.preview || {};
  box.innerHTML = `<div class="seo-head"><div class="seo-score ${cls}"><b>${r.score}</b><span>SEO</span></div>
      <div><b>${r.score >= 80 ? "Ready for YouTube search" : r.score >= 55 ? "Good, a few things to improve" : "Needs work before uploading"}</b>
      <div class="hint">Uploads are optimised automatically: anything still missing is written for you, and characters or tag lengths YouTube would reject are fixed. Language: <b>${esc(r.language)}</b>${Object.keys(pv.localizations || {}).length ? `, also titled in <b>${Object.keys(pv.localizations).join(", ")}</b>` : ""}.</div></div>
      <button class="sm primary" id="seo-fix">✨ Fix SEO automatically</button></div>
    <ul class="seo-list">${r.checks.map((c) => `<li class="${c.ok ? "ok" : "no"}"><span>${c.ok ? "✓" : "✗"}</span><div>${esc(c.msg)}${c.tip ? `<div class="hint">${esc(c.tip)}</div>` : ""}</div></li>`).join("")}</ul>
    <details class="seo-preview"><summary>Exactly what will be uploaded</summary>
      <label>Title</label><div class="pv">${esc(pv.title || "")}</div>
      <label>Description</label><pre class="pv">${esc(pv.description || "")}</pre>
      <label>Tags (${(pv.tags || []).length})</label><div class="pv">${esc((pv.tags || []).join(", "))}</div>
      ${Object.entries(pv.localizations || {}).map(([k, v]) => `<label>Title in ${esc(k)}</label><div class="pv">${esc(v.title)}</div>`).join("")}
      ${(pv.fixes || []).length ? `<div class="hint">Fixed automatically on upload: ${esc(pv.fixes.join(", "))}</div>` : ""}
    </details>`;
  $("#seo-fix").onclick = (e) => act(e.target, async () => { toast("Improving SEO… (about 20 s)"); await api(`/api/projects/${p.id}/seo/fix`, { method: "POST" }); toast("SEO improved"); tabPublish(el); });
}

function showUpload(m) {
  const box = $("#upstat");
  if (!box || !m.upload_status) return;
  box.innerHTML = `<div class="card" style="margin-top:12px;background:#17140f">
    <div style="display:flex;justify-content:space-between"><b>YouTube upload: ${esc(m.upload_status)}</b><span>${m.upload_progress || 0}%</span></div>
    <div class="progress"><i style="width:${m.upload_progress || 0}%"></i></div>
    ${m.youtube_id ? `<a href="https://youtu.be/${esc(m.youtube_id)}" target="_blank">▶ youtu.be/${esc(m.youtube_id)}</a> · <a href="https://studio.youtube.com/video/${esc(m.youtube_id)}/edit" target="_blank">Open in YouTube Studio</a>` : ""}
    ${m.upload_error ? `<div class="ev error" style="margin-top:8px">${esc(m.upload_error)}</div>` : ""}</div>`;
}

async function watchUpload(pid) {
  const m = await api(`/api/projects/${pid}/metadata`).catch(() => null);
  if (!m || PV.tab !== "publish" || PV.pid !== pid) return;
  showUpload(m);
  if (m.upload_status && !/^(done|error)/.test(m.upload_status)) setTimeout(() => watchUpload(pid), 2000);
}

function tabDetails(el) {
  const p = PV.project;
  el.innerHTML = `<label>Title</label><input id="d-title" value="${esc(p.title)}">
    <label>Topic & angle</label><textarea id="d-topic">${esc(p.topic || "")}</textarea>
    <label>Brief</label><textarea id="d-brief">${esc(p.brief || "")}</textarea>
    <div class="row"><div><label>Length (seconds)</label><input type="number" id="d-dur" value="${p.duration_s}"></div>
      <div><label>Video type</label><select id="d-aspect">${formatOptions(p.aspect || "16:9")}</select></div></div>
    <label>Language of the film</label><select id="d-lang">${languageOptions(p.language || "")}</select>
    <label>Look</label><select id="d-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}" ${k === p.look ? "selected" : ""}>${v}</option>`).join("")}</select>
    <div class="row"><div><label>AI provider</label><select id="d-prov">${providerOptions(p.provider || "")}</select></div>${combo("d-model", "Model", p.model || "", { load: true, empty: "(provider default)", ph: "exact model id" })}</div>
    <div class="hint">You can switch the AI model mid-film, e.g. a cheaper model for rendering steps. Changes to the brief apply the next time the agent starts.</div>
    <div class="row"><div><label>Final video path</label><input id="d-fv" value="${esc(p.final_video || "")}" placeholder="film/out/final.mp4"></div><div><label>Captions (SRT) path</label><input id="d-fs" value="${esc(p.final_srt || "")}"></div></div>
    <button class="primary" id="d-save" style="margin-top:16px">Save details</button>
    <div class="box" style="margin-top:22px"><h3>AI cost for this film: ${usd((p.usage || {}).cost)}</h3>
      ${usageTable((p.usage || {}).by_model)}
      <div class="hint">Estimated from token counts and the prices in Settings → AI models (OpenRouter reports the exact charge). Free tiers count as $0.</div></div>`;
  filmModelCombo("d-prov", "d-model", el);
  $("#d-save").onclick = (e) => act(e.target, async () => {
    const r = await api(`/api/projects/${p.id}`, { method: "PATCH", body: { title: $("#d-title").value, topic: $("#d-topic").value, brief: $("#d-brief").value,
      duration_s: +$("#d-dur").value, aspect: $("#d-aspect").value, language: $("#d-lang").value, look: $("#d-look").value, provider: $("#d-prov").value || null, model: $("#d-model").value || null,
      final_video: $("#d-fv").value || null, final_srt: $("#d-fs").value || null } });
    renderHeader(r); $("#p-title").textContent = r.title; toast("Saved");
  });
}

// ------------------------------------------------------------ ideas + calendar
const CAL = { y: new Date().getFullYear(), m: new Date().getMonth() };

async function viewIdeas() {
  const main = shell("ideas", `<div class="top"><div class="grow"><h1>Ideas & calendar</h1><div class="sub">Plan your pipeline. Drag ideas between columns, set a release date, turn any idea into a film.</div></div>
    <button id="bs">✨ Brainstorm ideas</button><button class="primary" id="add">＋ Add idea</button></div>
    <div class="kanban" id="kb"></div><hr>
    <div class="top" style="margin-bottom:12px"><h2 class="grow" id="cal-title" style="margin:0"></h2><button class="sm" id="cp">‹</button><button class="sm" id="ct">Today</button><button class="sm" id="cn">›</button></div>
    <div class="cal" id="cal"></div>`);
  $("#add").onclick = () => ideaModal({});
  $("#bs").onclick = () => modal(`<h2>Brainstorm ideas</h2><label>Theme or direction (optional)</label><input id="b-theme" placeholder="e.g. forgotten engineering disasters, 1920s gangsters, space race">
    <label>How many</label><select id="b-n"><option>5</option><option selected>8</option><option>12</option></select>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="b-go">Generate</button></div>`, (m, close) => {
    $("#b-go", m).onclick = (e) => act(e.target, async () => { const r = await api("/api/ideas/brainstorm", { method: "POST", body: { theme: $("#b-theme", m).value, count: +$("#b-n", m).value } }); close(); toast(`${r.length} ideas added`); drawIdeas(); });
  });
  $("#cp").onclick = () => { CAL.m--; if (CAL.m < 0) { CAL.m = 11; CAL.y--; } drawCal(); };
  $("#cn").onclick = () => { CAL.m++; if (CAL.m > 11) { CAL.m = 0; CAL.y++; } drawCal(); };
  $("#ct").onclick = () => { CAL.y = new Date().getFullYear(); CAL.m = new Date().getMonth(); drawCal(); };
  drawIdeas();
}

let IDEAS = [];
async function drawIdeas() {
  IDEAS = await api("/api/ideas");
  const kb = $("#kb");
  if (!kb) return;
  kb.innerHTML = IDEA_COLS.map(([k, t]) => {
    const items = IDEAS.filter((i) => (i.status || "idea") === k);
    return `<div class="col" data-col="${k}"><h4>${t}<span>${items.length}</span></h4>${items.map((i) => `<div class="idea" draggable="true" data-id="${i.id}">
      <b>${esc(i.title)}</b><p>${esc(i.notes || "")}</p>${i.publish_date ? `<div class="when">📅 ${i.publish_date}</div>` : ""}${i.project_id ? `<div class="when" style="color:var(--green)">🎞 film #${i.project_id}</div>` : ""}</div>`).join("")}</div>`;
  }).join("");
  $$(".idea", kb).forEach((c) => {
    c.ondragstart = (e) => e.dataTransfer.setData("text/plain", c.dataset.id);
    c.onclick = () => ideaModal(IDEAS.find((i) => i.id == c.dataset.id));
  });
  $$(".col", kb).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = () => col.classList.remove("over");
    col.ondrop = async (e) => { e.preventDefault(); col.classList.remove("over"); await api(`/api/ideas/${e.dataTransfer.getData("text/plain")}`, { method: "PATCH", body: { status: col.dataset.col } }); drawIdeas(); };
  });
  drawCal();
}

function ideaModal(i) {
  const isNew = !i.id;
  modal(`<h2>${isNew ? "New idea" : "Edit idea"}</h2><label>Title</label><input id="i-t" value="${esc(i.title || "")}">
    <label>Notes: hook, angle, sources, visuals</label><textarea id="i-n" style="min-height:120px">${esc(i.notes || "")}</textarea>
    <div class="row"><div><label>Status</label><select id="i-s">${IDEA_COLS.map(([k, t]) => `<option value="${k}" ${k === (i.status || "idea") ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label>Planned release date</label><input type="date" id="i-d" value="${esc(i.publish_date || "")}"></div></div>
    <div class="actions">${!isNew ? '<button class="danger" id="i-del" style="margin-right:auto">Delete</button>' : ""}
      ${!isNew && i.project_id ? `<a class="btn" href="#/films/${i.project_id}">Open film</a>` : ""}
      ${!isNew && !i.project_id ? '<button id="i-film">🎞 Make film</button>' : ""}
      <button data-close>Cancel</button><button class="primary" id="i-save">Save</button></div>`, (m, close) => {
    const body = () => ({ title: $("#i-t", m).value, notes: $("#i-n", m).value, status: $("#i-s", m).value, publish_date: $("#i-d", m).value || null });
    $("#i-save", m).onclick = (e) => act(e.target, async () => { await api(isNew ? "/api/ideas" : `/api/ideas/${i.id}`, { method: isNew ? "POST" : "PATCH", body: body() }); close(); drawIdeas(); });
    if ($("#i-del", m)) $("#i-del", m).onclick = () => act(null, async () => { if (!confirm("Delete this idea?")) return; await api(`/api/ideas/${i.id}`, { method: "DELETE" }); close(); drawIdeas(); });
    if ($("#i-film", m)) $("#i-film", m).onclick = async () => { await api(`/api/ideas/${i.id}`, { method: "PATCH", body: body() }); close(); newFilmModal({ ...i, ...body() }); };
  });
}

async function drawCal() {
  const cal = $("#cal");
  if (!cal) return;
  const data = await api("/api/calendar");
  const first = new Date(CAL.y, CAL.m, 1);
  $("#cal-title").textContent = first.toLocaleString(undefined, { month: "long", year: "numeric" });
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const byDay = {};
  data.ideas.forEach((i) => (byDay[i.publish_date] = byDay[i.publish_date] || []).push({ t: i.title, cls: i.status === "published" ? "pub" : "", go: () => ideaModal(IDEAS.find((x) => x.id === i.id) || i) }));
  data.uploads.forEach((u) => { const k = key(new Date(u.publish_at)); (byDay[k] = byDay[k] || []).push({ t: "▶ " + u.title, cls: "up", go: () => { PV.tab = "publish"; location.hash = `#/films/${u.project_id}`; } }); });
  const today = key(new Date());
  let html = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow">${d}</div>`).join("");
  const handlers = [];
  for (let n = 0; n < 42; n++) {
    const d = new Date(start); d.setDate(start.getDate() + n);
    const k = key(d);
    html += `<div class="day ${d.getMonth() !== CAL.m ? "other" : ""} ${k === today ? "today" : ""}" data-day="${k}"><div class="n">${d.getDate()}</div>${(byDay[k] || []).map((e) => { handlers.push(e.go); return `<div class="evt ${e.cls}" data-h="${handlers.length - 1}">${esc(e.t)}</div>`; }).join("")}</div>`;
  }
  cal.innerHTML = html;
  $$("[data-h]", cal).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); handlers[+el.dataset.h](); }));
  $$(".day", cal).forEach((el) => (el.ondblclick = () => ideaModal({ publish_date: el.dataset.day })));
}


// ------------------------------------------------------------ dropdowns with "type my own" (voices, models, languages…)
const CUSTOM = "__custom";
const LANGUAGES = ["English", "Hindi", "Hinglish (Hindi + English)", "Bengali", "Marathi", "Tamil", "Telugu", "Kannada", "Malayalam", "Gujarati", "Punjabi", "Urdu", "Odia", "Assamese",
  "Spanish", "Portuguese", "French", "German", "Italian", "Arabic", "Indonesian", "Japanese", "Korean", "Russian", "Turkish"].map((x) => ({ id: x, name: x }));
const ELEVEN_MODELS = [["eleven_multilingual_v2", "Multilingual v2", "best quality, 29 languages (recommended)"], ["eleven_v3", "Eleven v3", "most expressive, supports [audio tags]"],
  ["eleven_turbo_v2_5", "Turbo v2.5", "fast, cheaper"], ["eleven_flash_v2_5", "Flash v2.5", "fastest, cheapest"]].map(([id, name, info]) => ({ id, name, info }));
const OPENAI_TTS_MODELS = [["gpt-4o-mini-tts", "gpt-4o-mini-tts", "follows voice direction (recommended)"], ["tts-1-hd", "tts-1-hd", "high quality, no direction"], ["tts-1", "tts-1", "fast, lower quality"]].map(([id, name, info]) => ({ id, name, info }));
const timezones = () => {
  let z = []; try { z = Intl.supportedValuesOf("timeZone"); } catch (_) {}
  for (const extra of ["Asia/Kolkata", "UTC"]) if (!z.includes(extra)) z.push(extra); // browsers differ on the canonical names
  return z.sort().map((x) => ({ id: x, name: x.replace(/_/g, " "), info: x === "Asia/Kolkata" || x === "Asia/Calcutta" ? "India (IST)" : "" }));
};
const LISTS = {}; // id -> options shown in that dropdown

// markup: a <select> plus a hidden text input that holds the real value (so saving code just reads the input)
function combo(id, label, value, opts = {}) {
  return `<div class="combo-wrap"><label for="${id}-sel">${label}</label>
    <div class="combo"><select id="${id}-sel" data-combo="${id}" ${opts.empty ? `data-empty="${esc(opts.empty)}"` : ""}></select>${opts.load ? `<button type="button" class="sm ghost" data-reload="${id}" title="Reload the list">↻</button>` : ""}</div>
    <input id="${id}" class="combo-custom" value="${esc(value || "")}" placeholder="${esc(opts.ph || "Type the exact ID")}" autocomplete="off" style="display:none" ${opts.attrs || ""}>
    <div class="hint" id="${id}-info">${opts.hint || ""}</div>${opts.hint ? `<template id="${id}-hint">${opts.hint}</template>` : ""}</div>`;
}

// fill a combo; keeps the current value even if it isn't in the list
function fillCombo(id, list, state = "") {
  const sel = $(`#${id}-sel`), inp = $(`#${id}`);
  if (!sel) return;
  if (list) LISTS[id] = list;
  list = LISTS[id] || [];
  const v = inp.value.trim();
  const known = list.some((o) => o.id === v);
  const label = (o) => (o.name && o.name !== o.id ? `${o.name}  ·  ${o.id}` : o.id) + (o.info ? `  —  ${o.info}` : "");
  sel.innerHTML = (v ? "" : `<option value="">${state === "loading" ? "Loading…" : esc(sel.dataset.empty || "— choose —")}</option>`) +
    (v && !known ? `<option value="${esc(v)}">${esc(v)} (current)</option>` : "") +
    list.map((o) => `<option value="${esc(o.id)}">${esc(label(o)).slice(0, 140)}</option>`).join("") +
    (state === "loading" && v ? `<option disabled>Loading list…</option>` : "") +
    (state && state !== "loading" ? `<option disabled>${esc(state).slice(0, 120)}</option>` : "") +
    `<option value="${CUSTOM}">✎ Type my own…</option>`;
  sel.value = v;
  comboInfo(id);
}

function comboInfo(id) {
  const box = $(`#${id}-info`);
  if (!box) return;
  const o = (LISTS[id] || []).find((x) => x.id === $(`#${id}`).value);
  const base = ($(`#${id}-hint`) || {}).innerHTML || "";
  box.innerHTML = o && o.preview ? `<a href="#" data-prev="${esc(o.preview)}">▶ Preview this voice</a>${base ? " · " + base : ""}` : base;
  const a = box.querySelector("[data-prev]");
  if (a) a.onclick = (e) => { e.preventDefault(); const au = window._prevAudio || (window._prevAudio = new Audio()); au.src = a.dataset.prev; au.play(); };
}

// wire every combo inside root; loaders[id] = async () => list (or throws)
function wireCombos(root, loaders = {}) {
  $$("[data-combo]", root).forEach((sel) => {
    const id = sel.dataset.combo, inp = $(`#${id}`);
    if (!LISTS[id]) fillCombo(id, []);
    else fillCombo(id);
    sel.onchange = () => {
      if (sel.value === CUSTOM) { inp.style.display = ""; inp.focus(); inp.select(); }
      else { inp.value = sel.value; inp.style.display = "none"; }
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      comboInfo(id);
    };
    inp.onchange = () => fillCombo(id);
  });
  $$("[data-reload]", root).forEach((b) => (b.onclick = () => loadCombo(b.dataset.reload, loaders, true, b)));
}

async function loadCombo(id, loaders, fresh = false, btn = null) {
  const fn = loaders[id];
  if (!fn || !$(`#${id}-sel`)) return;
  fillCombo(id, null, "loading");
  if (btn) btn.disabled = true;
  try { fillCombo(id, await fn(fresh)); }
  catch (e) { fillCombo(id, null, `Could not load: ${e.message}`); if (fresh) toast(e.message, true); }
  finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------ settings
const SETTINGS_SECTIONS = [
  ["overview", "Overview", "◎"], ["channel", "Channel", "📺"], ["ai", "AI models", "🤖"], ["voice", "Narration voice", "🎙"],
  ["youtube", "YouTube", "▶"], ["telegram", "Telegram", "✈"], ["research", "Research", "🔎"], ["system", "System", "⚙"],
];

async function viewSettings(section = "overview") {
  if (!SETTINGS_SECTIONS.some(([k]) => k === section)) section = "overview";
  const main = shell("settings", `<div class="top"><div class="grow"><h1>Settings</h1><div class="sub">Keys are stored on your server and only the last 4 characters are ever shown again.</div></div></div><div id="body"><div class="spin"></div></div>`);
  const s = await api("/api/settings");
  // the browser loads new pages from disk right away, but the server keeps old code until it restarts
  const stale = !("llm_priority" in s) || (s.system || {}).restart_needed;
  if (stale) $(".top .grow", main).insertAdjacentHTML("beforeend", `<div class="restart-warn">⚠️ The app was updated, but the server is still running the old version, so some settings (like the AI priority list) won't save. <b>Restart the app</b>: close the Documentary Studio window and run <code>run_app.bat</code> again. On the server: cPanel → Setup Node.js App → Restart.</div>`);
  const prov = s.providers || {}, def = s.default_llm || {}, tts = s.tts || {}, ch = s.channel || {}, yt = s.youtube || {}, se = s.search || {}, tg = s.telegram || {};
  if (def.provider && def.model && !(prov[def.provider] || {}).model) (prov[def.provider] = prov[def.provider] || {}).model = def.model; // older default model -> provider card
  for (const [k, v] of Object.entries(META.providers)) if (v.default_model && !(prov[k] || {}).model) (prov[k] = prov[k] || {}).model = v.default_model;
  const prioList = s.llm_priority || [];
  // full row order as you left it (ticked and unticked); fall back to "ticked first" if it doesn't agree with the priority list
  let order = (s.llm_order || []).filter((k) => META.providers[k]);
  order = [...order, ...Object.keys(META.providers).filter((k) => !order.includes(k))];
  if (JSON.stringify(order.filter((k) => prioList.includes(k))) !== JSON.stringify(prioList.filter((k) => META.providers[k])))
    order = [...prioList.filter((k) => META.providers[k]), ...order.filter((k) => !prioList.includes(k))];
  const prioRows = order.map((k) => [k, META.providers[k]]);
  const sys = s.system || {}, dbs = sys.database || {};
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const ytStatus = s.youtube_status;
  if (location.hash.includes("yt=connected")) toast("YouTube channel connected");

  // ---- status of each area (for the overview and the menu dots)
  const has = (v) => !!(v && String(v).length);
  const aiUsable = prioList.filter((k) => META.providers[k] && (k === "custom" ? has((prov[k] || {}).base_url) : META.providers[k].no_key || has((prov[k] || {}).api_key)) && has((prov[k] || {}).model));
  const aiReady = aiUsable.length > 0;
  const vp = tts.provider || "none";
  const voiceReady = vp === "manual" || (vp === "openai" && (has(tts.openai_key) || has((prov.openai || {}).api_key))) ||
    (vp === "elevenlabs" && has(tts.elevenlabs_key) && has(tts.elevenlabs_voice)) || (vp === "aiawaaz" && has(tts.aiawaaz_key));
  const status = {
    channel: has(ch.name) ? ["ok", ch.name] : ["todo", "Add your channel name and style"],
    ai: aiReady ? ["ok", aiUsable.map((k) => META.providers[k].label).join(" → ") + (aiUsable.length > 1 ? " (auto-switch)" : "")] : ["need", "Required: add a key, choose a model and tick the provider in the priority list"],
    voice: voiceReady ? ["ok", META.tts_providers[vp].split(" (")[0]] : vp === "none" ? ["todo", "No voice: films are silent (fine for testing)"] : ["need", "Voice chosen but key/voice missing"],
    youtube: ytStatus.connected ? ["ok", `Connected: ${ytStatus.channel || "your channel"}`] : ["todo", "Not connected (needed only for auto-upload)"],
    telegram: tg.enabled && has(tg.bot_token) ? ["ok", "Enabled"] : ["todo", "Optional: control from your phone"],
    research: has(se.brave_key) ? ["ok", "Brave Search"] : ["ok", "Wikipedia (add Brave for full web search)"],
    system: dbs.backend === "mongodb" && dbs.ok ? ["ok", `MongoDB (${dbs.db})`] : dbs.error ? ["need", `Database problem: ${dbs.error}`] : ["ok", "Local files"],
  };
  const dot = (k) => (status[k] ? `<i class="sdot ${status[k][0]}"></i>` : "");

  const field = (id, label, value, opts = {}) => `<div><label for="${id}">${label}</label><input id="${id}" ${opts.type ? `type="${opts.type}"` : ""} value="${esc(value || "")}" placeholder="${esc(opts.ph || "")}" autocomplete="off">${opts.hint ? `<div class="hint">${opts.hint}</div>` : ""}</div>`;
  const voiceTile = (k, title, desc) => `<label class="tile ${vp === k ? "on" : ""}"><input type="radio" name="t-prov" value="${k}" ${vp === k ? "checked" : ""}><b>${title}</b><span>${desc}</span></label>`;

  $("#body").innerHTML = `<div class="settings">
    <nav class="snav">${SETTINGS_SECTIONS.map(([k, t, ic]) => `<a href="#/settings/${k}" data-sec="${k}" class="${k === section ? "on" : ""}"><span>${ic}</span>${t}${dot(k)}</a>`).join("")}</nav>
    <div class="spanes">

    <section class="spane" data-pane="overview">
      <h2>Setup checklist</h2><p class="hint">What's ready and what still needs doing. Click a row to open it.</p>
      <div class="checklist">${SETTINGS_SECTIONS.filter(([k]) => k !== "overview").map(([k, t, ic]) => `<a class="crow" href="#/settings/${k}"><span class="cic">${ic}</span><b>${t}</b><span class="cst ${status[k][0]}">${status[k][0] === "ok" ? "✓" : status[k][0] === "need" ? "!" : "○"} ${esc(status[k][1])}</span></a>`).join("")}</div>
      <p class="hint" style="margin-top:14px">Minimum to make films: <b>AI models</b>. Recommended: <b>Narration voice</b> and <b>Channel</b>. For publishing: <b>YouTube</b>.</p>
    </section>

    <section class="spane" data-pane="channel">
      <h2>Channel</h2><p class="hint">The agent and the YouTube metadata writer follow these.</p>
      <div class="row">${field("c-name", "Channel name", ch.name)}${combo("c-lang", "Language of your videos", ch.language || "English", { ph: "e.g. Bhojpuri" })}</div>
      <label for="c-style">Style, audience and tone</label><textarea id="c-style" placeholder="e.g. Calm, authoritative narration. History mysteries for adults 25-45. No sensationalism; always cite sources.">${esc(ch.style || "")}</textarea>
      <label for="c-footer">Description footer (added to every video description)</label><textarea id="c-footer" placeholder="Subscribe for more… · Music: … · Business: …">${esc(ch.footer || "")}</textarea>
    </section>

    <section class="spane" data-pane="ai">
      <h2>AI models</h2><p class="hint">The agent needs a model with tool calling. Strong models (Claude Sonnet/Opus, top GPT or Gemini) make much better films.</p>
      <div class="box"><h3>Provider priority</h3>
        <p class="hint" style="margin-top:0"><b>Tick ✓</b> the providers to use, and put them in order with ▲ ▼. Ticked providers are used in this order. If one fails (rate limit, daily quota, no credit, outage, bad key), the next one takes over automatically and the film carries on. A provider that hit a limit is paused for a while, then tried again.</p>
        <div class="restart-warn" id="prio-none" style="display:none">No provider is ticked, so films can't run. Tick at least one (✓ = in use).</div>
        <div id="prio">${prioRows.map(([k, v]) => { const c = prov[k] || {}; const ready = has(c.api_key) || (k === "custom" ? has(c.base_url) : !!v.no_key); const st = (s.llm_status || {})[k];
          return `<div class="prio-row" data-k="${k}"><label class="prio-on"><input type="checkbox" data-prio="${k}" ${prioList.includes(k) ? "checked" : ""}><span class="prio-n"></span></label>
          <div class="prio-main"><b>${esc(v.label)}</b> <span class="hint prio-model" data-for="${k}"></span>
            ${ready ? "" : '<span class="tag warn">no key</span>'}${st ? `<span class="tag warn" title="${esc(st.reason)}">paused ${st.minutes_left} min</span>` : ""}</div>
          <button type="button" class="sm ghost" data-up="${k}" title="Move up">▲</button><button type="button" class="sm ghost" data-down="${k}" title="Move down">▼</button></div>`; }).join("")}</div>
        <div class="hint">Set each provider's model under Provider keys below. A film can still be pinned to one provider (film → Details); the list above is then its backup.</div></div>
      <div class="box" style="margin-top:16px"><h3>Usage & cost</h3>
        ${(() => { const ms = (s.usage || {}).months || {}; const keys = Object.keys(ms).sort().reverse(); const cur = new Date().toISOString().slice(0, 7);
          const m = ms[cur]; const prev = keys.find((k) => k < cur);
          return `<div class="usage-sum"><div><b>${usd((m || {}).cost)}</b><span>This month</span></div><div><b>${toks(totalToks(m || {}))}</b><span>Tokens this month</span></div><div><b>${(m || {}).calls || 0}</b><span>AI calls</span></div>${prev ? `<div><b>${usd(ms[prev].cost)}</b><span>${prev}</span></div>` : ""}</div>
            ${usageTable((m || {}).by_model)}`; })()}
        <details class="prices"><summary>Prices used for the estimate</summary>
          <p class="hint">US$ per 1 million tokens. Leave empty to use the built-in estimate. Check your provider's pricing page and correct anything that changed.</p>
          <table class="usage"><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached input</th><th></th></tr>
          ${((s.usage || {}).prices || []).map((x) => { const own = (s.llm_prices || {})[x.model] || {}; const pr = x.price || [];
            return `<tr><td>${esc(x.model)}<div class="hint">${esc((META.providers[x.provider] || {}).label || x.provider)}</div></td>
              <td><input class="price" data-price="${esc(x.model)}" data-f="in" value="${esc(own.in ?? "")}" placeholder="${pr.length ? pr[0] : "?"}"></td>
              <td><input class="price" data-price="${esc(x.model)}" data-f="out" value="${esc(own.out ?? "")}" placeholder="${pr.length ? pr[1] : "?"}"></td>
              <td><input class="price" data-price="${esc(x.model)}" data-f="cache" value="${esc(own.cache ?? "")}" placeholder="${pr.length ? pr[2] : "?"}"></td>
              <td class="hint">${x.source === "yours" ? "your price" : x.source ? esc(x.source) : '<span style="color:#e8955c">no price — enter one</span>'}</td></tr>`; }).join("") || `<tr><td colspan="5" class="hint">Set a model for a provider first.</td></tr>`}</table>
        </details></div>
      <h3 style="margin-top:20px">Provider keys</h3>
      ${Object.entries(META.providers).map(([k, v]) => { const c = prov[k] || {}; const ready = has(c.api_key) || (k === "custom" ? has(c.base_url) : !!v.no_key); return `<details class="prov" ${k === prioList[0] ? "open" : ""}>
        <summary><span>${esc(v.label)}</span>${prioList.includes(k) ? `<span class="tag">#${prioList.indexOf(k) + 1}</span>` : ""}${has(c.api_key) ? '<span class="ok">● key saved</span>' : ready ? '<span class="ok">● no key needed</span>' : '<span class="hint">not set</span>'}</summary>${v.note ? `<div class="hint" style="margin:8px 0 0">${esc(v.note)}</div>` : ""}
        <div class="row">${field(`p-${k}-key`, "API key", c.api_key, { type: "password", ph: v.no_key ? "(optional)" : "paste key" }).replace("<input", `<input data-p="${k}" data-f="api_key"`)}${combo(`p-${k}-model`, "Model", c.model, { load: true, ph: v.model_hint, attrs: `data-p="${k}" data-f="model"` })}</div>
        ${combo(`p-${k}-backup`, "Backup model (used when the model above is busy)", c.backup_model || "", { load: true, ph: k === "gemini" ? "empty = another Flash model automatically" : "optional", attrs: `data-p="${k}" data-f="backup_model"` })}
        ${field(`p-${k}-url`, "Base URL (change only for proxies or self-hosted)", c.base_url, { ph: v.base_url }).replace("<input", `<input data-p="${k}" data-f="base_url"`)}
        <button class="sm" data-test="${k}" style="margin-top:10px">Test connection</button></details>`; }).join("")}
    </section>

    <section class="spane" data-pane="voice">
      <h2>Narration voice</h2><p class="hint">Who reads the narration. Captions always use the script text.</p>
      <div class="tiles">
        ${voiceTile("aiawaaz", "AI Awaaz", "Indian voices · Hindi + 20 languages")}
        ${voiceTile("elevenlabs", "ElevenLabs", "Very natural English voices")}
        ${voiceTile("openai", "OpenAI TTS", "Good voices with style direction")}
        ${voiceTile("manual", "Upload", "Any app or your own recording")}
        ${voiceTile("none", "None", "Silent drafts for testing")}
      </div>
      <div class="vopt" data-v="aiawaaz">
        <p class="hint">In app.aiawaaz.io open <b>Connect your AI tool</b> and create an API key. The app talks to AI Awaaz directly; you don't need Claude Desktop.</p>
        <div class="row">${field("t-akey", "API key", tts.aiawaaz_key, { type: "password", ph: "paste key" })}${combo("t-avoice", "Voice", tts.aiawaaz_voice, { load: true, ph: "voice ID or name", hint: "Loaded from your AI Awaaz account once the key is saved." })}</div>
        <div class="row">${field("t-aopts", "Extra options (JSON, optional)", tts.aiawaaz_options, { ph: '{"speed": 0.95}' })}<div><label>&nbsp;</label><label class="check"><input type="checkbox" id="t-aenh" ${tts.aiawaaz_enhance ? "checked" : ""}> Add emotions and pauses (V3 voices)</label></div></div>
        <details class="relaybox" ${tts.aiawaaz_relay_url ? "open" : ""}><summary><b>Relay</b> (only if this server can't reach AI Awaaz, e.g. on shared hosting)</summary>
          <p class="hint">Sends AI Awaaz requests through your own free Cloudflare Worker. Setup: copy the relay script below, then at <b>dash.cloudflare.com</b> → Workers &amp; Pages → Create → Hello World → Deploy → Edit code → paste it → Deploy. In the worker's Settings → Variables and Secrets add a <b>Secret</b> named <code>RELAY_KEY</code> with the relay key below. Paste the worker address here and save. Leave the address empty to connect directly.</p>
          <div class="row">${field("t-arelay", "Relay address", tts.aiawaaz_relay_url, { ph: "https://aiawaaz-relay.yourname.workers.dev" })}${field("t-arkey", "Relay key", tts.aiawaaz_relay_key, { type: "password", ph: "press Generate" })}</div>
          <div class="btnrow"><button class="sm" id="t-argen">Generate relay key</button><button class="sm" id="t-arscript">Copy relay script</button></div>
        </details>
        <div class="btnrow"><button class="sm" id="t-avoices">Voice details (text)</button><button class="sm" id="t-aacct">Plan & characters left</button></div>
        <pre class="live" id="t-aout" style="display:none;max-height:320px"></pre>
      </div>
      <div class="vopt" data-v="elevenlabs">
        <div class="row">${field("t-ekey", "API key", tts.elevenlabs_key, { type: "password" })}${combo("t-evoice", "Voice", tts.elevenlabs_voice, { load: true, ph: "voice ID", hint: "Your ElevenLabs voices, including cloned and library voices you added." })}</div>
        <div class="row">${combo("t-emodel", "Model", tts.elevenlabs_model || "eleven_multilingual_v2")}<div></div></div>
      </div>
      <div class="vopt" data-v="openai">
        <div class="row">${field("t-okey", "API key", tts.openai_key, { type: "password", hint: "Leave blank to use the OpenAI key from AI models." })}${combo("t-ovoice", "Voice", tts.openai_voice || "onyx")}</div>
        <div class="row">${combo("t-omodel", "Model", tts.openai_model || "gpt-4o-mini-tts")}${field("t-oinst", "Voice direction (optional)", tts.openai_instructions, { ph: "Deep, measured documentary narrator. Slow, with suspense." })}</div>
      </div>
      <div class="vopt" data-v="manual"><p class="hint">For each film the agent writes <code>voiceover_script.txt</code>. Record or generate one MP3 of the whole script, upload it on the film's Files tab (or send it to the Telegram bot), and the agent splits it into lines at the pauses.</p></div>
      <div class="vopt" data-v="none"><p class="hint">Films render silent with captions and estimated timing. Good for trying the app; choose a voice before making real videos.</p></div>
      <div class="btnrow" id="t-testrow"><button class="sm" id="t-test">▶ Test voice</button><audio id="t-audio" controls style="display:none;height:32px"></audio></div>
    </section>

    <section class="spane" data-pane="youtube">
      <h2>YouTube</h2>
      <div class="box">${ytStatus.connected ? `<span class="pill done">connected</span> <b>${esc(ytStatus.channel || "")}</b> <button class="sm danger" id="y-dis" style="margin-left:8px">Disconnect</button>` : `<span class="pill stopped">not connected</span> <button class="primary sm" id="y-con" style="margin-left:8px">Connect YouTube channel</button>`}</div>
      <h3 style="margin-top:18px">Google OAuth client</h3>
      <ol class="steps"><li>In Google Cloud Console, create a project and enable <b>YouTube Data API v3</b>.</li>
        <li>Set up the <b>OAuth consent screen</b> (External) and add yourself as a test user.</li>
        <li>Create an <b>OAuth client ID → Web application</b> and add this redirect URI (detected from where the app runs; add each copy's URI if you run several):</li></ol>
      <pre class="live">${esc(ytStatus.redirect_uri)}</pre>
      ${/^http:\/\/(?!localhost|127\.0\.0\.1)/.test(ytStatus.redirect_uri) ? '<div class="hint" style="color:#ef7c68">Google needs https for addresses other than localhost. Open the app through your https domain to connect.</div>' : ""}
      <div class="row">${field("y-id", "OAuth client ID", yt.client_id)}${field("y-secret", "OAuth client secret", yt.client_secret, { type: "password" })}</div>
      <div class="hint">While the Google app is in "Testing" mode the login expires after 7 days; publish the consent screen to avoid that.</div>
    </section>

    <section class="spane" data-pane="telegram">
      <h2>Telegram bot</h2><p class="hint">Control everything from your phone and get notified about approvals, finished films and uploads. In Telegram, message <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, send <code>/newbot</code>, and paste the token here.</p>
      <div class="row">${field("tg-token", "Bot token", tg.bot_token, { type: "password", ph: "123456:ABC…" })}${combo("tg-tz", "Your timezone (for /schedule and /calendar)", tg.timezone || browserTz, { ph: "Asia/Kolkata" })}</div>
      <div class="row"><div><label for="tg-notify">Notifications</label><select id="tg-notify"><option value="important" ${tg.notify !== "all" ? "selected" : ""}>Important: approvals, questions, errors, stages, finished, uploads</option><option value="all" ${tg.notify === "all" ? "selected" : ""}>Everything the agent says</option></select></div>
        <div><label>&nbsp;</label><label class="check"><input type="checkbox" id="tg-on" ${tg.enabled ? "checked" : ""}> Enable bot</label></div></div>
      <div class="box" id="tg-status" style="margin-top:14px">Loading status…</div>
    </section>

    <section class="spane" data-pane="research">
      <h2>Research</h2><p class="hint">The agent always uses Wikipedia and reads web pages. Add a Brave Search key for full web search (free tier available at brave.com/search/api).</p>
      <div class="row">${field("s-brave", "Brave Search API key (optional)", se.brave_key, { type: "password" })}<div></div></div>
    </section>

    <section class="spane" data-pane="system">
      <h2>System</h2>
      <div class="kv">
        <div>Database</div><div>${dbs.backend === "mongodb" && dbs.ok ? `<span class="pill done">MongoDB</span> database <code>${esc(dbs.db)}</code>` : dbs.error ? `<span class="pill error">problem</span> ${esc(dbs.error)}<div class="hint">Using local files until this is fixed. Check MONGODB_URI, the password, and Network Access in MongoDB Atlas.</div>` : `<span class="pill">local files</span> <span class="hint">Set MONGODB_URI to use MongoDB.</span>`}</div>
        <div>App address</div><div><code>${esc(sys.url || "")}</code></div>
        <div>Server process</div><div><code>#${esc(String(sys.pid || "?"))}</code> <span class="hint">started ${sys.started ? new Date(sys.started).toLocaleString() : "?"} · if this number changes when you reload, more than one copy of the app is running</span></div>
        <div>Data folder</div><div><code>${esc(sys.data_dir || "")}</code> <span class="hint">(film media lives here)</span></div>
        <div>Version</div><div>Documentary Studio ${esc(sys.version || "")} · Node.js ${esc(sys.node || "")} · ${sys.films || 0} films</div>
      </div>
      <h3 style="margin-top:20px">Server check</h3><p class="hint">Checks the graphics engine, ffmpeg, fonts and database, then renders a short test clip to measure how fast this server makes films.</p>
      <button class="sm" id="chk">Run server check</button><pre class="live" id="chk-out" style="display:none"></pre>
      <h3 style="margin-top:20px">Connection test</h3><p class="hint">Checks whether this server can reach AI Awaaz, the AI providers, Wikimedia, YouTube and Telegram, and if not, says why (hosting firewall, bot protection, DNS…) and whom to ask.</p>
      <button class="sm" id="netchk">Test connections</button><div id="netchk-out" style="display:none;margin-top:10px"></div>
      <h3 style="margin-top:20px">Activity logs</h3><p class="hint">Removes the activity feed of every film to free database space. Films, their files and the agent's memory are kept.</p>
      <button class="sm danger" id="clear-all-logs">🧹 Clear all activity logs</button>
    </section>
    </div></div>
    <div class="savebar" id="savebar"><span id="dirty-msg">All changes saved</span><button class="primary" id="save-all">Save settings</button></div>`;

  // ---- section switching (no page reload, keeps unsaved edits)
  const show = (k) => {
    $$(".spane").forEach((p) => (p.style.display = p.dataset.pane === k ? "" : "none"));
    $$(".snav a").forEach((a) => a.classList.toggle("on", a.dataset.sec === k));
    $("#savebar").style.display = ["overview", "system"].includes(k) ? "none" : "";
  };
  show(section);
  $$(".snav a, .crow").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    const k = a.getAttribute("href").split("/").pop();
    history.replaceState(null, "", `#/settings/${k}`);
    show(k);
  }));
  // ---- voice provider tiles
  const showVoice = () => {
    const v = ($('input[name="t-prov"]:checked') || {}).value || "none";
    $$(".tile").forEach((t) => t.classList.toggle("on", t.querySelector("input").value === v));
    $$(".vopt").forEach((o) => (o.style.display = o.dataset.v === v ? "" : "none"));
    $("#t-testrow").style.display = ["manual", "none"].includes(v) ? "none" : "";
  };
  $$('input[name="t-prov"]').forEach((r) => (r.onchange = showVoice));
  showVoice();
  // ---- dropdowns
  for (const k of Object.keys(LISTS)) if (/^(t-|p-|d-model)/.test(k)) delete LISTS[k]; // re-read lists for a fresh page
  LISTS["c-lang"] = LANGUAGES; LISTS["t-emodel"] = ELEVEN_MODELS; LISTS["t-omodel"] = OPENAI_TTS_MODELS; LISTS["tg-tz"] = timezones();
  const getJson = (u, fresh) => api(u + (fresh ? "?fresh=1" : ""));
  const models = (k) => async (fresh) => { if (fresh) await saveAll(); return (await getJson(`/api/llm/models/${k}`, fresh)).models; };
  const voices = (k) => async (fresh) => { if (fresh) await saveAll(); return (await getJson(`/api/tts/voices/${k}`, fresh)).voices; };
  const loaders = { "t-avoice": voices("aiawaaz"), "t-evoice": voices("elevenlabs"), "t-ovoice": voices("openai")};
  Object.keys(META.providers).forEach((k) => { loaders[`p-${k}-model`] = models(k); loaders[`p-${k}-backup`] = models(k); });
  wireCombos($("#body"), loaders);
  const keySaved = (k) => has((prov[k] || {}).api_key) || !!(META.providers[k] || {}).no_key;
  const loaded = new Set();
  const autoload = (id, ok) => { if (ok && !loaded.has(id)) { loaded.add(id); loadCombo(id, loaders); } };
  const autoVoice = () => {
    const v = ($('input[name="t-prov"]:checked') || {}).value;
    autoload("t-ovoice", v === "openai");
    autoload("t-evoice", v === "elevenlabs" && has(tts.elevenlabs_key));
    autoload("t-avoice", v === "aiawaaz" && has(tts.aiawaaz_key));
  };
  $$('input[name="t-prov"]').forEach((r) => r.addEventListener("change", autoVoice));
  autoVoice();
  // ---- priority list: numbering, up/down, live model names
  const prioRefresh = () => {
    let n = 0;
    $$(".prio-row").forEach((r) => {
      const on = r.querySelector("[data-prio]").checked;
      r.classList.toggle("off", !on);
      r.querySelector(".prio-n").textContent = on ? ++n : "off";
      const m = ($(`[data-p="${r.dataset.k}"][data-f="model"]`) || {}).value;
      r.querySelector(".prio-model").textContent = m ? "· " + m : "· no model set";
    });
  };
  $("#prio").addEventListener("click", (e) => {
    const b = e.target.closest("[data-up],[data-down]");
    if (!b) return;
    const row = b.closest(".prio-row");
    if (b.dataset.up && row.previousElementSibling) {
      row.parentNode.insertBefore(row, row.previousElementSibling);
      // moved above a provider that is in use -> you want this one used too
      const cb = row.querySelector("[data-prio]");
      const below = row.nextElementSibling && row.nextElementSibling.querySelector("[data-prio]");
      if (!cb.checked && below && below.checked) { cb.checked = true; toast(`${META.providers[row.dataset.k].label} turned on (ticked)`); }
    }
    if (b.dataset.down && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    setDirty(true); prioRefresh();
  });
  $("#prio").addEventListener("change", prioRefresh);
  const prioWarn = () => { const none = !$$("[data-prio]").some((c) => c.checked); $("#prio-none").style.display = none ? "" : "none"; };
  $("#prio").addEventListener("change", prioWarn); $("#prio").addEventListener("click", () => setTimeout(prioWarn));
  $$('[data-f="model"]').forEach((i) => i.addEventListener("input", prioRefresh));
  prioRefresh(); prioWarn();
  $$("details.prov").forEach((d) => {
    const k = d.querySelector("[data-test]").dataset.test;
    const go = () => d.open && autoload(`p-${k}-model`, keySaved(k));
    d.addEventListener("toggle", go); go();
  });
  // ---- unsaved changes
  let dirty = false;
  const setDirty = (d) => { dirty = d; $("#savebar").classList.toggle("dirty", d); $("#dirty-msg").textContent = d ? "You have unsaved changes" : "All changes saved"; };
  $("#body").addEventListener("input", (e) => { if (e.target.matches("input, textarea, select") && !e.target.closest(".no-dirty")) setDirty(true); });
  $("#body").addEventListener("change", (e) => { if (e.target.matches("input, select")) setDirty(true); });
  window.onbeforeunload = () => (dirty ? true : undefined);
  window.addEventListener("hashchange", () => { window.onbeforeunload = null; }, { once: true });

  const collect = () => {
    const providers = {};
    $$("[data-p]").forEach((i) => { (providers[i.dataset.p] = providers[i.dataset.p] || {})[i.dataset.f] = i.value.trim(); });
    const llm_prices = {};
    $$("[data-price]").forEach((i) => { (llm_prices[i.dataset.price] = llm_prices[i.dataset.price] || {})[i.dataset.f] = i.value.trim().replace(/^\$/, ""); });
    return { providers, llm_prices, llm_priority: $$("[data-prio]").filter((c) => c.checked).map((c) => c.dataset.prio), llm_order: $$("[data-prio]").map((c) => c.dataset.prio),
      channel: { name: $("#c-name").value, language: $("#c-lang").value, style: $("#c-style").value, footer: $("#c-footer").value },
      tts: { provider: ($('input[name="t-prov"]:checked') || {}).value || "none", openai_key: $("#t-okey").value, openai_voice: $("#t-ovoice").value, openai_model: $("#t-omodel").value, openai_instructions: $("#t-oinst").value,
        elevenlabs_key: $("#t-ekey").value, elevenlabs_voice: $("#t-evoice").value, elevenlabs_model: $("#t-emodel").value,
        aiawaaz_relay_url: $("#t-arelay").value.trim(), aiawaaz_relay_key: $("#t-arkey").value.trim(),
        aiawaaz_key: $("#t-akey").value.trim(), aiawaaz_voice: $("#t-avoice").value.trim(), aiawaaz_options: $("#t-aopts").value.trim(), aiawaaz_enhance: $("#t-aenh").checked },
      telegram: { bot_token: $("#tg-token").value.trim(), enabled: $("#tg-on").checked, timezone: $("#tg-tz").value.trim() || "UTC", notify: $("#tg-notify").value },
      search: { brave_key: $("#s-brave").value }, youtube: { client_id: $("#y-id").value.trim(), client_secret: $("#y-secret").value.trim() } };
  };
  const saveAll = async () => {
    const body = collect();
    const back = await api("/api/settings", { method: "PUT", body });
    if (body.llm_priority && JSON.stringify(back.llm_priority || []) !== JSON.stringify(body.llm_priority))
      throw new Error("The server did not keep the AI priority list - it is running an older version. Restart the app (run_app.bat, or Restart in cPanel) and save again.");
    setDirty(false);
  };
  const current = () => (location.hash.split("/")[2] || "overview").split("?")[0];
  $("#save-all").onclick = (e) => act(e.target, async () => { await saveAll(); toast("Settings saved"); viewSettings(current()); });
  // buttons that need the latest values save first, automatically
  $$("[data-test]").forEach((b) => (b.onclick = (e) => act(e.target, async () => {
    await saveAll(); const k = b.dataset.test;
    const model = $(`[data-p="${k}"][data-f="model"]`).value;
    const r = await api("/api/settings/test-llm", { method: "POST", body: { provider: k, model } });
    toast(`✓ ${META.providers[k].label} replied: ${r.reply}`);
  })));
  const awaaz = (what) => (e) => act(e.target, async () => { await saveAll(); const r = await api(`/api/tts/aiawaaz/${what}`); const o = $("#t-aout"); o.style.display = ""; o.textContent = r.text || "(empty)"; });
  $("#t-avoices").onclick = awaaz("voices");
  $("#t-aacct").onclick = awaaz("account");
  $("#t-test").onclick = (e) => act(e.target, async () => { await saveAll(); const blob = await api("/api/settings/test-tts", { method: "POST" }); const a = $("#t-audio"); a.src = URL.createObjectURL(blob); a.style.display = ""; a.play(); });
  if ($("#y-con")) $("#y-con").onclick = (e) => act(e.target, async () => { await saveAll(); const r = await api("/api/youtube/connect"); location.href = r.url; });
  if ($("#y-dis")) $("#y-dis").onclick = (e) => act(e.target, async () => { if (!confirm("Disconnect YouTube?")) return; await api("/api/youtube/disconnect", { method: "POST" }); viewSettings("youtube"); });
  drawTelegram(saveAll);
  $("#clear-all-logs") && ($("#clear-all-logs").onclick = (e) => act(e.target, async () => {
    if (!confirm("Clear the activity logs of ALL films? Films, files and agent memory are kept.")) return;
    const r = await api("/api/events/clear-all", { method: "POST" }); toast(`Cleared the logs of ${r.films} film${r.films === 1 ? "" : "s"}`);
  }));
  $("#t-argen") && ($("#t-argen").onclick = async (e) => {
    e.preventDefault();
    const k = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const f = $("#t-arkey"); f.value = k; f.type = "text"; f.dispatchEvent(new Event("input", { bubbles: true }));
    try { await navigator.clipboard.writeText(k); } catch (_) { /* fine */ }
    toast("New relay key copied. Put it in the worker's RELAY_KEY secret, then Save settings here.");
  });
  $("#t-arscript") && ($("#t-arscript").onclick = (e) => act(e.target, async () => {
    const t = await (await fetch("/static/aiawaaz-relay-worker.js")).text();
    try { await navigator.clipboard.writeText(t); toast("Relay script copied. Paste it into the Cloudflare Worker editor."); }
    catch (_) { const o = $("#t-aout"); o.style.display = ""; o.textContent = t; toast("Copy the script from the box below."); }
  }));
  $("#netchk").onclick = (e) => act(e.target, async () => {
    const o = $("#netchk-out"); o.style.display = ""; o.innerHTML = `<p class="hint">Testing… (up to 30 s)</p>`;
    const r = await api("/api/net/check");
    const bad = r.results.filter((x) => !x.ok);
    o.innerHTML = `<p class="hint">This server's public IP address: <code>${esc(r.server_ip || "unknown")}</code> · Node.js ${esc(r.node)}${bad.length ? " · give this IP to support if a service blocks it" : ""}</p>
      <table class="nettbl">${r.results.map((x) => `<tr><td>${x.ok ? "✅" : "❌"}</td><td><b>${esc(x.name)}</b><div class="hint"><code>${esc(x.host)}</code></div></td>
      <td>${x.ok ? `<span class="hint">${esc((x.steps || []).slice(-1)[0] || "ok")}</span>` : `${esc(x.why || "failed")}<div class="hint"><b>Fix:</b> ${esc(x.fix || "")}</div>`}</td></tr>`).join("")}</table>`;
  });
  $("#chk").onclick = (e) => act(e.target, async () => { const r = await api("/api/setup-check"); const o = $("#chk-out"); o.style.display = ""; o.textContent = (r.ok ? "✓ All good\n\n" : "✗ Problems found\n\n") + r.output; });
}

async function drawTelegram(saveAll, again) {
  const box = $("#tg-status");
  if (!box) return;
  const t = await api("/api/telegram").catch(() => null);
  if (!t) return;
  box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${t.running ? `<span class="pill done">running</span> <b>@${esc(t.username)}</b> <span class="hint">(${t.mode === "webhook" ? "webhook: works even when the app sleeps" : "polling"})</span>` : `<span class="pill stopped">not running</span>`}
      ${t.error ? `<span style="color:#ef7c68">${esc(t.error)}</span>` : ""}</div>
    ${t.running ? `<label>Pair your Telegram account</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><a class="btn primary" href="${esc(t.link)}" target="_blank">Open pairing link</a>
      <span>or send <code>/start ${esc(t.pair_code)}</code> to @${esc(t.username)}</span><button class="sm ghost" id="tg-code">New code</button></div>
      <div class="hint">The code works once. Only paired accounts can use the bot.</div>` : ""}
    <label>Paired accounts</label>
    ${(t.allowed || []).length ? t.allowed.map((a) => `<div style="display:flex;gap:10px;align-items:center;margin:4px 0">👤 <b>${esc(a.name)}</b> <code>${a.id}</code> <button class="sm danger" data-rm="${a.id}">Remove</button></div>`).join("") : '<div class="hint">None yet.</div>'}
    ${t.running && (t.allowed || []).length ? '<button class="sm" id="tg-test" style="margin-top:8px">Send test message</button>' : ""}`;
  if ($("#tg-code")) $("#tg-code").onclick = (e) => act(e.target, async () => { await api("/api/telegram/pair-code", { method: "POST" }); drawTelegram(saveAll, true); });
  if ($("#tg-test")) $("#tg-test").onclick = (e) => act(e.target, async () => { await api("/api/telegram/test", { method: "POST" }); toast("Sent. Check Telegram."); });
  $$("[data-rm]", box).forEach((b) => (b.onclick = (e) => act(e.target, async () => { if (!confirm("Remove this Telegram account?")) return; await api("/api/telegram/remove", { method: "POST", body: { id: +b.dataset.rm } }); drawTelegram(saveAll, true); })));
  // The bot needs a few seconds to start after saving, and pairing happens on the phone: keep refreshing.
  clearTimeout(window._tgT);
  if (location.hash.startsWith("#/settings")) window._tgT = setTimeout(() => drawTelegram(saveAll), t.running && (t.allowed || []).length ? 30000 : 4000);
}

route();
