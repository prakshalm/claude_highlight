# Google Drive backup — setup

The extension can back up every highlight and note to your Google Drive and
restore them later (e.g. if you lose the extension or switch computers).

Backups are stored in Drive's **appDataFolder** — a hidden folder that only
this extension can read or write. Nothing is added to your visible "My Drive",
and the extension only ever requests the narrow `drive.appdata` scope.

Because Google requires each extension to use its **own** OAuth client, you
have to create one once and paste its ID into `manifest.json`.

## 1. Get a stable extension ID and its redirect URL

Auth ties the OAuth client to your extension's redirect URL, which is derived
from the extension ID, so the ID must not change between reloads.

- **Published (Chrome Web Store):** use the ID the store assigns.
- **Local/unpacked:** load the unpacked extension once, copy its ID from
  `chrome://extensions`, then pin it by adding your extension's `key` to
  `manifest.json` (see Chrome docs: "Keep a consistent extension ID").

The redirect URL is `https://<extension-id>.chromiumapp.org/` — Chrome returns
it from `chrome.identity.getRedirectURL()`. You'll register this exact string
(including the trailing slash) on the OAuth client below.

## 2. Create the OAuth client

> **Important:** use a **Web application** client, not "Chrome App"/"Chrome
> Extension". This extension authenticates with `chrome.identity.launchWebAuthFlow`.
> The older "Chrome Extension" client type (used by `getAuthToken`) is now
> rejected by Google with *"Custom URI scheme is not supported on Chrome apps"*
> / *Error 400: invalid_request*.

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen / Data Access:** add the scope
   `https://www.googleapis.com/auth/drive.appdata`. If the app is in **Testing**
   mode, add your Google account under **Audience → Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**.
   - **Authorized redirect URIs → Add URI:** paste your
     `https://<extension-id>.chromiumapp.org/` from step 1 (exact, with the
     trailing slash).
5. Copy the generated **Client ID** (looks like `1234-abcd.apps.googleusercontent.com`).

## 3. Wire it into the extension

In `manifest.json`, replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.appdata"]
}
```

with your real client ID, then reload the extension.

## 4. Use it

Open the popup → **Google Drive backup**:

- **Connect** — sign in and grant access; seeds the first backup.
- Auto-backup — from then on, any new/changed highlight or note is uploaded
  automatically (debounced a few seconds).
- **Back up now** — force an immediate upload.
- **Restore from Drive** — pull the Drive backup back into local storage
  (replaces local highlights/notes).
- **Disconnect** — revoke access and stop auto-backup.

## Publishing (Testing vs Production)

Because the app requests the **sensitive** `drive.appdata` scope, moving the
OAuth consent screen from **Testing** to **Production** triggers Google's
verification requirements:

- **Testing (recommended for a small group):** works immediately, but only
  emails added under **Audience → Test users** can connect (100-user lifetime
  cap). No verification needed.
- **Production, unverified:** anyone can connect, but they see a
  "Google hasn't verified this app" warning and must click **Advanced → Go to
  (unsafe)**.
- **Production, verified:** removes the warning. Requires a completed consent
  screen, a privacy policy URL, a homepage on a verified domain, and usually a
  demo video. `drive.appdata`/`drive.file` are exempt from the heavier
  restricted-scope security assessment, so this is the lighter verification path.

## ⚠️ Chrome Web Store changes the extension ID (and therefore the redirect URI)

The redirect URI is derived from the extension ID:
`https://<extension-id>.chromiumapp.org/`. Locally the ID is pinned by the
`key` in `manifest.json`. **When you upload to the Chrome Web Store, Google
assigns a different ID** (from the store's own key), so the redirect URI
changes to `https://<store-id>.chromiumapp.org/`.

Before/after publishing to the store you must:

1. Get the store-assigned extension ID (shown on the item's dashboard, or via
   `chrome.identity.getRedirectURL()` on an install of the store build).
2. Add `https://<store-id>.chromiumapp.org/` to the Web application client's
   **Authorized redirect URIs** (keep the local `…chromiumapp.org/` one too if
   you still develop unpacked).

Otherwise Drive sync fails for store users with `redirect_uri_mismatch`.

## Notes

- Auto-backup only runs while connected.
- Only one backup file (`claude-highlights-backup.json`) is kept; each backup
  overwrites it with the full current state.
- Restore **replaces** local data with the Drive copy — export first
  (popup → Export JSON) if you want a local snapshot beforehand.
