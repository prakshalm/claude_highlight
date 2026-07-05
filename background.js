// Claude Highlighter — background service worker
// Google Drive backup/sync for highlights + notes.
//
// Data lives in chrome.storage.local under STORAGE_KEY as { convKey: [highlight, ...] }.
// We mirror that whole object to a single JSON file in the user's Drive
// **appDataFolder** — a hidden folder that only this extension can read/write,
// so backups never clutter "My Drive" and require only the lightweight
// drive.appdata OAuth scope.
//
// Two behaviours, matching the feature request:
//   1. Auto-upload: any change to the highlights store (new/updated/deleted
//      highlight or note) triggers a debounced backup. A single
//      storage.onChanged listener covers every save path in content.js.
//   2. Fetch: the popup can pull the Drive backup back into local storage
//      (disaster recovery if the extension/profile is lost).

const STORAGE_KEY = "claude_highlights_v1";
const SYNC_META_KEY = "claude_highlights_sync_v1"; // never itself backed up
const BACKUP_FILE_NAME = "claude-highlights-backup.json";
const SCOPES = ["https://www.googleapis.com/auth/drive.appdata"];
const AUTO_BACKUP_DEBOUNCE_MS = 4000;

// --- Sync metadata ---------------------------------------------------------
// { connected, lastBackupAt, lastRestoreAt, lastError, fileId, lastHash }

async function getMeta() {
  const res = await chrome.storage.local.get([SYNC_META_KEY]);
  return res[SYNC_META_KEY] || { connected: false };
}

async function setMeta(patch) {
  const cur = await getMeta();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SYNC_META_KEY]: next });
  return next;
}

// Cheap, order-stable content fingerprint so we can skip redundant uploads
// (e.g. re-saving the exact data we just restored from Drive).
function hashData(obj) {
  const str = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${str.length}:${h >>> 0}`;
}

// --- OAuth -----------------------------------------------------------------

function isConfigured() {
  const oauth = chrome.runtime.getManifest().oauth2;
  const id = oauth && oauth.client_id;
  return !!id && !/YOUR_GOOGLE|REPLACE_ME/i.test(id);
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "No token"));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

// Fetch against a Drive endpoint, transparently refreshing a stale token once.
async function driveFetch(url, options = {}, interactive = false) {
  if (!isConfigured()) {
    throw new Error("Google Drive is not configured. Add your OAuth client ID to manifest.json (see DRIVE_SETUP.md).");
  }
  let token = await getAuthToken(interactive);
  let res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Token expired/revoked — drop it and retry once with a fresh one.
    await removeCachedToken(token);
    token = await getAuthToken(interactive);
    res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  }
  return res;
}

// --- Drive file helpers ----------------------------------------------------

async function findBackupFileId(interactive) {
  const q = encodeURIComponent(`name='${BACKUP_FILE_NAME}'`);
  const url =
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder` +
    `&fields=files(id,name,modifiedTime)&q=${q}`;
  const res = await driveFetch(url, {}, interactive);
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function uploadBackup(interactive) {
  const store = await chrome.storage.local.get([STORAGE_KEY]);
  const data = store[STORAGE_KEY] || {};
  const payload = JSON.stringify(
    { app: "claude-highlighter", version: 1, backedUpAt: new Date().toISOString(), data },
    null,
    2,
  );

  const meta = await getMeta();
  let fileId = meta.fileId;
  if (fileId) {
    // Verify it still exists; ignore if it was deleted out from under us.
    const check = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?spaces=appDataFolder&fields=id`,
      {},
      interactive,
    );
    if (check.status === 404) fileId = null;
  }
  if (!fileId) fileId = await findBackupFileId(interactive);

  let res;
  if (fileId) {
    res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: payload },
      interactive,
    );
  } else {
    // Multipart create: metadata part + media part in one request.
    const boundary = "-------claude-hl-" + Math.random().toString(36).slice(2);
    const metadata = { name: BACKUP_FILE_NAME, parents: ["appDataFolder"] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      `${payload}\r\n--${boundary}--`;
    res = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
      interactive,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive upload failed (${res.status}) ${text.slice(0, 200)}`);
  }
  const out = await res.json().catch(() => ({}));
  const newId = out.id || fileId;
  await setMeta({
    connected: true,
    fileId: newId,
    lastBackupAt: new Date().toISOString(),
    lastHash: hashData(data),
    lastError: null,
  });
  return { fileId: newId };
}

async function downloadBackup(interactive) {
  const fileId = (await getMeta()).fileId || (await findBackupFileId(interactive));
  if (!fileId) throw new Error("No backup found in Google Drive yet.");
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {},
    interactive,
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  const parsed = await res.json();
  // Accept both the wrapped envelope and a bare highlights object.
  const data = parsed && parsed.data ? parsed.data : parsed;
  if (!data || typeof data !== "object") throw new Error("Backup file is not valid.");
  return { data, fileId, backedUpAt: parsed && parsed.backedUpAt };
}

// --- Auto-backup on any highlight/note change ------------------------------

let backupTimer = null;

function scheduleAutoBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    runAutoBackup();
  }, AUTO_BACKUP_DEBOUNCE_MS);
}

async function runAutoBackup() {
  try {
    const meta = await getMeta();
    if (!meta.connected || !isConfigured()) return;
    const store = await chrome.storage.local.get([STORAGE_KEY]);
    const data = store[STORAGE_KEY] || {};
    if (hashData(data) === meta.lastHash) return; // nothing actually changed
    await uploadBackup(false);
  } catch (e) {
    await setMeta({ lastError: String(e && e.message ? e.message : e) });
    console.warn("[Claude Highlighter] Auto-backup failed:", e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[STORAGE_KEY]) return; // ignore meta-key writes → no loop
  scheduleAutoBackup();
});

// --- Popup messaging -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith("drive-")) return;

  (async () => {
    try {
      switch (msg.type) {
        case "drive-status": {
          const meta = await getMeta();
          sendResponse({ ok: true, configured: isConfigured(), meta });
          break;
        }
        case "drive-connect": {
          await getAuthToken(true); // triggers the Google consent screen
          await uploadBackup(true); // seed the backup immediately on connect
          sendResponse({ ok: true, meta: await getMeta() });
          break;
        }
        case "drive-disconnect": {
          try {
            const token = await getAuthToken(false).catch(() => null);
            if (token) {
              await removeCachedToken(token);
              // Best-effort server-side revoke.
              await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" }).catch(() => {});
            }
          } catch (_) {}
          await setMeta({ connected: false, lastError: null });
          sendResponse({ ok: true, meta: await getMeta() });
          break;
        }
        case "drive-backup": {
          await uploadBackup(true);
          sendResponse({ ok: true, meta: await getMeta() });
          break;
        }
        case "drive-restore": {
          const { data, backedUpAt } = await downloadBackup(true);
          // Pre-set lastHash so the resulting storage.onChanged doesn't bounce
          // straight back up to Drive as a redundant upload.
          await setMeta({ lastHash: hashData(data), lastRestoreAt: new Date().toISOString(), lastError: null });
          await chrome.storage.local.set({ [STORAGE_KEY]: data });
          sendResponse({ ok: true, backedUpAt, meta: await getMeta() });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown command" });
      }
    } catch (e) {
      const error = String(e && e.message ? e.message : e);
      await setMeta({ lastError: error });
      sendResponse({ ok: false, error });
    }
  })();

  return true; // keep the message channel open for the async response
});
