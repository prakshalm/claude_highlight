# Web Highlighter

A Chrome extension that lets you highlight text on any web page, attach notes to
highlights, and have everything persist across reloads. It's **always on** for
Claude (claude.ai) and ChatGPT (chatgpt.com); for any other site, you opt-in by
clicking the extension icon and flipping the per-site toggle.

## Features

- Select any text in a Claude chat and pick a highlight color from a floating toolbar.
- Click an existing highlight to write/edit a note.
- Highlights and notes are stored per-conversation in `chrome.storage.local`, so they
  reappear when you reload the page or come back to a chat later.
- Extension popup shows all highlights across all chats, grouped by conversation, with
  search, click-to-jump, individual delete, JSON export, and clear-all.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome or any Chromium browser.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and choose this folder (`claude_highlighter`).
4. Open <https://claude.ai/> and start a chat. Select any text in Claude's reply and
   the toolbar will appear.

## Usage

- **Highlight**: select text → click a color swatch in the floating toolbar.
- **Add note**: select text → click *Add note*, or click an existing highlight.
- **Edit/delete a note**: click the highlighted text or the right-side amber comment
  marker that appears next to highlights with notes.
- **Change colors**: open a highlight's note popup — pick from the preset swatches or
  click the rainbow swatch for a full color picker.
- **Search & jump (in-page)**: press **Alt+H** to open the search panel. Type to
  filter highlights/notes in the current chat, use ↑/↓ to navigate, press Enter
  to scroll to the highlight, Esc to close.
- **View all**: click the extension icon in the toolbar to open the popup.
- **Jump to a highlight**: click any item in the popup list; it will open/focus the
  chat and scroll the highlight into view.

## After reloading the extension

If you reload the extension at `chrome://extensions` while a Claude tab is already
open, the old content script's storage handle is invalidated by Chrome. The
extension detects this, stops trying, and logs a notice — just refresh the Claude
tab to re-enable highlighting.

## Notes / limitations

- Restoration matches highlights by exact text + surrounding context. If Claude's
  message text changes (e.g., you regenerate a response), an old highlight may not
  re-attach.
- Works only on `https://claude.ai/*`.
- Storage uses `chrome.storage.local`; export to JSON from the popup if you want a
  backup.
