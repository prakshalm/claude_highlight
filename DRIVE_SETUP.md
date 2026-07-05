# Google Drive backup — setup

The extension can back up every highlight and note to your Google Drive and
restore them later (e.g. if you lose the extension or switch computers).

Backups are stored in Drive's **appDataFolder** — a hidden folder that only
this extension can read or write. Nothing is added to your visible "My Drive",
and the extension only ever requests the narrow `drive.appdata` scope.

Because Google requires each extension to use its **own** OAuth client, you
have to create one once and paste its ID into `manifest.json`.

## 1. Get a stable extension ID

`chrome.identity.getAuthToken` ties the OAuth client to your extension's ID, so
the ID must not change between reloads.

- **Published (Chrome Web Store):** use the ID the store assigns.
- **Local/unpacked:** load the unpacked extension once, copy its ID from
  `chrome://extensions`, then pin it by adding your extension's `key` to
  `manifest.json` (see Chrome docs: "Keep a consistent extension ID").

## 2. Create the OAuth client

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:** configure it, and add your
   Google account under **Test users** (fine while the app is unverified).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Chrome App** *(this is the correct type for MV3
     extensions using `getAuthToken`)*.
   - Application ID: paste your **extension ID** from step 1.
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

## Notes

- Auto-backup only runs while connected.
- Only one backup file (`claude-highlights-backup.json`) is kept; each backup
  overwrites it with the full current state.
- Restore **replaces** local data with the Drive copy — export first
  (popup → Export JSON) if you want a local snapshot beforehand.
