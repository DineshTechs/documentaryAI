/* Documentary Studio - single-page frontend (no build step). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STAGES = ["story", "voice", "images", "scene", "review", "render", "done"];
const LOOKS = { auto: "Auto (pick per subject)", documentary: "Cork evidence wall: documentary / history / true crime", studio: "Studio: product / brand", blueprint: "Blueprint: science / engineering", night: "Night: tech / space / trailers" };
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
    <div class="brand"><div class="reel"></div><div><b>Documentary<br>Studio</b><small>cinematic-skill</small></div></div>
    <nav class="nav">${nav.map(([k, h, ic, t]) => `<a href="${h}" class="${k === active ? "on" : ""}"><span>${ic}</span>${t}</a>`).join("")}</nav>
    <div class="foot">${META && !META.skill_installed ? '<span style="color:#ef7c68">⚠ cinematic-skill not installed</span><br>' : ""}<a href="#" id="logout">Log out</a></div>
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
    if (!META) META = await api("/api/meta");
  } catch (e) { return; }
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path] = hash.split("?");
  let m;
  if ((m = path.match(/^\/films\/(\d+)/))) return viewProject(+m[1]);
  if (path === "/ideas") return viewIdeas();
  if (path === "/settings") return viewSettings();
  return viewFilms();
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------ films dashboard
function miniSteps(stage) {
  const ci = STAGES.indexOf(stage);
  return `<div class="mini-steps">${STAGES.slice(0, 6).map((s, i) => `<i class="${i < ci || stage === "done" ? "done" : i === ci ? "cur" : ""}" title="${s}"></i>`).join("")}</div>`;
}

async function viewFilms() {
  const main = shell("films", `<div class="top"><div class="grow"><h1>Films</h1><div class="sub">Each film runs the cinematic-skill pipeline: story → voice → images → scene → review → render.</div></div>
    <button class="primary" id="new">＋ New film</button></div><div id="body"><div class="spin"></div></div>`);
  $("#new").onclick = () => newFilmModal();
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
      <div class="hint" style="display:flex;justify-content:space-between"><span>Stage: <b style="color:var(--text)">${p.stage}</b> · ${p.duration_s}s · ${esc(p.look)}</span><span>${ago(p.updated)}</span></div>
      ${p.youtube && p.youtube.youtube_id ? `<div class="hint" style="color:var(--green);margin-top:6px">▶ youtu.be/${esc(p.youtube.youtube_id)}</div>` : ""}
    </div>`).join("")}</div>`;
  $$(".film", body).forEach((c) => (c.onclick = () => (location.hash = `#/films/${c.dataset.id}`)));
}

function providerOptions(sel, allowDefault = true) {
  return (allowDefault ? `<option value="">Default (from Settings)</option>` : "") +
    Object.entries(META.providers).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)}</option>`).join("");
}

function newFilmModal(prefill = {}) {
  modal(`<h2>New film</h2>
    <label>Title</label><input id="f-title" value="${esc(prefill.title || "")}" placeholder="The Wright Brothers: 12 Seconds">
    <label>Topic & angle</label><textarea id="f-topic" placeholder="What is the story? What should the viewer feel or learn?">${esc(prefill.notes || "")}</textarea>
    <label>Extra brief (optional)</label><textarea id="f-brief" style="min-height:60px" placeholder="Must-include facts, sources to use, tone, things to avoid…"></textarea>
    <div class="row"><div><label>Length</label><select id="f-dur">${[[60, "60 s"], [90, "90 s"], [120, "2 min"], [180, "3 min"], [300, "5 min"], [480, "8 min"], [600, "10 min"]].map(([v, t]) => `<option value="${v}" ${v === 90 ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label>Format</label><select id="f-aspect"><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Shorts</option><option value="1:1">1:1 · Square</option></select></div></div>
    <label>Look</label><select id="f-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <div class="row"><div><label>AI provider</label><select id="f-prov">${providerOptions("")}</select></div><div><label>Model override</label><input id="f-model" placeholder="(provider default)"></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="f-auto" checked style="width:auto"> Start the agent right away</label>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="f-go">Create film</button></div>`, (m, close) => {
    $("#f-go", m).onclick = (e) => act(e.target, async () => {
      const p = await api("/api/projects", { method: "POST", body: {
        title: $("#f-title", m).value, topic: $("#f-topic", m).value || $("#f-title", m).value, brief: $("#f-brief", m).value,
        duration_s: +$("#f-dur", m).value, aspect: $("#f-aspect", m).value, look: $("#f-look", m).value,
        provider: $("#f-prov", m).value, model: $("#f-model", m).value, autostart: $("#f-auto", m).checked, idea_id: prefill.id || null } });
      close(); location.hash = `#/films/${p.id}`;
    });
  });
}

// ------------------------------------------------------------ project view
const PV = { pid: null, after: 0, files: [], tab: "files", selected: null, project: null, lastFileRefresh: 0 };

async function viewProject(pid) {
  Object.assign(PV, { pid, after: 0, selected: null, tab: PV.pid === pid ? PV.tab : "files" });
  const main = shell("films", `<div class="spin"></div>`);
  let p;
  try { p = await api(`/api/projects/${pid}`); } catch (e) { main.innerHTML = `<div class="empty">Film not found. <a href="#/">Back</a></div>`; return; }
  PV.project = p;
  main.innerHTML = `
    <div class="top"><a href="#/" class="btn ghost">←</a><div class="grow"><h1 id="p-title" style="margin:0">${esc(p.title)}</h1><div class="sub" id="p-sub"></div></div>
      <span id="p-pill"></span><span id="p-actions"></span>
      <button class="ghost" id="p-more" title="More">⋯</button></div>
    <div class="stepper" id="stepper"></div>
    <div class="proj">
      <section class="card"><div id="approval"></div>
        <h3 style="display:flex;justify-content:space-between">Agent <span class="hint" id="p-model"></span></h3>
        <div class="feed" id="feed"></div><div id="live"></div>
        <div class="composer"><textarea id="msg" placeholder="Message the agent… (Ctrl+Enter to send)"></textarea><button class="primary" id="send">Send</button></div>
      </section>
      <section class="card"><div class="tabs" id="tabs">
        ${[["files", "Files"], ["preview", "Preview"], ["publish", "Publish to YouTube"], ["details", "Details"]].map(([k, t]) => `<button data-t="${k}">${t}</button>`).join("")}
        </div><div id="tab"></div></section>
    </div>`;
  $("#send").onclick = sendMsg;
  $("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMsg(); });
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
  $("#p-sub").textContent = `${p.topic || ""}`.slice(0, 160);
  $("#p-model").textContent = `${p.provider || "default provider"}${p.model ? " · " + p.model : ""}`;
  const acts = $("#p-actions");
  if (p.running) acts.innerHTML = `<button class="danger" id="b-stop">■ Stop</button>`;
  else if (p.status === "awaiting_approval") acts.innerHTML = "";
  else acts.innerHTML = `<button class="primary" id="b-start">${p.status === "new" ? "▶ Start agent" : p.status === "done" ? "▶ Continue" : "▶ Resume"}</button>`;
  const b1 = $("#b-start"), b2 = $("#b-stop");
  if (b1) b1.onclick = (e) => act(e.target, async () => { renderHeader(await api(`/api/projects/${p.id}/start`, { method: "POST" })); });
  if (b2) b2.onclick = (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/stop`, { method: "POST" }); toast("Stopping…"); });
  const ci = STAGES.indexOf(p.stage);
  $("#stepper").innerHTML = STAGES.map((s, i) => `<div class="st ${i < ci || p.stage === "done" ? "done" : i === ci ? "cur" : ""}"><i></i>${s}</div>`).join("");
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

function eventHtml(ev) {
  const t = esc(ev.text || "");
  switch (ev.kind) {
    case "assistant": return `<div class="ev assistant md">${md(ev.text)}</div>`;
    case "user": return `<div class="ev user">${t}</div>`;
    case "tool": return `<div class="ev tool" data-tool="${ev.id}"><b>${esc(ev.meta?.name || "tool")}</b> ${t.length > 220 ? t.slice(0, 220) + "…" : t}<pre class="out">…</pre></div>`;
    case "tool_result": return null;
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
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    let lastTool = $$(".ev.tool", feed).pop();
    for (const ev of d.events) {
      PV.after = ev.id;
      if (ev.kind === "tool_result") {
        if (lastTool) $(".out", lastTool).textContent = ev.text;
        continue;
      }
      const h = eventHtml(ev);
      if (!h) continue;
      feed.insertAdjacentHTML("beforeend", h);
      if (ev.kind === "tool") lastTool = feed.lastElementChild;
    }
    $$(".ev.tool", feed).forEach((el) => (el.onclick = () => el.classList.toggle("open")));
    $$(".ev.image img", feed).forEach((el) => (el.onclick = () => openFile(el.dataset.open)));
    if (d.events.length && atBottom) feed.scrollTop = feed.scrollHeight;
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
      <button id="m-reset">↺ Clear agent memory (keep files)</button>
      <button class="danger" id="m-del">🗑 Delete film (keep files on server)</button>
      <button class="danger" id="m-delall">🗑 Delete film and all its files</button></div>
    <div class="actions"><button data-close>Close</button></div>`, (m, close) => {
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
  el.innerHTML = main ? `<div class="viewer" style="margin:0"><video controls id="pv" src="${rawUrl(p.id, main)}"></video>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><code>${esc(main)}</code>
      <span><a class="btn sm" href="${rawUrl(p.id, main, true)}">⬇ MP4</a> ${p.final_srt ? `<a class="btn sm" href="${rawUrl(p.id, p.final_srt, true)}">⬇ SRT</a>` : ""}</span></div></div>`
    : `<div class="empty" style="padding:30px">No video rendered yet. Drafts and the final film show up here.</div>`;
  if (vids.length > 1) el.innerHTML += `<h3 style="margin-top:18px">All renders</h3><div class="chips">${vids.map((v) => `<span class="chip" data-v="${esc(v.path)}">${esc(v.path)} · ${ago(v.mtime)}</span>`).join("")}</div>`;
  if (stills.length) el.innerHTML += `<h3 style="margin-top:18px">Review stills</h3><div class="thumbs">${stills.map((s) => fileThumb(p.id, s.path)).join("")}</div>`;
  $$("[data-v]", el).forEach((c) => (c.onclick = () => { $("#pv").src = rawUrl(p.id, c.dataset.v); }));
  $$("[data-open]", el).forEach((b) => (b.onclick = () => openFile(b.dataset.open)));
}

async function tabPublish(el) {
  const p = PV.project;
  el.innerHTML = `<div class="spin"></div>`;
  const [m, settings] = await Promise.all([api(`/api/projects/${p.id}/metadata`), api("/api/settings")]);
  const yt = settings.youtube_status;
  const localDT = (iso) => { if (!iso) return ""; const d = new Date(iso); const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div class="hint">${yt.connected ? `Connected to <b style="color:var(--text)">${esc(yt.channel || "your channel")}</b>` : `YouTube not connected. <a href="#/settings">Connect it in Settings</a>`}</div>
      <button class="primary" id="gen">✨ Generate with AI</button></div>
    ${(m.title_options || []).length ? `<label>Title ideas (click to use)</label><div class="chips">${m.title_options.map((t) => `<span class="chip" data-title="${esc(t)}">${esc(t)}</span>`).join("")}</div>` : ""}
    <label>Title <span class="hint" id="tlen"></span></label><input id="m-title" maxlength="100" value="${esc(m.title || "")}">
    <label>Description</label><textarea id="m-desc" style="min-height:220px">${esc(m.description || "")}</textarea>
    <label>Tags (comma separated)</label><input id="m-tags" value="${esc((m.tags || []).join(", "))}">
    ${(m.chapters || []).length ? `<label>Chapters</label><pre class="live" style="max-height:none">${esc(m.chapters.map((c) => `${c.time} ${c.label}`).join("\n"))}</pre>` : ""}
    <div class="row"><div><label>Category</label><select id="m-cat">${Object.entries(META.categories).map(([k, v]) => `<option value="${k}" ${k === (m.category_id || "27") ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div><label>Visibility</label><select id="m-priv">${["private", "unlisted", "public"].map((v) => `<option ${v === m.privacy ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div><label>Language</label><input id="m-lang" value="${esc(m.language || "en")}"></div></div>
    <label>Schedule publish (optional, your local time)</label><input type="datetime-local" id="m-at" value="${localDT(m.publish_at)}">
    <div class="hint">When scheduled, the video uploads as private and YouTube makes it public at that time.</div>
    <hr><h3>Thumbnail</h3>
    ${(m.thumbnail_ideas || []).length ? `<div class="md" style="color:var(--muted)"><ul>${m.thumbnail_ideas.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
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
  const collect = () => ({ title: $("#m-title").value, description: $("#m-desc").value,
    tags: $("#m-tags").value.split(",").map((s) => s.trim()).filter(Boolean), category_id: $("#m-cat").value,
    privacy: $("#m-priv").value, language: $("#m-lang").value, publish_at: $("#m-at").value ? new Date($("#m-at").value).toISOString().replace(/\.\d+Z$/, "Z") : "" });
  const save = () => api(`/api/projects/${p.id}/metadata`, { method: "PUT", body: collect() });
  $("#m-save").onclick = (e) => act(e.target, async () => { await save(); toast("Saved"); });
  $("#gen").onclick = (e) => act(e.target, async () => { await api(`/api/projects/${p.id}/metadata/generate`, { method: "POST" }); toast("Metadata generated"); tabPublish(el); });
  $("#t-grab").onclick = (e) => act(e.target, async () => { await save(); await api(`/api/projects/${p.id}/thumbnail`, { method: "POST", body: { seconds: +$("#t-sec").value } }); tabPublish(el); });
  $("#t-up").onclick = () => $("#t-file").click();
  $("#t-file").onchange = () => act(null, async () => { await save(); const fd = new FormData(); fd.append("file", $("#t-file").files[0]); await api(`/api/projects/${p.id}/thumbnail`, { method: "POST", body: fd }); tabPublish(el); });
  $("#m-upload").onclick = (e) => act(e.target, async () => {
    const d = collect();
    if (!d.title) throw new Error("Add a title first");
    if (!confirm(`Upload "${d.title}" to ${yt.channel || "YouTube"} as ${d.publish_at ? "scheduled for " + new Date(d.publish_at).toLocaleString() : d.privacy}?`)) return;
    await save(); await api(`/api/projects/${p.id}/youtube-upload`, { method: "POST" }); watchUpload(p.id);
  });
  if (m.upload_status && m.upload_status !== "done") watchUpload(p.id); else showUpload(m);
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
      <div><label>Format</label><select id="d-aspect">${["16:9", "9:16", "1:1"].map((a) => `<option ${a === p.aspect ? "selected" : ""}>${a}</option>`).join("")}</select></div></div>
    <label>Look</label><select id="d-look">${Object.entries(LOOKS).map(([k, v]) => `<option value="${k}" ${k === p.look ? "selected" : ""}>${v}</option>`).join("")}</select>
    <div class="row"><div><label>AI provider</label><select id="d-prov">${providerOptions(p.provider || "")}</select></div><div><label>Model</label><input id="d-model" value="${esc(p.model || "")}" placeholder="(provider default)"></div></div>
    <div class="hint">You can switch the AI model mid-film, e.g. a cheaper model for rendering steps. Changes to the brief apply the next time the agent starts.</div>
    <div class="row"><div><label>Final video path</label><input id="d-fv" value="${esc(p.final_video || "")}" placeholder="film/out/final.mp4"></div><div><label>Captions (SRT) path</label><input id="d-fs" value="${esc(p.final_srt || "")}"></div></div>
    <button class="primary" id="d-save" style="margin-top:16px">Save details</button>`;
  $("#d-save").onclick = (e) => act(e.target, async () => {
    const r = await api(`/api/projects/${p.id}`, { method: "PATCH", body: { title: $("#d-title").value, topic: $("#d-topic").value, brief: $("#d-brief").value,
      duration_s: +$("#d-dur").value, aspect: $("#d-aspect").value, look: $("#d-look").value, provider: $("#d-prov").value || null, model: $("#d-model").value || null,
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

// ------------------------------------------------------------ settings
async function viewSettings() {
  const main = shell("settings", `<div class="top"><div class="grow"><h1>Settings</h1><div class="sub">API keys are stored on your server and never shown again in full.</div></div><button class="primary" id="save-all">Save settings</button></div><div id="body"><div class="spin"></div></div>`);
  const s = await api("/api/settings");
  const prov = s.providers || {}, def = s.default_llm || {}, tts = s.tts || {}, ch = s.channel || {}, yt = s.youtube || {}, se = s.search || {}, tg = s.telegram || {};
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const ytStatus = s.youtube_status;
  if (location.hash.includes("yt=connected")) toast("YouTube channel connected");
  $("#body").innerHTML = `
  <div class="card"><h2>Channel</h2>
    <div class="row"><div><label>Channel name</label><input id="c-name" value="${esc(ch.name || "")}"></div><div><label>Language</label><input id="c-lang" value="${esc(ch.language || "English")}"></div></div>
    <label>Style, audience & voice (the agent and metadata writer follow this)</label><textarea id="c-style" placeholder="e.g. Calm, authoritative narration. History mysteries for adults 25-45. No sensationalism; always cite sources.">${esc(ch.style || "")}</textarea>
    <label>Description footer (added to every video description)</label><textarea id="c-footer" placeholder="Subscribe for more… · Music: … · Business: …">${esc(ch.footer || "")}</textarea></div>

  <div class="card"><h2>AI models</h2><p class="hint">Add keys for any providers you want. The agent needs a model that supports tool or function calling. Strong models (Claude Sonnet/Opus, top GPT or Gemini models) give much better films.</p>
    <div class="row"><div><label>Default provider</label><select id="d-prov">${providerOptions(def.provider, false)}</select></div><div><label>Default model</label><input id="d-model" value="${esc(def.model || "")}" placeholder="claude-sonnet-5-5"></div></div>
    <div style="margin-top:14px">${Object.entries(META.providers).map(([k, v]) => { const c = prov[k] || {}; return `<details class="prov" ${c.api_key || k === def.provider ? "open" : ""}><summary>${esc(v.label)} ${c.api_key ? '<span class="ok">● key saved</span>' : ""}</summary>
      <div class="row"><div><label>API key</label><input data-p="${k}" data-f="api_key" type="password" value="${esc(c.api_key || "")}" placeholder="${k === "custom" ? "(optional)" : "paste key"}" autocomplete="off"></div>
        <div><label>Model</label><input data-p="${k}" data-f="model" value="${esc(c.model || "")}" placeholder="${esc(v.model_hint)}"></div></div>
      <label>Base URL</label><input data-p="${k}" data-f="base_url" value="${esc(c.base_url || "")}" placeholder="${esc(v.base_url)}">
      <button class="sm" data-test="${k}" style="margin-top:10px">Test connection</button></details>`; }).join("")}</div></div>

  <div class="card"><h2>Narration voice</h2>
    <div class="row"><div><label>Final voice provider</label><select id="t-prov">${Object.entries(META.tts_providers).map(([k, v]) => `<option value="${k}" ${k === (tts.provider || "espeak") ? "selected" : ""}>${v}</option>`).join("")}</select></div><div></div></div>
    <div class="row"><div><label>OpenAI TTS key (blank = use OpenAI key above)</label><input id="t-okey" type="password" value="${esc(tts.openai_key || "")}"></div><div><label>OpenAI voice</label><input id="t-ovoice" value="${esc(tts.openai_voice || "onyx")}" placeholder="onyx, ash, sage, ballad…"></div><div><label>OpenAI TTS model</label><input id="t-omodel" value="${esc(tts.openai_model || "gpt-4o-mini-tts")}"></div></div>
    <label>OpenAI voice direction (optional)</label><input id="t-oinst" value="${esc(tts.openai_instructions || "")}" placeholder="Deep, measured documentary narrator. Slow, with suspense.">
    <div class="row"><div><label>ElevenLabs key</label><input id="t-ekey" type="password" value="${esc(tts.elevenlabs_key || "")}"></div><div><label>ElevenLabs voice ID</label><input id="t-evoice" value="${esc(tts.elevenlabs_voice || "")}"></div><div><label>ElevenLabs model</label><input id="t-emodel" value="${esc(tts.elevenlabs_model || "eleven_multilingual_v2")}"></div></div>
    <p class="hint">You can always upload your own voice recording on a film's Files tab instead.</p>
    <button class="sm" id="t-test">▶ Test voice (save first)</button> <audio id="t-audio" controls style="display:none;vertical-align:middle;height:32px"></audio></div>

  <div class="card"><h2>Research</h2><label>Brave Search API key (optional; without it the agent searches Wikipedia only)</label><input id="s-brave" type="password" value="${esc(se.brave_key || "")}"></div>

  <div class="card"><h2>YouTube</h2>
    <p class="hint">1. In Google Cloud Console, create a project and enable the <b>YouTube Data API v3</b>. 2. Set up the OAuth consent screen and add yourself as a test user. 3. Create an OAuth client ID of type <b>Web application</b> with this redirect URI:</p>
    <pre class="live">${esc(ytStatus.redirect_uri)}</pre>
    <div class="row"><div><label>OAuth client ID</label><input id="y-id" value="${esc(yt.client_id || "")}"></div><div><label>OAuth client secret</label><input id="y-secret" type="password" value="${esc(yt.client_secret || "")}"></div></div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">${ytStatus.connected ? `<span class="pill done">connected</span> <b>${esc(ytStatus.channel || "")}</b> <button class="sm danger" id="y-dis">Disconnect</button>` : `<button class="primary sm" id="y-con">Connect YouTube channel (save first)</button>`}</div></div>

  <div class="card"><h2>Telegram bot</h2>
    <p class="hint">Control everything from Telegram and get notified about approvals, finished films and uploads. 1. In Telegram, message <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, send <code>/newbot</code> and copy the token. 2. Paste it here, tick Enable, and save. 3. Open the pairing link below on your phone.</p>
    <div class="row"><div><label>Bot token</label><input id="tg-token" type="password" value="${esc(tg.bot_token || "")}" placeholder="123456:ABC…" autocomplete="off"></div>
      <div><label>Your timezone (for /schedule and /calendar)</label><input id="tg-tz" value="${esc(tg.timezone || browserTz)}" placeholder="Asia/Kolkata"></div></div>
    <div class="row"><div><label>Notifications</label><select id="tg-notify"><option value="important" ${tg.notify !== "all" ? "selected" : ""}>Important: approvals, questions, errors, stages, finished, uploads</option><option value="all" ${tg.notify === "all" ? "selected" : ""}>Everything the agent says</option></select></div>
      <div><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;margin:8px 0 0"><input type="checkbox" id="tg-on" style="width:auto" ${tg.enabled ? "checked" : ""}> Enable bot</label></div></div>
    <div id="tg-status" style="margin-top:12px" class="hint">Loading status…</div></div>

  <div class="card"><h2>Render server</h2><p class="hint">Runs cinematic-skill's <code>check_setup.py</code> (Python packages, ffmpeg, fonts).</p><button class="sm" id="chk">Run setup check</button><pre class="live" id="chk-out" style="display:none"></pre></div>`;

  const collect = () => {
    const providers = {};
    $$("[data-p]").forEach((i) => { (providers[i.dataset.p] = providers[i.dataset.p] || {})[i.dataset.f] = i.value.trim(); });
    return { providers, default_llm: { provider: $("#d-prov").value, model: $("#d-model").value.trim() },
      channel: { name: $("#c-name").value, language: $("#c-lang").value, style: $("#c-style").value, footer: $("#c-footer").value },
      tts: { provider: $("#t-prov").value, openai_key: $("#t-okey").value, openai_voice: $("#t-ovoice").value, openai_model: $("#t-omodel").value, openai_instructions: $("#t-oinst").value,
        elevenlabs_key: $("#t-ekey").value, elevenlabs_voice: $("#t-evoice").value, elevenlabs_model: $("#t-emodel").value },
      telegram: { bot_token: $("#tg-token").value.trim(), enabled: $("#tg-on").checked, timezone: $("#tg-tz").value.trim() || "UTC", notify: $("#tg-notify").value },
      search: { brave_key: $("#s-brave").value }, youtube: { client_id: $("#y-id").value.trim(), client_secret: $("#y-secret").value.trim() } };
  };
  const saveAll = () => api("/api/settings", { method: "PUT", body: collect() });
  $("#save-all").onclick = (e) => act(e.target, async () => { await saveAll(); toast("Settings saved"); viewSettings(); });
  $$("[data-test]").forEach((b) => (b.onclick = (e) => act(e.target, async () => {
    await saveAll(); const k = b.dataset.test;
    const model = $(`[data-p="${k}"][data-f="model"]`).value || (k === $("#d-prov").value ? $("#d-model").value : "");
    const r = await api("/api/settings/test-llm", { method: "POST", body: { provider: k, model } });
    toast(`✓ ${META.providers[k].label} replied: ${r.reply}`);
  })));
  $("#t-test").onclick = (e) => act(e.target, async () => { await saveAll(); const blob = await api("/api/settings/test-tts", { method: "POST" }); const a = $("#t-audio"); a.src = URL.createObjectURL(blob); a.style.display = ""; a.play(); });
  if ($("#y-con")) $("#y-con").onclick = (e) => act(e.target, async () => { await saveAll(); const r = await api("/api/youtube/connect"); location.href = r.url; });
  if ($("#y-dis")) $("#y-dis").onclick = (e) => act(e.target, async () => { if (!confirm("Disconnect YouTube?")) return; await api("/api/youtube/disconnect", { method: "POST" }); viewSettings(); });
  drawTelegram(saveAll);
  $("#chk").onclick = (e) => act(e.target, async () => { const r = await api("/api/setup-check"); const o = $("#chk-out"); o.style.display = ""; o.textContent = (r.ok ? "✓ OK\n\n" : "✗ Problems found\n\n") + r.output; });
}

async function drawTelegram(saveAll, again) {
  const box = $("#tg-status");
  if (!box) return;
  const t = await api("/api/telegram").catch(() => null);
  if (!t) return;
  box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${t.running ? `<span class="pill done">running</span> <b>@${esc(t.username)}</b>` : `<span class="pill stopped">not running</span>`}
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
