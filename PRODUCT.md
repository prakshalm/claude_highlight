# Product

## Register

product

## Users

People who spend a lot of time in AI chat tools (Claude, ChatGPT, and other
sites) and treat those conversations as reference material. They highlight
passages, attach notes, and come back later. Context: a browser side-panel /
popup opened in passing while mid-task in a chat — glanced at, acted on, and
dismissed in a few seconds. Often power users comfortable in developer tools.

## Product Purpose

A Chrome extension that lets users highlight AI responses, attach notes, and
have them persist per-conversation across reloads — plus back everything up to
Google Drive for recovery. The popup is the control surface: it lists every
highlight grouped by conversation, with search, jump-to, export/import, and the
Drive backup controls. Success is the popup disappearing into the task: the user
finds a highlight, jumps to it, or confirms a backup and moves on without
friction.

## Brand Personality

Quiet, precise, trustworthy. Three words: focused, dependable, unobtrusive. It
lives beside a serious workflow and should feel like a native part of the
browser, not a promotional surface. The one spark of identity is the
highlighter itself — a warm amber that stands for "marked, saved, safe."

## Anti-references

- Not a marketing surface: no hero, no gradients, no decorative flourish.
- Not a toy: avoid playful rounded cartoon styling, emoji-as-UI, rainbow chrome.
- Not generic SaaS-purple Material boilerplate: the accent is the amber
  highlighter, not the default M3 violet.

## Design Principles

- **The tool disappears.** Earned familiarity over novelty; standard affordances
  for standard tasks.
- **The highlight is the hero.** Amber accent carries brand and state; everything
  else is neutral scaffolding.
- **Glanceable status.** Site activation and Drive sync state must be readable in
  under a second.
- **Safe by default.** Destructive actions (clear, restore) confirm; backup state
  is always visible so the user trusts their data is safe.

## Accessibility & Inclusion

Target WCAG 2.1 AA: body text ≥4.5:1, large/UI text ≥3:1, visible keyboard focus
on every control. Full light + dark support via `prefers-color-scheme`. Honor
`prefers-reduced-motion`. Highlight color must never be the sole signal (notes
carry text, markers carry icons).
