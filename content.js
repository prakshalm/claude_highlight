// Claude Highlighter — content script
// Adds highlight + note functionality to claude.ai chat pages and persists them via chrome.storage.

(() => {
  // Guard against re-injection. The popup re-injects via chrome.scripting on
  // every icon click for non-default sites; without this guard the IIFE would
  // re-bind every listener, duplicating toolbars and save calls.
  if (window.__claudeHighlighterLoaded) return;
  window.__claudeHighlighterLoaded = true;

  const STORAGE_KEY = "claude_highlights_v1";
  const COLORS = [
    "rgba(255, 235, 59, 1)",    // yellow
    "rgba(34, 197, 94, 1)",     // green
    "rgba(59, 130, 246, 1)",    // blue
    "rgba(236, 72, 153, 1)",    // pink
    "rgba(249, 115, 22, 1)",    // orange
  ];
  const DEFAULT_ALPHA = 1.0;
  const TEXT_COLORS = [
    "#000000", // black
    "#374151", // dark gray
    "#dc2626", // red
    "#1d4ed8", // blue
    "#15803d", // green
    "#ffffff", // white
  ];
  const DEFAULT_TEXT_COLOR = "#000000";

  // --- Utilities --------------------------------------------------------------

  // Derive a stable storage key for the current page.
  //   claude.ai/chat/<uuid>        -> "<uuid>"        (preserves existing data)
  //   chatgpt.com/c/<uuid>         -> "chatgpt:<uuid>"
  //   chat.openai.com/c/<uuid>     -> "chatgpt:<uuid>"
  //   any other site               -> "url:<origin><pathname>"
  //   chat root with no chat open  -> null
  function getConversationId() {
    const host = location.hostname;
    if (host === "claude.ai") {
      const m = location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    }
    if (host === "chatgpt.com" || host === "chat.openai.com") {
      const m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
      return m ? "chatgpt:" + m[1] : null;
    }
    return "url:" + location.origin + location.pathname;
  }

  function genId() {
    return "h_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  // Find the main chat content container. Falls back through several selectors
  // since Claude's DOM may change. Picks the largest match by text length.
  function findChatContainer() {
    const candidates = [
      'main [class*="conversation"]',
      "main",
      '[role="main"]',
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      let best = null;
      for (const el of els) {
        if (!best || el.textContent.length > best.textContent.length) best = el;
      }
      if (best && best.textContent.length > 100) return best;
    }
    return document.body;
  }

  // Get all text nodes inside a range, splitting partial nodes if needed.
  function getTextNodesInRange(range) {
    const result = [];
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent || !node.textContent.length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      let start = 0;
      let end = n.textContent.length;
      if (n === range.startContainer) start = range.startOffset;
      if (n === range.endContainer) end = range.endOffset;
      if (end > start) result.push({ node: n, start, end });
    }
    return result;
  }

  // Wrap the given range in <span class="claude-hl"> spans (one per text node fragment).
  function wrapRange(range, id, color, textColor) {
    const parts = getTextNodesInRange(range);
    for (const { node, start, end } of parts) {
      const text = node.textContent;
      const before = text.slice(0, start);
      const middle = text.slice(start, end);
      const after = text.slice(end);
      const span = document.createElement("span");
      span.className = "claude-hl";
      span.dataset.hlId = id;
      span.style.backgroundColor = color;
      span.style.color = textColor || DEFAULT_TEXT_COLOR;
      span.textContent = middle;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(span);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // Update background / text colors of all spans belonging to a highlight.
  function applyColors(id, color, textColor) {
    document.querySelectorAll(`.claude-hl[data-hl-id="${id}"]`).forEach((el) => {
      if (color) el.style.backgroundColor = color;
      if (textColor) el.style.color = textColor;
    });
  }

  // Compute the character offset of a (node, offset) inside a container's textContent.
  function getCharOffsetInContainer(container, node, offset) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let total = 0;
    let cur;
    while ((cur = walker.nextNode())) {
      if (cur === node) return total + offset;
      total += cur.textContent.length;
    }
    return -1;
  }

  // Given a container and a global char offset, return {node, offset}.
  function getNodeAtOffset(container, charOffset) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let total = 0;
    let cur;
    while ((cur = walker.nextNode())) {
      const len = cur.textContent.length;
      if (charOffset <= total + len) return { node: cur, offset: charOffset - total };
      total += len;
    }
    return null;
  }

  // Build a Range for the Nth occurrence of `text` inside container that matches context.
  function locateRange(container, text, contextBefore, contextAfter, occurrence) {
    if (!text) return null;
    const full = container.textContent;
    if (!full) return null;
    // First try to match using context for disambiguation.
    const needle = (contextBefore || "") + text + (contextAfter || "");
    let pos = -1;
    if (needle !== text) {
      pos = full.indexOf(needle);
      if (pos !== -1) pos = pos + (contextBefore || "").length;
    }
    if (pos === -1) {
      // Fall back to Nth occurrence of bare text.
      let from = -1;
      for (let i = 0; i <= occurrence; i++) {
        from = full.indexOf(text, from + 1);
        if (from === -1) break;
      }
      pos = from;
    }
    if (pos === -1) return null;
    const start = getNodeAtOffset(container, pos);
    const end = getNodeAtOffset(container, pos + text.length);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch (e) {
      return null;
    }
    return range;
  }

  // --- Storage ----------------------------------------------------------------

  let contextValid = true;
  let _mo = null;

  function isContextValid() {
    if (!contextValid) return false;
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
        teardown();
        return false;
      }
      return true;
    } catch (_) {
      teardown();
      return false;
    }
  }

  // Stop everything when the extension context has been invalidated (e.g., user
  // reloaded the extension in chrome://extensions while this tab was open).
  function teardown() {
    if (!contextValid) return;
    contextValid = false;
    try { _mo && _mo.disconnect(); } catch (_) {}
    try { window.removeEventListener("scroll", schedulePositionMarkers, true); } catch (_) {}
    try { window.removeEventListener("resize", schedulePositionMarkers); } catch (_) {}
    hideToolbar();
    closeNotePopup();
    closeSearchPanel();
    const g = document.getElementById("claude-hl-gutter");
    if (g) g.remove();
    console.info("[Claude Highlighter] Extension context invalidated — disabling. Refresh the page after reloading the extension.");
  }

  async function loadAll() {
    if (!isContextValid()) return {};
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          if (chrome.runtime.lastError) {
            teardown();
            return resolve({});
          }
          resolve(res[STORAGE_KEY] || {});
        });
      } catch (_) {
        teardown();
        resolve({});
      }
    });
  }

  async function saveAll(data) {
    if (!isContextValid()) return;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
          if (chrome.runtime.lastError) teardown();
          resolve();
        });
      } catch (_) {
        teardown();
        resolve();
      }
    });
  }

  async function getHighlightsForConv(convId) {
    const all = await loadAll();
    return all[convId] || [];
  }

  async function saveHighlight(convId, highlight) {
    const all = await loadAll();
    if (!all[convId]) all[convId] = [];
    const idx = all[convId].findIndex((h) => h.id === highlight.id);
    if (idx === -1) all[convId].push(highlight);
    else all[convId][idx] = highlight;
    await saveAll(all);
  }

  async function deleteHighlightFromStorage(convId, id) {
    const all = await loadAll();
    if (!all[convId]) return;
    all[convId] = all[convId].filter((h) => h.id !== id);
    if (all[convId].length === 0) delete all[convId];
    await saveAll(all);
  }

  // Apply note state (tooltip + has-note flag) to all spans of a highlight.
  function applyNoteState(id, note) {
    const spans = document.querySelectorAll(`.claude-hl[data-hl-id="${id}"]`);
    const hasNote = !!(note && note.trim());
    spans.forEach((el) => {
      if (hasNote) {
        el.dataset.hasNote = "true";
        el.title = note;
      } else {
        delete el.dataset.hasNote;
        el.removeAttribute("title");
      }
    });
    schedulePositionMarkers();
  }

  // --- Right-side gutter: comment-style markers for highlights with notes ---

  function ensureGutter() {
    let g = document.getElementById("claude-hl-gutter");
    if (!g) {
      g = document.createElement("div");
      g.id = "claude-hl-gutter";
      document.body.appendChild(g);
    }
    return g;
  }

  function positionMarkers() {
    const gutter = ensureGutter();
    const chat = findChatContainer();
    const chatRect = chat && chat.getBoundingClientRect();
    // x position: just outside the chat container's right edge, but always at
    // least RIGHT_GAP clear of the inner viewport edge (clientWidth excludes
    // the scrollbar, so RIGHT_GAP is pure breathing room past it).
    const MARKER_W = 32;
    const RIGHT_GAP = 40;
    const viewportW = document.documentElement.clientWidth || window.innerWidth;
    const maxX = viewportW - MARKER_W - RIGHT_GAP;
    let markerX = maxX;
    if (chatRect) {
      markerX = Math.min(maxX, chatRect.right + 6);
      markerX = Math.max(8, markerX);
    }

    const seen = new Set();
    document.querySelectorAll('.claude-hl[data-has-note="true"]').forEach((span) => {
      const id = span.dataset.hlId;
      if (seen.has(id)) return; // one marker per highlight
      seen.add(id);

      const rect = span.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      let marker = gutter.querySelector(`[data-marker-id="${id}"]`);
      if (!marker) {
        marker = document.createElement("button");
        marker.className = "claude-hl-marker";
        marker.dataset.markerId = id;
        marker.title = span.title || "View note";
        marker.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteById(id, marker);
        });
        gutter.appendChild(marker);
      } else {
        marker.title = span.title || "View note";
      }
      marker.style.left = markerX + "px";
      marker.style.top = Math.max(4, rect.top + rect.height / 2 - 16) + "px";
    });

    // Remove markers whose highlights no longer have notes / are gone.
    gutter.querySelectorAll(".claude-hl-marker").forEach((m) => {
      if (!seen.has(m.dataset.markerId)) m.remove();
    });
  }

  let _markerRaf = 0;
  function schedulePositionMarkers() {
    if (_markerRaf) return;
    _markerRaf = requestAnimationFrame(() => {
      _markerRaf = 0;
      try {
        positionMarkers();
      } catch (e) {
        // ignore
      }
    });
  }

  window.addEventListener("scroll", schedulePositionMarkers, true);
  window.addEventListener("resize", schedulePositionMarkers);

  async function openNoteById(id, anchor) {
    const convId = getConversationId();
    if (!convId) return;
    const highlights = await getHighlightsForConv(convId);
    const hl = highlights.find((h) => h.id === id);
    if (!hl) return;
    // Prefer the explicit anchor (e.g. the gutter marker), else fall back to the
    // highlight span in the document.
    const anchorEl =
      anchor ||
      document.querySelector(`.claude-hl-marker[data-marker-id="${id}"]`) ||
      document.querySelector(`.claude-hl[data-hl-id="${id}"]`);
    if (anchorEl) openNotePopup(hl, anchorEl);
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex).match(/^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
    if (!m) return hex;
    const r = parseInt(m[1], 16),
      g = parseInt(m[2], 16),
      b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Replace the alpha of an rgb/rgba/hex color string.
  function setAlpha(color, alpha) {
    if (typeof color !== "string") return color;
    let m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
    m = color.match(/^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
    if (m) {
      const r = parseInt(m[1], 16),
        g = parseInt(m[2], 16),
        b = parseInt(m[3], 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color;
  }

  // Read the alpha from an rgba color string. rgb/hex are treated as fully opaque.
  function getAlpha(color) {
    if (typeof color !== "string") return DEFAULT_ALPHA;
    const m = color.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/i);
    if (m) return parseFloat(m[1]);
    return 1.0;
  }

  // --- UI: floating toolbar on selection -------------------------------------

  let toolbarEl = null;
  let currentRange = null;

  function hideToolbar() {
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
    currentRange = null;
  }

  function showToolbar(range) {
    hideToolbar();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const tb = document.createElement("div");
    tb.className = "claude-hl-toolbar";
    tb.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection

    for (const c of COLORS) {
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.style.background = `linear-gradient(${c}, ${c}), white`;
      sw.title = "Highlight";
      sw.addEventListener("click", () => createHighlight(c, false));
      tb.appendChild(sw);
    }

    const sep = document.createElement("div");
    sep.className = "sep";
    tb.appendChild(sep);

    const noteBtn = document.createElement("button");
    noteBtn.textContent = "Add note";
    noteBtn.addEventListener("click", () => createHighlight(COLORS[0], true));
    tb.appendChild(noteBtn);

    document.body.appendChild(tb);
    
    // Position toolbar below the selection
    const toolbarHeight = tb.offsetHeight;
    const toolbarWidth = tb.offsetWidth;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    
    // Position below selection, centered horizontally
    let top = scrollY + rect.bottom + 8;
    let left = scrollX + rect.left + rect.width / 2 - toolbarWidth / 2;
    
    // Clamp to viewport bounds
    top = Math.min(top, scrollY + viewportHeight - toolbarHeight - 8);
    left = Math.max(4, Math.min(left, scrollX + viewportWidth - toolbarWidth - 8));
    
    tb.style.top = top + "px";
    tb.style.left = left + "px";

    toolbarEl = tb;
    currentRange = range.cloneRange();
  }

  // --- Selection handling ----------------------------------------------------

  // Check if a node is inside an input area (textarea, input, contenteditable, etc.)
  function isNodeInInputArea(node) {
    if (!node) return false;
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!el.closest(
      '[contenteditable="true"], textarea, input, [data-testid*="input"], [role="textbox"], [role="combobox"]'
    );
  }

  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        hideToolbar();
        return;
      }
      const range = sel.getRangeAt(0);
      const text = sel.toString();
      if (!text.trim()) {
        hideToolbar();
        return;
      }
      // Only allow selecting within the chat container.
      const container = findChatContainer();
      if (!container.contains(range.commonAncestorContainer)) {
        hideToolbar();
        return;
      }
      // Don't show toolbar when selecting inside an input area.
      if (isNodeInInputArea(range.startContainer) || isNodeInInputArea(range.endContainer)) {
        hideToolbar();
        return;
      }
      // Avoid showing the toolbar when the selection is already inside our own UI.
      if (
        (range.startContainer.parentElement &&
          range.startContainer.parentElement.closest(".claude-hl-toolbar, .claude-hl-note")) ||
        (range.endContainer.parentElement &&
          range.endContainer.parentElement.closest(".claude-hl-toolbar, .claude-hl-note"))
      ) {
        return;
      }
      showToolbar(range);
    }, 50);
  });

  document.addEventListener("mousedown", (e) => {
    if (toolbarEl && !toolbarEl.contains(e.target)) {
      hideToolbar();
    }
  });

  // --- Create / restore highlights -------------------------------------------

  function createHighlight(color, openNote) {
    if (!currentRange) return;
    const convId = getConversationId();
    if (!convId) {
      alert("Open a specific chat to save highlights.");
      return;
    }

    const container = findChatContainer();
    const text = currentRange.toString();
    if (!text.trim()) return;

    const startOff = getCharOffsetInContainer(container, currentRange.startContainer, currentRange.startOffset);
    const fullText = container.textContent;
    const contextLen = 25;
    const contextBefore = startOff > 0 ? fullText.slice(Math.max(0, startOff - contextLen), startOff) : "";
    const contextAfter = fullText.slice(startOff + text.length, startOff + text.length + contextLen);

    // Compute occurrence index of `text` among matches up to and including this one.
    let occurrence = 0;
    let from = -1;
    while (true) {
      from = fullText.indexOf(text, from + 1);
      if (from === -1 || from >= startOff) break;
      occurrence++;
    }

    const id = genId();
    const hl = {
      id,
      convId,
      text,
      color,
      textColor: DEFAULT_TEXT_COLOR,
      note: "",
      contextBefore,
      contextAfter,
      occurrence,
      createdAt: new Date().toISOString(),
      url: location.href,
      host: location.hostname,
      title: document.title || "",
    };

    wrapRange(currentRange, id, color, hl.textColor);
    saveHighlight(convId, hl);

    // Clear selection and toolbar.
    window.getSelection().removeAllRanges();
    hideToolbar();

    if (openNote) {
      // Open the note popup on the freshly created span.
      const span = document.querySelector(`.claude-hl[data-hl-id="${id}"]`);
      if (span) openNotePopup(hl, span);
    }
  }

  async function restoreHighlights() {
    const convId = getConversationId();
    if (!convId) return;
    const highlights = await getHighlightsForConv(convId);
    if (!highlights.length) return;
    const container = findChatContainer();
    if (!container) return;

    for (const hl of highlights) {
      // Skip if already applied.
      if (document.querySelector(`.claude-hl[data-hl-id="${hl.id}"]`)) continue;
      const range = locateRange(container, hl.text, hl.contextBefore, hl.contextAfter, hl.occurrence || 0);
      if (!range) continue;
      try {
        wrapRange(range, hl.id, hl.color || COLORS[0], hl.textColor || DEFAULT_TEXT_COLOR);
        applyNoteState(hl.id, hl.note);
      } catch (e) {
        // ignore — DOM may still be settling
      }
    }
    schedulePositionMarkers();
  }

  // --- Note popup ------------------------------------------------------------

  let noteEl = null;

  function closeNotePopup() {
    if (noteEl) {
      noteEl.remove();
      noteEl = null;
    }
  }

  async function openNotePopup(highlight, anchorEl) {
    closeNotePopup();
    const rect = anchorEl.getBoundingClientRect();

    const wrap = document.createElement("div");
    wrap.className = "claude-hl-note";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());

    const quote = document.createElement("div");
    quote.className = "quote";
    quote.textContent = highlight.text.length > 220 ? highlight.text.slice(0, 220) + "…" : highlight.text;
    wrap.appendChild(quote);

    // Helper that builds a labeled row of color swatches + a custom-picker swatch.
    const buildColorRow = (labelText, palette, currentValue, onPick, swatchBg, customToColor) => {
      const row = document.createElement("div");
      row.className = "color-row";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = labelText;
      row.appendChild(label);
      const swatches = document.createElement("div");
      swatches.className = "swatches";

      const clearActive = () =>
        swatches.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));

      for (const c of palette) {
        const sw = document.createElement("button");
        sw.className = "swatch";
        sw.style.background = swatchBg(c);
        sw.title = c;
        if (c === currentValue) sw.classList.add("active");
        sw.addEventListener("click", async () => {
          clearActive();
          sw.classList.add("active");
          await onPick(c);
        });
        swatches.appendChild(sw);
      }

      // Custom color picker (full palette via native input[type=color]).
      const custom = document.createElement("button");
      custom.type = "button";
      custom.className = "swatch custom";
      custom.title = "Pick a custom color";
      const input = document.createElement("input");
      input.type = "color";
      // Seed picker with the current value's hex (or a fallback).
      const hexSeed = /^#[0-9a-f]{6}$/i.test(currentValue) ? currentValue : "#ffeb3b";
      input.value = hexSeed;
      custom.appendChild(input);
      // If the current value isn't in the preset palette, mark custom as active.
      if (!palette.includes(currentValue)) custom.classList.add("active");
      input.addEventListener("input", async (e) => {
        const hex = e.target.value;
        const final = customToColor ? customToColor(hex) : hex;
        clearActive();
        custom.classList.add("active");
        await onPick(final);
      });
      swatches.appendChild(custom);

      row.appendChild(swatches);
      return row;
    };

    // Brightness slider — placed after the color rows. Adjusts the alpha of the
    // highlight background in real time. References are captured here so the
    // color-pick handlers below can re-sync the slider when a new color is chosen.
    let brightnessSlider = null;
    let brightnessLabel = null;

    wrap.appendChild(
      buildColorRow(
        "Highlight",
        COLORS,
        highlight.color,
        async (c) => {
          // Preserve current brightness when switching highlight color.
          const alpha = brightnessSlider ? parseFloat(brightnessSlider.value) : getAlpha(c);
          highlight.color = setAlpha(c, alpha);
          await saveHighlight(highlight.convId, highlight);
          applyColors(highlight.id, highlight.color, null);
        },
        (c) => `linear-gradient(${c}, ${c}), white`,
        (hex) => {
          const alpha = brightnessSlider ? parseFloat(brightnessSlider.value) : DEFAULT_ALPHA;
          return hexToRgba(hex, alpha);
        },
      ),
    );
    wrap.appendChild(
      buildColorRow(
        "Text",
        TEXT_COLORS,
        highlight.textColor || DEFAULT_TEXT_COLOR,
        async (c) => {
          highlight.textColor = c;
          await saveHighlight(highlight.convId, highlight);
          applyColors(highlight.id, null, c);
        },
        (c) => c,
        (hex) => hex,
      ),
    );

    const brightnessRow = document.createElement("div");
    brightnessRow.className = "brightness-row";
    const bLabel = document.createElement("div");
    bLabel.className = "label";
    bLabel.textContent = "Brightness";
    brightnessRow.appendChild(bLabel);
    brightnessSlider = document.createElement("input");
    brightnessSlider.type = "range";
    brightnessSlider.min = "0.15";
    brightnessSlider.max = "1";
    brightnessSlider.step = "0.05";
    brightnessSlider.value = String(getAlpha(highlight.color));
    brightnessRow.appendChild(brightnessSlider);
    brightnessLabel = document.createElement("span");
    brightnessLabel.className = "brightness-value";
    brightnessLabel.textContent = Math.round(parseFloat(brightnessSlider.value) * 100) + "%";
    brightnessRow.appendChild(brightnessLabel);

    brightnessSlider.addEventListener("input", () => {
      const a = parseFloat(brightnessSlider.value);
      brightnessLabel.textContent = Math.round(a * 100) + "%";
      highlight.color = setAlpha(highlight.color, a);
      applyColors(highlight.id, highlight.color, null);
    });
    // Persist on release rather than every tick to avoid storage thrash.
    brightnessSlider.addEventListener("change", async () => {
      await saveHighlight(highlight.convId, highlight);
    });

    wrap.appendChild(brightnessRow);

    const ta = document.createElement("textarea");
    ta.placeholder = "Write a note about this highlight…";
    ta.value = highlight.note || "";
    wrap.appendChild(ta);

    const actions = document.createElement("div");
    actions.className = "actions";

    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await deleteHighlightFromStorage(highlight.convId, highlight.id);
      document.querySelectorAll(`.claude-hl[data-hl-id="${highlight.id}"]`).forEach((el) => {
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
      });
      schedulePositionMarkers();
      closeNotePopup();
    });

    const right = document.createElement("div");
    right.className = "right";

    const cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeNotePopup);

    const save = document.createElement("button");
    save.className = "save";
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      highlight.note = ta.value.trim();
      await saveHighlight(highlight.convId, highlight);
      applyNoteState(highlight.id, highlight.note);
      closeNotePopup();
    });

    right.appendChild(cancel);
    right.appendChild(save);
    actions.appendChild(del);
    actions.appendChild(right);
    wrap.appendChild(actions);

    document.body.appendChild(wrap);

    // Position the popup. When the anchor is a gutter marker, float it next to
    // the marker like a hover tooltip (preferred side: left of the marker, since
    // markers sit on the right edge of the chat). Otherwise, anchor it under the
    // highlighted text as before.
    const w = wrap.offsetWidth || 320;
    const h = wrap.offsetHeight || 220;
    const isMarker = anchorEl.classList && anchorEl.classList.contains("claude-hl-marker");

    // Extra right-edge padding so the popup never sits flush against the
    // scrollbar (typical scrollbar width ~15-17px; this leaves a clear gap).
    const RIGHT_PAD = 28;
    let top, left;
    if (isMarker) {
      const gap = 8;
      left = window.scrollX + rect.left - w - gap;
      top = window.scrollY + rect.top + rect.height / 2 - h / 2;
      // If there's no room on the left of the marker, place above the marker.
      if (left < window.scrollX + 8) {
        left = window.scrollX + rect.left + rect.width / 2 - w / 2;
        top = window.scrollY + rect.top - h - gap;
      }
      // Clamp to viewport.
      left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + window.innerWidth - w - RIGHT_PAD));
      top = Math.max(window.scrollY + 8, Math.min(top, window.scrollY + window.innerHeight - h - 8));
    } else {
      top = window.scrollY + rect.bottom + 6;
      left = window.scrollX + rect.left;
      if (left + w > window.scrollX + window.innerWidth - RIGHT_PAD) {
        left = window.scrollX + window.innerWidth - w - RIGHT_PAD;
      }
      left = Math.max(8, left);
    }
    wrap.style.top = top + "px";
    wrap.style.left = left + "px";

    noteEl = wrap;
    setTimeout(() => ta.focus(), 0);
  }

  // Click on existing highlight to open note popup.
  document.addEventListener("click", async (e) => {
    const span = e.target.closest && e.target.closest(".claude-hl");
    if (!span) {
      // Click outside any note popup closes it.
      if (noteEl && !noteEl.contains(e.target)) closeNotePopup();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = span.dataset.hlId;
    const convId = getConversationId();
    if (!convId) return;
    const highlights = await getHighlightsForConv(convId);
    const hl = highlights.find((h) => h.id === id);
    if (hl) openNotePopup(hl, span);
  });

  // --- Listen to popup messages (jump to highlight) --------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "scrollToHighlight" && msg.id) {
      const span = document.querySelector(`.claude-hl[data-hl-id="${msg.id}"]`);
      if (span) {
        span.scrollIntoView({ behavior: "smooth", block: "center" });
        const orig = span.style.boxShadow;
        span.style.boxShadow = "0 0 0 3px #f59e0b";
        setTimeout(() => (span.style.boxShadow = orig), 1500);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false });
    }
  });

  // --- In-page search panel (Alt+H) ------------------------------------------

  let searchPanelEl = null;
  let searchItems = [];
  let searchIndex = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function closeSearchPanel() {
    if (searchPanelEl) {
      searchPanelEl.remove();
      searchPanelEl = null;
    }
    searchItems = [];
    searchIndex = 0;
  }

  function jumpToHighlight(id, andClose) {
    const span = document.querySelector(`.claude-hl[data-hl-id="${id}"]`);
    if (span) {
      span.scrollIntoView({ behavior: "smooth", block: "center" });
      const orig = span.style.boxShadow;
      span.style.boxShadow = "0 0 0 3px #f59e0b";
      setTimeout(() => (span.style.boxShadow = orig), 1500);
    }
    if (andClose) closeSearchPanel();
  }

  async function openSearchPanel() {
    const convId = getConversationId();
    if (!convId) {
      alert("Claude Highlighter: open a chat to search highlights.");
      return;
    }
    closeSearchPanel();

    const all = await getHighlightsForConv(convId);

    const panel = document.createElement("div");
    panel.className = "claude-hl-search";
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    const input = document.createElement("input");
    input.className = "search-input";
    input.placeholder = "Search highlights & notes…   (↑/↓ navigate, Enter jump, Esc close)";
    panel.appendChild(input);

    const list = document.createElement("div");
    list.className = "search-list";
    panel.appendChild(list);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = `${all.length} highlight${all.length === 1 ? "" : "s"} in this chat`;
    panel.appendChild(hint);

    document.body.appendChild(panel);
    searchPanelEl = panel;

    const render = () => {
      const q = input.value.trim().toLowerCase();
      searchItems = q
        ? all.filter(
            (h) =>
              (h.text || "").toLowerCase().includes(q) ||
              (h.note || "").toLowerCase().includes(q),
          )
        : all.slice();
      if (searchIndex >= searchItems.length) searchIndex = Math.max(0, searchItems.length - 1);

      list.innerHTML = "";
      if (!searchItems.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = q ? "No matches" : "No highlights yet — select text in a Claude reply to create one.";
        list.appendChild(empty);
        return;
      }
      searchItems.forEach((h, i) => {
        const item = document.createElement("div");
        item.className = "item" + (i === searchIndex ? " active" : "");
        const textDiv = document.createElement("div");
        textDiv.className = "text";
        const inner = document.createElement("span");
        inner.style.background = h.color || "rgba(255, 235, 59, 0.45)";
        inner.style.color = h.textColor || "#000";
        inner.textContent = h.text;
        textDiv.appendChild(inner);
        item.appendChild(textDiv);
        if (h.note) {
          const noteDiv = document.createElement("div");
          noteDiv.className = "note";
          noteDiv.textContent = h.note;
          item.appendChild(noteDiv);
        }
        item.addEventListener("click", () => jumpToHighlight(h.id, true));
        item.addEventListener("mouseenter", () => {
          searchIndex = i;
          list.querySelectorAll(".item").forEach((el, idx) =>
            el.classList.toggle("active", idx === searchIndex),
          );
        });
        list.appendChild(item);
      });
      // Make sure the active item is visible.
      const active = list.querySelector(".item.active");
      if (active) active.scrollIntoView({ block: "nearest" });
    };

    render();
    setTimeout(() => input.focus(), 0);

    input.addEventListener("input", () => {
      searchIndex = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (searchItems.length) {
          searchIndex = (searchIndex + 1) % searchItems.length;
          render();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (searchItems.length) {
          searchIndex = (searchIndex - 1 + searchItems.length) % searchItems.length;
          render();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const h = searchItems[searchIndex];
        if (h) jumpToHighlight(h.id, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchPanel();
      }
    });
  }

  // Close panel on outside click.
  document.addEventListener("mousedown", (e) => {
    if (searchPanelEl && !searchPanelEl.contains(e.target)) closeSearchPanel();
  });

  // Alt+H toggles the search panel. Capture phase so we beat page handlers,
  // and we match on KeyCode so Mac Option+H (which inserts ˙) is suppressed.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyH") {
        e.preventDefault();
        e.stopPropagation();
        if (searchPanelEl) closeSearchPanel();
        else openSearchPanel();
      } else if (e.key === "Escape" && searchPanelEl) {
        e.preventDefault();
        closeSearchPanel();
      }
    },
    true,
  );

  // --- SPA / mutation handling -----------------------------------------------

  let currentConvId = getConversationId();
  let restoreScheduled = false;

  function scheduleRestore(delay = 200) {
    if (restoreScheduled) return;
    restoreScheduled = true;
    setTimeout(() => {
      restoreScheduled = false;
      restoreHighlights().catch(() => {});
    }, delay);
  }

  _mo = new MutationObserver(() => {
    if (!isContextValid()) return;
    const newId = getConversationId();
    if (newId !== currentConvId) {
      currentConvId = newId;
      hideToolbar();
      closeNotePopup();
      closeSearchPanel();
    }
    scheduleRestore(300);
  });
  _mo.observe(document.body, { childList: true, subtree: true });

  // Initial restore once the page is idle.
  scheduleRestore(600);
})();
