const STORAGE_KEY = "claude_highlights_v1";
const DEFAULT_ORIGINS = [
  "https://claude.ai",
  "https://chatgpt.com",
  "https://chat.openai.com",
];

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const siteHostEl = document.getElementById("siteHost");
const siteStatusEl = document.getElementById("siteStatus");
const driveStatusEl = document.getElementById("driveStatus");
const driveAccountEl = document.getElementById("driveAccount");
const driveConnectBtn = document.getElementById("driveConnectBtn");
const driveActionsEl = document.getElementById("driveActions");
const driveBackupBtn = document.getElementById("driveBackupBtn");
const driveRestoreBtn = document.getElementById("driveRestoreBtn");
const driveDisconnectBtn = document.getElementById("driveDisconnectBtn");

function loadAll() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => resolve(res[STORAGE_KEY] || {}));
  });
}

function saveAll(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: data }, () => resolve());
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return "";
  }
}

// --- Site-control panel ----------------------------------------------------

async function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0])),
  );
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isDefaultOrigin(origin) {
  return DEFAULT_ORIGINS.includes(origin);
}

// Opening the popup counts as a user gesture, so activeTab permission lets us
// inject content.js into the active tab without any permission dialog. The
// injection lasts only until the tab navigates / reloads — to re-enable, the
// user just clicks the icon again.
async function activateOnCurrentTab() {
  const tab = await getActiveTab();
  const origin = tab && originOf(tab.url);
  if (!origin) {
    siteHostEl.textContent = "Not a web page";
    siteStatusEl.textContent = "Open a normal http(s) tab to highlight here.";
    return;
  }
  siteHostEl.textContent = new URL(origin).hostname;

  if (isDefaultOrigin(origin)) {
    siteStatusEl.textContent = "Default site — always on";
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"],
    });
    siteStatusEl.textContent = "Activated on this tab. Reload the page → click the icon again to re-activate.";
  } catch (e) {
    siteStatusEl.textContent = "Couldn't activate on this tab (" + (e && e.message ? e.message : "unknown error") + ").";
  }
}

// --- Highlights list -------------------------------------------------------

// Derive display info for a storage key.
//   "<uuid>"           -> Claude chat
//   "chatgpt:<uuid>"   -> ChatGPT chat
//   "url:<url>"        -> Arbitrary page
function describeKey(key, sampleHighlight) {
  if (key.startsWith("chatgpt:")) {
    const id = key.slice("chatgpt:".length);
    const url = sampleHighlight && sampleHighlight.url ? sampleHighlight.url : `https://chatgpt.com/c/${id}`;
    return { hostLabel: "ChatGPT", label: `Chat ${id.slice(0, 8)}…`, url };
  }
  if (key.startsWith("url:")) {
    const url = sampleHighlight && sampleHighlight.url ? sampleHighlight.url : key.slice("url:".length);
    let hostLabel = "Page";
    try {
      hostLabel = new URL(url).hostname;
    } catch {}
    const title = sampleHighlight && sampleHighlight.title;
    return { hostLabel, label: title || url.replace(/^https?:\/\//, ""), url };
  }
  // Legacy / Claude: bare conversation UUID.
  const url = sampleHighlight && sampleHighlight.url ? sampleHighlight.url : `https://claude.ai/chat/${key}`;
  return { hostLabel: "Claude", label: `Chat ${key.slice(0, 8)}…`, url };
}

function jumpToHighlight(targetUrl, highlightId) {
  // Try matching open tabs by exact URL first, then by origin+path prefix.
  chrome.tabs.query({}, (tabs) => {
    const exact = tabs.find((t) => t.url === targetUrl);
    let target = exact;
    if (!target) {
      try {
        const u = new URL(targetUrl);
        target = tabs.find((t) => {
          try {
            const tu = new URL(t.url);
            return tu.origin === u.origin && tu.pathname === u.pathname;
          } catch {
            return false;
          }
        });
      } catch {}
    }
    const sendJump = (tabId, delay = 500) => {
      chrome.tabs.update(tabId, { active: true }, () => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: "scrollToHighlight", id: highlightId });
        }, delay);
      });
    };
    if (target) {
      sendJump(target.id);
    } else {
      chrome.tabs.create({ url: targetUrl }, (tab) => sendJump(tab.id, 2500));
    }
  });
}

// The tab whose chat we're viewing, so its notes can be surfaced first.
let currentChatUrl = null;

function sameChat(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

async function renderList() {
  const all = await loadAll();
  const q = (searchEl.value || "").toLowerCase().trim();
  listEl.innerHTML = "";

  const keys = Object.keys(all);
  if (keys.length === 0) {
    listEl.innerHTML = '<div class="empty">No highlights yet. Select some text in a Claude / ChatGPT reply (or any enabled site) to create one.</div>';
    return;
  }

  // Collect conversations that have matches, so we can order + collapse them.
  const sections = [];
  for (const key of keys) {
    const highlights = all[key] || [];
    const filtered = q
      ? highlights.filter(
          (h) => h.text.toLowerCase().includes(q) || (h.note || "").toLowerCase().includes(q),
        )
      : highlights;
    if (!filtered.length) continue;
    const sample = filtered[0] || highlights[0];
    const info = describeKey(key, sample);
    sections.push({ key, filtered, info, isCurrent: sameChat(info.url, currentChatUrl) });
  }

  if (!sections.length) {
    listEl.innerHTML = '<div class="empty">No matches.</div>';
    return;
  }

  // The chat you're looking at comes first; everything else stays collapsed
  // below so the popup opens uncluttered.
  sections.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));

  for (const { key, filtered, info, isCurrent } of sections) {
    const convDiv = document.createElement("div");
    convDiv.className = "conv";
    // Expand automatically while searching so matches are visible; otherwise
    // start collapsed and let the user open what they want.
    if (q) convDiv.classList.add("expanded");

    const header = document.createElement("div");
    header.className = "conv-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "conv-toggle";
    toggle.innerHTML = `
      <svg class="chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 6l6 6-6 6z"/></svg>
      <span class="conv-title">${isCurrent ? '<span class="chip">This chat</span>' : ""}${escapeHtml(info.hostLabel)} · ${escapeHtml(info.label)}</span>
      <span class="count">${filtered.length}</span>
    `;
    toggle.addEventListener("click", () => convDiv.classList.toggle("expanded"));
    header.appendChild(toggle);

    const link = document.createElement("a");
    link.className = "open-link";
    link.href = info.url;
    link.target = "_blank";
    link.textContent = "Open";
    link.title = "Open chat in a new tab";
    header.appendChild(link);
    convDiv.appendChild(header);

    const body = document.createElement("div");
    body.className = "conv-body";
    for (const h of filtered) {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <div><span class="swatch" style="background:${h.color || "#fff59d"}"></span><span class="text">${escapeHtml(h.text)}</span></div>
        ${h.note ? `<div class="note">${escapeHtml(h.note)}</div>` : ""}
        <div class="meta"><span>${formatDate(h.createdAt)}</span><button class="del" data-id="${h.id}" data-key="${escapeHtml(key)}">Delete</button></div>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        jumpToHighlight(h.url || info.url, h.id);
      });
      body.appendChild(item);
    }
    convDiv.appendChild(body);
    listEl.appendChild(convDiv);
  }

  listEl.querySelectorAll(".del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const key = btn.dataset.key;
      const data = await loadAll();
      if (data[key]) {
        data[key] = data[key].filter((h) => h.id !== id);
        if (data[key].length === 0) delete data[key];
        await saveAll(data);
        renderList();
      }
    });
  });
}

searchEl.addEventListener("input", renderList);

exportBtn.addEventListener("click", async () => {
  const all = await loadAll();
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `claude-highlights-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const importBtn = document.getElementById("importBtn");
const importFileEl = document.getElementById("importFile");

// Accepts either a bare highlights object ({ convKey: [...] }) or the wrapped
// backup envelope produced by the Drive backup ({ app, version, data }).
function extractHighlights(parsed) {
  const obj = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const v of Object.values(obj)) {
    if (!Array.isArray(v)) return null; // every key must map to a highlights array
  }
  return obj;
}

// Merge imported highlights into existing storage: union per conversation key,
// deduped by highlight id (imported version wins on conflict). Non-destructive
// so importing never silently drops what's already there.
function mergeHighlights(existing, incoming) {
  const out = { ...existing };
  for (const [key, list] of Object.entries(incoming)) {
    const byId = new Map((out[key] || []).map((h) => [h.id, h]));
    for (const h of list) byId.set(h.id, h);
    out[key] = Array.from(byId.values());
  }
  return out;
}

importBtn.addEventListener("click", () => importFileEl.click());

importFileEl.addEventListener("change", async () => {
  const file = importFileEl.files && importFileEl.files[0];
  importFileEl.value = ""; // allow re-importing the same file later
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    alert("That file isn't valid JSON.");
    return;
  }
  const incoming = extractHighlights(parsed);
  if (!incoming) {
    alert("That doesn't look like a LumiNote export.");
    return;
  }
  const count = Object.values(incoming).reduce((n, arr) => n + arr.length, 0);
  if (!confirm(`Import ${count} highlight(s) from this file? They'll be merged into your existing highlights.`)) return;
  const merged = mergeHighlights(await loadAll(), incoming);
  await saveAll(merged);
  renderList();
});

// confirm() is unreliable inside extension popups (Chrome can suppress the
// dialog and return false, silently aborting the action), so destructive
// buttons confirm via a two-click "arm": the first click swaps the button to a
// warning label; a second click within 4s proceeds. Returns true only on that
// confirming second click.
const armedButtons = new WeakMap();
function armConfirm(btn, armedLabel) {
  const state = armedButtons.get(btn);
  if (state) {
    clearTimeout(state.timer);
    armedButtons.delete(btn);
    btn.textContent = state.label;
    btn.classList.remove("danger");
    return true;
  }
  const label = btn.textContent;
  btn.textContent = armedLabel;
  btn.classList.add("danger");
  const timer = setTimeout(() => {
    armedButtons.delete(btn);
    btn.textContent = label;
    btn.classList.remove("danger");
  }, 4000);
  armedButtons.set(btn, { label, timer });
  return false;
}

clearBtn.addEventListener("click", async () => {
  if (!armConfirm(clearBtn, "Click again to delete all")) return;
  await saveAll({});
  renderList();
});

// --- Google Drive backup ---------------------------------------------------

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "No response" });
      }
    });
  });
}

function setDriveStatus(text, kind) {
  driveStatusEl.textContent = text;
  driveStatusEl.className = "drive-status" + (kind ? " " + kind : "");
}

function relativeTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return d.toLocaleDateString();
}

function applyDriveState(res) {
  if (!res || !res.ok) {
    setDriveStatus(res && res.error ? res.error : "Drive unavailable", "error");
    return;
  }
  if (!res.configured) {
    setDriveStatus("Not set up — add an OAuth client ID (see DRIVE_SETUP.md)", "error");
    driveConnectBtn.disabled = true;
    driveActionsEl.hidden = true;
    return;
  }
  const meta = res.meta || {};
  if (meta.connected) {
    driveActionsEl.hidden = false;
    if (meta.email) {
      driveAccountEl.textContent = "Linked to " + meta.email;
      driveAccountEl.hidden = false;
    } else {
      driveAccountEl.hidden = true;
    }
    if (meta.needsReauth) {
      // Silent token refresh lapsed — one click resumes sync. Keep the account
      // linked and offer Reconnect alongside the usual actions.
      driveConnectBtn.hidden = false;
      driveConnectBtn.disabled = false;
      driveConnectBtn.textContent = "Reconnect";
      setDriveStatus("Sync paused — reconnect to resume auto-backup", "error");
    } else {
      driveConnectBtn.hidden = true;
      driveConnectBtn.textContent = "Connect";
      if (meta.lastError) {
        setDriveStatus("Last sync failed: " + meta.lastError, "error");
      } else if (meta.lastBackupAt) {
        setDriveStatus("Backed up " + relativeTime(meta.lastBackupAt), "ok");
      } else {
        setDriveStatus("Connected", "ok");
      }
    }
  } else {
    driveConnectBtn.hidden = false;
    driveConnectBtn.disabled = false;
    driveConnectBtn.textContent = "Connect";
    driveActionsEl.hidden = true;
    driveAccountEl.hidden = true;
    setDriveStatus("Not connected — auto-backs up your highlights & notes");
  }
}

async function refreshDriveStatus() {
  applyDriveState(await sendToBackground({ type: "drive-status" }));
}

driveConnectBtn.addEventListener("click", async () => {
  driveConnectBtn.disabled = true;
  setDriveStatus("Connecting to Google…");
  const res = await sendToBackground({ type: "drive-connect" });
  driveConnectBtn.disabled = false;
  applyDriveState({ ok: true, configured: true, meta: res.meta });
  if (!res.ok) setDriveStatus(res.error || "Connection failed", "error");
});

driveBackupBtn.addEventListener("click", async () => {
  driveBackupBtn.disabled = true;
  setDriveStatus("Backing up…");
  const res = await sendToBackground({ type: "drive-backup" });
  driveBackupBtn.disabled = false;
  applyDriveState({ ok: true, configured: true, meta: res.meta });
  if (!res.ok) setDriveStatus(res.error || "Backup failed", "error");
});

driveRestoreBtn.addEventListener("click", async () => {
  driveRestoreBtn.disabled = true;
  setDriveStatus("Restoring from Drive…");
  const res = await sendToBackground({ type: "drive-restore" });
  driveRestoreBtn.disabled = false;
  if (res.ok) {
    applyDriveState({ ok: true, configured: true, meta: res.meta });
    setDriveStatus("Restored" + (res.backedUpAt ? " (backup from " + formatDate(res.backedUpAt) + ")" : ""), "ok");
    renderList();
  } else {
    setDriveStatus(res.error || "Restore failed", "error");
  }
});

driveDisconnectBtn.addEventListener("click", async () => {
  const res = await sendToBackground({ type: "drive-disconnect" });
  applyDriveState({ ok: true, configured: true, meta: res.meta });
});

async function initList() {
  try {
    const tab = await getActiveTab();
    currentChatUrl = (tab && tab.url) || null;
  } catch {
    currentChatUrl = null;
  }
  renderList();
}

activateOnCurrentTab();
initList();
refreshDriveStatus();
