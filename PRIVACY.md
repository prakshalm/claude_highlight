# Privacy Policy — Claude Highlighter

_Last updated: 2026-05-26_

Claude Highlighter ("the extension") is a browser extension that lets users
highlight Claude's responses on claude.ai, attach notes to those highlights,
and have both persist across page reloads.

This policy explains what the extension does — and does not do — with your
data.

## What the extension stores

When you create a highlight or write a note, the extension saves the following
locally on your device using the browser's built-in `chrome.storage` API:

- The text you highlighted.
- The position of the highlight within the Claude conversation.
- The highlight color you chose.
- Any note text you typed for that highlight.
- The URL of the Claude conversation the highlight belongs to, so the
  highlight can be re-rendered the next time you open that conversation.

That is the complete list of data the extension stores.

## What the extension does NOT do

- **No data leaves your device.** The extension does not send your
  highlights, notes, conversation contents, or any other information to any
  server operated by the developer or to any third party.
- **No analytics, no tracking, no telemetry.** The extension does not
  measure your usage, record events, or report anything back.
- **No advertising.** The extension does not show ads and does not share
  data with advertisers.
- **No accounts.** The extension does not require you to sign in or create
  an account.
- **No remote code.** All code that runs in the extension is bundled inside
  the extension package. The extension does not download or execute scripts
  from external sources at runtime.
- **No access to other websites.** The extension only runs on
  `https://claude.ai/*`. It does not read or modify any other site.

## Where your data lives

Your highlights and notes are stored only in your browser's local extension
storage. If you uninstall the extension or clear its storage, that data is
removed. If you use Chrome Sync and have extension data sync enabled in
Chrome, Chrome itself may sync the data across your signed-in browsers — that
sync is handled by Chrome, not by this extension.

## Sharing and selling

The developer does not sell, rent, lease, or transfer your data to anyone,
because the developer never receives your data in the first place.

## Permissions used

- `storage` — to save your highlights and notes locally so they persist
  across page reloads.
- Host permission for `https://claude.ai/*` — so the extension's content
  script can run on Claude conversation pages and render your highlights
  and notes there.

## Children

The extension is not directed to children under 13 and does not knowingly
collect data from them. It does not collect personally identifiable
information from anyone.

## Changes to this policy

If this policy changes in a meaningful way, the "Last updated" date at the
top of this document will change and the new version will be published at
the same URL.

## Contact

Questions about this policy? Email: prakshalm99@gmail.com
