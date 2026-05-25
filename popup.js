const STORAGE_KEY = "claude_highlights_v1";
const ENABLED_HOSTS_KEY = "claude_hl_enabled_hosts";
const AUTO_ENABLED_HOSTS = ["claude.ai", "chatgpt.com", "chat.openai.com"];

function isHostAutoEnabled(host) {
  return AUTO_ENABLED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// Build a human title + clickable URL from a stored page identifier.
function pageInfo(convId) {
  if (/^[a-f0-9-]{36}$/i.test(convId)) {
    return {
      url: `https://claude.ai/chat/${convId}`,
      title: `Claude · ${convId.slice(0, 8)}…`,
    };
  }
  if (convId.startsWith("chatgpt.com/")) {
    const id = convId.slice("chatgpt.com/".length);
    return {
      url: `https://chatgpt.com/c/${id}`,
      title: `ChatGPT · ${id.slice(0, 8)}…`,
    };
  }
  // Generic page-id: host + pathname
  return { url: `https://${convId}`, title: convId };
}

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");

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

async function render() {
  const all = await loadAll();
  const q = (searchEl.value || "").toLowerCase().trim();
  listEl.innerHTML = "";

  const convs = Object.keys(all);
  if (convs.length === 0) {
    listEl.innerHTML = '<div class="empty">No highlights yet. Open a Claude chat and select some text!</div>';
    return;
  }

  let totalShown = 0;
  for (const convId of convs) {
    const highlights = all[convId] || [];
    const filtered = q
      ? highlights.filter(
          (h) => h.text.toLowerCase().includes(q) || (h.note || "").toLowerCase().includes(q),
        )
      : highlights;
    if (!filtered.length) continue;

    const convDiv = document.createElement("div");
    convDiv.className = "conv";

    const info = pageInfo(convId);
    const header = document.createElement("div");
    header.className = "conv-header";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = `${info.title} (${filtered.length})`;
    titleSpan.title = info.title;
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
        <div class="meta"><span>${formatDate(h.createdAt)}</span><button class="del" data-id="${h.id}" data-conv="${convId}">Delete</button></div>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        // Jump to the highlight in an existing tab on this page, or open one.
        const queryUrl = info.url + "*";
        chrome.tabs.query({ url: queryUrl }, (tabs) => {
          const openAndJump = (tabId) => {
            chrome.tabs.update(tabId, { active: true }, () => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: "scrollToHighlight", id: h.id });
              }, 500);
            });
          };
          if (tabs && tabs.length > 0) {
            openAndJump(tabs[0].id);
          } else {
            chrome.tabs.create({ url: info.url }, (tab) => {
              setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: "scrollToHighlight", id: h.id }), 2500);
            });
          }
        });
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
      const convId = btn.dataset.conv;
      const data = await loadAll();
      if (data[convId]) {
        data[convId] = data[convId].filter((h) => h.id !== id);
        if (data[convId].length === 0) delete data[convId];
        await saveAll(data);
        render();
      }
    });
  });
}

searchEl.addEventListener("input", render);

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
  if (!confirm("Delete ALL highlights and notes across all chats? This cannot be undone.")) return;
  await saveAll({});
  render();
});

// --- Site toggle: enable highlighter on the current tab's host ---------------

async function initSiteToggle() {
  const hostEl = document.getElementById("siteHost");
  const stateEl = document.getElementById("siteState");
  const switchEl = document.getElementById("enableSwitch");
  const checkbox = document.getElementById("enableToggle");

  const tabs = await new Promise((r) =>
    chrome.tabs.query({ active: true, currentWindow: true }, r),
  );
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) {
    hostEl.textContent = "No active tab";
    stateEl.textContent = "";
    return;
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    hostEl.textContent = tab.url;
    stateEl.textContent = "Unsupported page";
    return;
  }
  // Restricted schemes — extension can't run there.
  if (!/^https?:$/.test(url.protocol)) {
    hostEl.textContent = url.hostname || tab.url;
    stateEl.textContent = "Not available on this page";
    return;
  }

  const host = url.hostname;
  hostEl.textContent = host;

  if (isHostAutoEnabled(host)) {
    stateEl.textContent = "Always on";
    switchEl.hidden = true;
    return;
  }

  const stored = await new Promise((r) =>
    chrome.storage.local.get([ENABLED_HOSTS_KEY], r),
  );
  const list = stored[ENABLED_HOSTS_KEY] || [];
  const enabled = list.includes(host);
  checkbox.checked = enabled;
  stateEl.textContent = enabled ? "Enabled on this site" : "Disabled — toggle to enable";
  switchEl.hidden = false;

  checkbox.addEventListener("change", async () => {
    const newEnabled = checkbox.checked;
    const cur = await new Promise((r) =>
      chrome.storage.local.get([ENABLED_HOSTS_KEY], r),
    );
    let curList = cur[ENABLED_HOSTS_KEY] || [];
    if (newEnabled) {
      if (!curList.includes(host)) curList.push(host);
    } else {
      curList = curList.filter((h) => h !== host);
    }
    await new Promise((r) =>
      chrome.storage.local.set({ [ENABLED_HOSTS_KEY]: curList }, r),
    );
    stateEl.textContent = newEnabled ? "Enabled on this site" : "Disabled — toggle to enable";
    try {
      chrome.tabs.sendMessage(tab.id, { type: "setEnabled", enabled: newEnabled }, () => {
        // Swallow "Receiving end does not exist" if the content script hasn't
        // loaded yet (e.g., very new tab); a refresh will pick up the saved pref.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* ignore */
    }
  });
}

initSiteToggle();

render();
