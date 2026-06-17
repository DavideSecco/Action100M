"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  currentFile: "",
  currentUid: "",
  nodes: [],
  duration: 0,
  transcript: [],
  localMode: false,
  ytPlayer: null,
  ytReady: false,
  ytPollId: null,
  rafId: null,
  lastActiveIds: "",
  openLevels: new Set(),
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileSelect        = document.getElementById("file-select");
const videoSelect       = document.getElementById("video-select");
const ytLink            = document.getElementById("yt-link");
const localPlayer       = document.getElementById("local-player");
const ytPlayerDiv       = document.getElementById("yt-player");
const playerPlaceholder = document.getElementById("player-placeholder");
const ccOverlay         = document.getElementById("cc-overlay");
const ccBtn             = document.getElementById("cc-btn");
const infoBtn           = document.getElementById("info-btn");
const infoPopover       = document.getElementById("info-popover");
const timelineWrap      = document.getElementById("timeline-wrap");
const timelineContainer = document.getElementById("timeline-container");
const playhead          = document.getElementById("playhead");
const nodesPanel        = document.getElementById("nodes-panel");

let ccEnabled = false;

// ── YouTube IFrame API ────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => { state.ytReady = true; };

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadParquetFiles();
  fileSelect.addEventListener("change", onFileChange);
  videoSelect.addEventListener("change", onVideoChange);
  timelineWrap.addEventListener("click", onTimelineClick);
  initResizeHandles();
  initCCButton();
  initInfoPopover();
}

async function loadParquetFiles() {
  const files = await apiFetch("/api/parquet-files");
  fileSelect.innerHTML = '<option value="">— select parquet —</option>';
  files.forEach(f => {
    const opt = document.createElement("option");
    opt.value = opt.textContent = f;
    fileSelect.appendChild(opt);
  });
}

// ── Selectors ─────────────────────────────────────────────────────────────────
async function onFileChange() {
  const file = fileSelect.value;
  state.currentFile = file;
  state.currentUid = "";
  videoSelect.innerHTML = '<option value="">— loading… —</option>';
  videoSelect.disabled = true;
  clearPlayer();

  if (!file) {
    videoSelect.innerHTML = '<option value="">— select video —</option>';
    videoSelect.disabled = false;
    return;
  }

  try {
    const videos = await apiFetch(`/api/videos?file=${enc(file)}`);
    videoSelect.innerHTML = '<option value="">— select video —</option>';
    videos.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.uid;
      const dur = v.duration ? ` (${fmtDuration(v.duration)})` : "";
      opt.textContent = `${v.title || v.uid}${dur}`;
      videoSelect.appendChild(opt);
    });
  } catch (e) {
    videoSelect.innerHTML = `<option value="">— error: ${e.message} —</option>`;
    console.error("onFileChange:", e);
  }
  videoSelect.disabled = false;
}

async function onVideoChange() {
  const uid = videoSelect.value;
  if (!uid) { clearPlayer(); return; }
  state.currentUid = uid;
  try {
    await loadVideo(uid);
  } catch (e) {
    playerPlaceholder.querySelector("span").textContent = `Error: ${e.message}`;
    playerPlaceholder.hidden = false;
    console.error("loadVideo:", e);
  }
}

// ── Load video ────────────────────────────────────────────────────────────────
async function loadVideo(uid) {
  stopPlayback();

  const [record, hasVideo] = await Promise.all([
    apiFetch(`/api/video?file=${enc(state.currentFile)}&uid=${enc(uid)}`),
    apiFetch(`/api/has-video?uid=${enc(uid)}&file=${enc(state.currentFile)}`),
  ]);

  const meta = record.metadata || {};
  state.nodes      = record.nodes || [];
  state.duration   = meta.duration || estimateDuration(state.nodes);
  state.localMode  = hasVideo.exists;
  state.transcript = Array.isArray(meta.transcript) ? meta.transcript : [];
  state.lastActiveIds = "";
  state.openLevels = new Set();

  renderMeta(uid, meta);
  renderTimeline(state.nodes, state.duration);
  renderNodesPanel([]);

  if (hasVideo.exists) {
    setupLocalPlayer(hasVideo.path);
  } else {
    setupYouTubePlayer(uid);
  }

  ytLink.href = `https://www.youtube.com/watch?v=${uid}`;
  ytLink.hidden = false;
}

// ── Local player ──────────────────────────────────────────────────────────────
function setupLocalPlayer(path) {
  playerPlaceholder.hidden = true;
  ytPlayerDiv.hidden = true;
  localPlayer.hidden = false;
  localPlayer.src = `/${path}`;
  localPlayer.load();

  function frame() {
    if (!localPlayer.paused && !localPlayer.ended) {
      updatePlayhead(localPlayer.currentTime);
    }
    state.rafId = requestAnimationFrame(frame);
  }
  state.rafId = requestAnimationFrame(frame);

  localPlayer.addEventListener("seeked", () => updatePlayhead(localPlayer.currentTime), { passive: true });
  localPlayer.addEventListener("pause",  () => updatePlayhead(localPlayer.currentTime), { passive: true });
}

// ── YouTube player ────────────────────────────────────────────────────────────
function setupYouTubePlayer(uid) {
  playerPlaceholder.hidden = true;
  localPlayer.hidden = true;
  ytPlayerDiv.hidden = false;
  ytPlayerDiv.innerHTML = "";

  const tryCreate = () => {
    if (!state.ytReady || !window.YT || !window.YT.Player) {
      setTimeout(tryCreate, 200);
      return;
    }
    state.ytPlayer = new YT.Player("yt-player", {
      videoId: uid,
      width: "100%",
      height: "100%",
      playerVars: { rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          state.ytPollId = setInterval(() => {
            if (state.ytPlayer && typeof state.ytPlayer.getCurrentTime === "function") {
              updatePlayhead(state.ytPlayer.getCurrentTime());
            }
          }, 250);
        },
      },
    });
  };
  tryCreate();
}

// ── Metadata → info popover ───────────────────────────────────────────────────
function renderMeta(uid, meta) {
  const stats = [
    meta.duration    ? `Duration: ${fmtDuration(meta.duration)}` : "",
    meta.view_count != null ? `Views: ${fmtNum(meta.view_count)}` : "",
    meta.like_count != null ? `Likes: ${fmtNum(meta.like_count)}` : "",
    meta.upload_date ? `Uploaded: ${meta.upload_date}` : "",
  ].filter(Boolean).join(" · ");

  infoPopover.innerHTML = `
    <h3>${esc(meta.title || uid)}</h3>
    ${stats ? `<div class="info-stats">${esc(stats)}</div>` : ""}
    ${meta.description ? `<div class="info-desc">${esc(meta.description)}</div>` : ""}
  `;
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function renderTimeline(nodes, duration) {
  timelineContainer.innerHTML = "";
  playhead.style.left = "0px";
  if (!nodes.length || !duration) return;

  const byLevel = groupByLevel(nodes);
  const maxLevel = Math.max(...Object.keys(byLevel).map(Number));

  Object.keys(byLevel).sort((a, b) => +a - +b).forEach(lvl => {
    const row = document.createElement("div");
    row.className = "timeline-row";
    row.dataset.level = lvl;

    const label = document.createElement("span");
    label.className = "tl-level-label";
    label.textContent = `L${lvl}`;
    row.appendChild(label);

    byLevel[lvl].forEach(node => {
      const left  = clamp(node.start / duration * 100, 0, 100);
      const width = clamp((node.end - node.start) / duration * 100, 0, 100 - left);
      if (width < 0.05) return;

      const seg = document.createElement("div");
      seg.className = "segment";
      seg.style.left  = `${left}%`;
      seg.style.width = `${width}%`;
      seg.style.background = levelColor(+lvl, maxLevel);
      const tip = node.gpt?.action?.brief || node.plm_action || node.plm_caption || "";
      if (tip) seg.dataset.tip = tip.length > 120 ? tip.slice(0, 117) + "…" : tip;
      seg.dataset.start = node.start;
      row.appendChild(seg);
    });

    timelineContainer.appendChild(row);
  });
}

function onTimelineClick(e) {
  const seg = e.target.closest(".segment");
  if (seg) {
    seekTo(parseFloat(seg.dataset.start));
    return;
  }
  const row = e.target.closest(".timeline-row");
  if (row && state.duration) {
    const rect = row.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.duration;
    seekTo(t);
  }
}

function seekTo(t) {
  if (state.localMode) {
    localPlayer.currentTime = t;
  } else if (state.ytPlayer && typeof state.ytPlayer.seekTo === "function") {
    state.ytPlayer.seekTo(t, true);
  }
  updatePlayhead(t);
}

// ── Playhead & nodes update ───────────────────────────────────────────────────
function updatePlayhead(t) {
  if (!state.duration) return;
  const pct  = clamp(t / state.duration * 100, 0, 100);
  const wrapW = timelineWrap.offsetWidth;
  // 30px = padding-left di #timeline-container (spazio etichette L0/L1)
  playhead.style.left = `${30 + (pct / 100) * (wrapW - 30)}px`;

  const active = getActiveNodes(state.nodes, t);
  const activeIds = active.map(n => n.node_id).join(",");
  if (activeIds !== state.lastActiveIds) {
    state.lastActiveIds = activeIds;
    renderNodesPanel(active);
  }

  if (ccEnabled && state.transcript.length) {
    const seg = getCurrentTranscriptSeg(state.transcript, t);
    ccOverlay.textContent = seg ? seg.text : "";
    ccOverlay.hidden = !seg;
  }
}

function getActiveNodes(nodes, t) {
  const byLevel = {};
  nodes.forEach(node => {
    if (node.start <= t && node.end > t) {
      const lvl = node.level ?? 0;
      if (!byLevel[lvl] || node.start > byLevel[lvl].start) {
        byLevel[lvl] = node;
      }
    }
  });
  return Object.keys(byLevel)
    .sort((a, b) => +a - +b)
    .map(k => byLevel[k]);
}

// ── Nodes panel ───────────────────────────────────────────────────────────────
function renderNodesPanel(activeNodes) {
  if (!activeNodes.length) {
    nodesPanel.innerHTML = '<span id="nodes-placeholder">No active annotations at this time.</span>';
    return;
  }

  const maxLevel = Math.max(...state.nodes.map(n => n.level ?? 0), 1);
  const deepest  = activeNodes[activeNodes.length - 1];

  nodesPanel.innerHTML = "";
  activeNodes.forEach(node => {
    const lvl    = node.level ?? 0;
    const color  = levelColor(lvl, maxLevel);
    const gpt    = node.gpt || {};
    const action  = gpt.action  || {};
    const summary = gpt.summary || {};

    const card = document.createElement("details");
    card.className = "node-card" + (node === deepest ? " highlight" : "");
    card.style.borderLeftColor = color;
    if (state.openLevels.has(lvl)) card.open = true;
    card.addEventListener("toggle", () => {
      if (card.open) state.openLevels.add(lvl);
      else state.openLevels.delete(lvl);
    });

    const actorStr = action.actor  || "";
    const gptBrief = action.brief  || "";
    const gptSum   = summary.brief || "";

    card.innerHTML = `
      <summary>
        <span class="node-card-header">
          <span class="level-badge">L${lvl}</span>
          <span class="time-badge">${fmtDuration(node.start)}–${fmtDuration(node.end)}</span>
          ${actorStr ? `<span class="node-actor">👤 <span class="llm-badge llm-gpt">GPT</span> ${esc(actorStr)}</span>` : ""}
          ${gptBrief ? `<span class="node-brief">⚡ <span class="llm-badge llm-gpt">GPT</span> ${esc(gptBrief)}</span>` : ""}
          <span class="details-arrow"></span>
        </span>
      </summary>
      ${buildDetailsHtml(node, action, summary, gptSum)}
    `;
    nodesPanel.appendChild(card);
  });

  if (deepest) {
    const cards = nodesPanel.querySelectorAll(".node-card");
    cards[cards.length - 1]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function buildDetailsHtml(node, action, summary, gptSum) {
  const rows = [];
  if (gptSum)              rows.push(`<div>💬 <span class="llm-badge llm-gpt">GPT</span> ${esc(gptSum)}</div>`);
  if (action.detailed)     rows.push(`<div>⚡⚡ <span class="llm-badge llm-gpt">GPT</span> ${esc(action.detailed)}</div>`);
  if (summary.detailed)    rows.push(`<div>💬💬 <span class="llm-badge llm-gpt">GPT</span> ${esc(summary.detailed)}</div>`);
  if (node.plm_action)     rows.push(`<div>⚡ <span class="llm-badge llm-plm">PLM</span> ${esc(node.plm_action)}</div>`);
  if (node.plm_caption)    rows.push(`<div>💬💬 <span class="llm-badge llm-plm">PLM</span> ${esc(node.plm_caption)}</div>`);
  if (node.llama3_caption) rows.push(`<div>💬💬 <span class="llm-badge llm-l3">L3</span> ${esc(node.llama3_caption)}</div>`);
  if (!rows.length) return "";
  return `<div class="node-details-body">${rows.join("")}</div>`;
}

// ── Clear / stop ──────────────────────────────────────────────────────────────
function clearPlayer() {
  stopPlayback();
  localPlayer.hidden = true;
  localPlayer.src = "";
  ytPlayerDiv.hidden = true;
  ytPlayerDiv.innerHTML = "";
  playerPlaceholder.hidden = false;
  playerPlaceholder.querySelector("span").textContent = "Select a video to begin";
  ytLink.hidden = true;
  ccOverlay.hidden = true;
  state.transcript = [];
  infoPopover.innerHTML = "";
  timelineContainer.innerHTML = "";
  nodesPanel.innerHTML = '<span id="nodes-placeholder">Select a video to begin.</span>';
  state.lastActiveIds = "";
  state.openLevels = new Set();
}

function stopPlayback() {
  if (state.rafId)   { cancelAnimationFrame(state.rafId);  state.rafId   = null; }
  if (state.ytPollId){ clearInterval(state.ytPollId);       state.ytPollId = null; }
  if (state.ytPlayer && typeof state.ytPlayer.destroy === "function") {
    try { state.ytPlayer.destroy(); } catch (_) {}
    state.ytPlayer = null;
  }
  if (!localPlayer.paused) localPlayer.pause();
}

// ── CC subtitles ──────────────────────────────────────────────────────────────
function initCCButton() {
  ccBtn.addEventListener("click", () => {
    ccEnabled = !ccEnabled;
    ccBtn.classList.toggle("active", ccEnabled);
    if (!ccEnabled) ccOverlay.hidden = true;
  });
}

function getCurrentTranscriptSeg(segs, t) {
  let last = null;
  for (const seg of segs) {
    if (parseFloat(seg.time) <= t) last = seg;
    else break;
  }
  if (last && t - parseFloat(last.time) > 3) return null;
  return last;
}

// ── Info popover ──────────────────────────────────────────────────────────────
function initInfoPopover() {
  infoBtn.addEventListener("click", e => {
    const open = !infoPopover.hidden;
    infoPopover.hidden = open;
    infoBtn.classList.toggle("active", !open);
    e.stopPropagation();
  });
  document.addEventListener("click", () => {
    infoPopover.hidden = true;
    infoBtn.classList.remove("active");
  });
  infoPopover.addEventListener("click", e => e.stopPropagation());
}

// ── Resize handle ─────────────────────────────────────────────────────────────
function initResizeHandles() {
  setupResize(document.getElementById("rh-main"), document.getElementById("main-area"), 80, 700);
}

function setupResize(handle, target, minH, maxH) {
  let startY, startH;
  handle.addEventListener("mousedown", e => {
    startY = e.clientY;
    startH = target.getBoundingClientRect().height;
    handle.classList.add("dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
  function onMove(e) {
    target.style.flex = `0 0 ${clamp(startH + (e.clientY - startY), minH, maxH)}px`;
  }
  function onUp() {
    handle.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function groupByLevel(nodes) {
  const m = {};
  nodes.forEach(n => { const l = n.level ?? 0; (m[l] = m[l] || []).push(n); });
  return m;
}

function levelColor(level, maxLevel) {
  return `hsl(${(level / Math.max(maxLevel, 1)) * 300}, 70%, 55%)`;
}

function estimateDuration(nodes) {
  return nodes.reduce((mx, n) => Math.max(mx, n.end || 0), 0);
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function enc(s) { return encodeURIComponent(s); }

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDuration(s) {
  if (s == null) return "?";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function fmtNum(n) {
  if (n == null) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`API ${url} → ${r.status}`);
  return r.json();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
init().catch(console.error);
