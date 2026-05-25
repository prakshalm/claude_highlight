const STORAGE_KEY = "claude_highlights_v1";

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

    const header = document.createElement("div");
    header.className = "conv-header";
    header.innerHTML = `<span>Chat ${convId.slice(0, 8)}… (${filtered.length})</span>`;
    const link = document.createElement("a");
    link.href = `https://claude.ai/chat/${convId}`;
    link.target = "_blank";
    link.textContent = "Open chat";
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
        // Jump to the highlight in the chat tab.
        chrome.tabs.query({ url: `https://claude.ai/chat/${convId}*` }, (tabs) => {
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
            chrome.tabs.create({ url: `https://claude.ai/chat/${convId}` }, (tab) => {
              // Give the content script time to load and restore highlights.
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

render();
