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

async function renderList() {
  const all = await loadAll();
  const q = (searchEl.value || "").toLowerCase().trim();
  listEl.innerHTML = "";

  const keys = Object.keys(all);
  if (keys.length === 0) {
    listEl.innerHTML = '<div class="empty">No highlights yet. Select some text in a Claude / ChatGPT reply (or any enabled site) to create one.</div>';
    return;
  }

  let totalShown = 0;
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

    const convDiv = document.createElement("div");
    convDiv.className = "conv";

    const header = document.createElement("div");
    header.className = "conv-header";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = `${info.hostLabel} · ${info.label} (${filtered.length})`;
    header.appendChild(titleSpan);
    const link = document.createElement("a");
    link.href = info.url;
    link.target = "_blank";
    link.textContent = "Open";
    header.appendChild(link);
    convDiv.appendChild(header);

    for (const h of filtered) {
      totalShown++;
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
      convDiv.appendChild(item);
    }

    listEl.appendChild(convDiv);
  }

  if (totalShown === 0) {
    listEl.innerHTML = '<div class="empty">No matches.</div>';
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

clearBtn.addEventListener("click", async () => {
  if (!confirm("Delete ALL highlights and notes across all sites? This cannot be undone.")) return;
  await saveAll({});
  renderList();
});

activateOnCurrentTab();
renderList();
