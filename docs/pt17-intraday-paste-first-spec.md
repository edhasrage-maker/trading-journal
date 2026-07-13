# Pt 17 · Item 1 — Intraday paste-first surface (SPEC, awaiting approval)

**Source:** alpha-readiness doc item (P2 "promote the differentiator") + Cut-list ("Manual
trade entry → behind an 'Add manually' link") + mockup 03 ("Intraday — the paste-a-screenshot
magic moment, made primary"). Landing page already advertises it (Pt 15: *"Paste your chart.
We read the trade."*) — this closes the promise/product gap.

**Files:** `src/components/intraday/IntradayClient.tsx` (layout), `src/components/intraday/TradeForm.tsx`
(auto-extract-on-mount). No API or schema changes — `/api/extract-trade` and the `pastedFile →
initialFile → TradeForm` plumbing already exist.

---

## 1. The gap today

- The page LEADS with: header → summary bar → chart → **trade list** → session journal → a big
  dashed **"Log Trade"** button (opens the full manual `TradeForm`).
- Paste is a **background** document-level listener (`handlePaste`, ~L318): Ctrl+V an image →
  sets `pastedFile` + `mode:'add'` → `TradeForm` mounts with `initialFile`, shows the screenshot…
  **but the user must still manually click "Read Screenshot"** to extract. The magic moment is
  buried and half-manual.
- Nothing on the page tells a new trader that paste is even possible.

## 2. Target — mockup 03

A **hero dropzone is the first thing on the page** (above the trade list). Paste OR drop → the
image auto-extracts (instrument/side/entry/stop/target) → the prefilled `TradeForm` opens right
there. Manual entry becomes a quiet **"Add a trade manually"** text link. Everything else on the
page (summary, chart, trade list, merge/dedupe, journal) stays — it just moves below the hero.

### 2a. Page order (top → bottom)

1. **Header** (date switcher) — unchanged.
2. **Hero paste/drop zone** — NEW. Always visible in the `list` mode (hidden while a form is open).
   - Dashed amber border card. Copy (verbatim from mockup):
     - Title: **"Paste your chart — TapeScore reads the trade"**
     - Body: **"Ctrl + V a screenshot, or drop an image. Instrument, side, entry, stop and target
       are extracted automatically."**
   - The whole card is a drop target (`onDragOver`/`onDrop`) AND advertises the existing Ctrl+V.
     (The document-level paste listener stays as the global fallback so paste works even if focus
     isn't on the card.)
   - A visible **"Add a trade manually"** text link sits directly under the card (replaces the
     big dashed "Log Trade" button at the bottom). Clicking it opens the `TradeForm` with no file.
3. **Summary bar** (Trades / P&L / W-L / Avg MFE-MAE) — unchanged, still gated on `trades.length > 0`.
4. **Chart** (collapsible) — unchanged.
5. **Trade list** — unchanged.
6. **Add/Edit `TradeForm`** — unchanged mount points. When opened from a paste/drop, it auto-extracts
   (see §3).
7. **Session journal** — becomes a collapsed drawer (Item 5, done in the same edit).
8. Bulk-action bar / modals / lightbox — unchanged.

The old bottom **"Log Trade"** dashed button is **removed** (its role is now the hero + the manual
link).

### 2b. Empty state vs has-trades state

- **Empty day (no trades):** the hero is the visual focus — render it a bit taller / more prominent,
  with the manual link under it. No summary bar (already hidden when `trades.length === 0`). Chart
  still renders (NQ fallback) as today.
- **Has trades:** the hero stays at the top but is more compact (single-line-ish), so the trade
  list the trader came to see isn't pushed far down. Same copy, smaller padding. Trade list follows
  immediately below the summary bar + chart.

  > Implementation note: one component, a `compact` boolean = `trades.length > 0`. Not two
  > code paths.

### 2c. Paste/drop → extract → prefilled form (the magic moment)

- Drop or paste an image while in `list` mode → `setPastedFile(file)` + `setMode({type:'add'})`
  (exactly today's paste path; drop just calls the same handler).
- `TradeForm` mounts with `initialFile`. **NEW:** a one-shot `useEffect` auto-fires `readScreenshot()`
  when the form mounts with an `initialFile` (today it waits for a manual click). Guarded by a ref
  so it fires exactly once and never on edit-mode or manual-open.
  - While extracting, the existing `extracting` state already shows a "Reading…" spinner — we surface
    it prominently so the trader sees the magic happening.
  - On extract, the existing code already fills direction/symbol/entry/stop/tp1/time/qty and sets
    `suggestedTags` (the yellow accept-chips). No change to that logic.
  - Failure path unchanged: `readScreenshot` already sets a readable `error` and leaves the form open
    for manual entry — so a misread degrades to "fix the fields by hand", never a dead end.
- **Instrument badge** (mockup pin 2): the extracted `symbol` already lands in `form.symbol` and shows
  in the form's symbol field. Per-row instrument badges in the trade list are **doc item 10 (P0),
  owned by the parallel/other batch — out of scope here.** Item 1 only guarantees the extracted
  symbol is captured; it does not add the list-row badge.
- **Trust line** (mockup pin 3): add the one-liner under the extracted-values area of `TradeForm`:
  *"Read from your bracket orders — target and stop identified by P&L sign, not color."* (static text,
  shown once a screenshot is present.)

### 2d. Manual entry demoted

- The dashed full-width **"Log Trade"** button at the bottom is removed.
- Replaced by a **text link** under the hero: **"Prefer typing? Add a trade manually"** → opens the
  `TradeForm` with no `initialFile`.
- No manual-entry capability is deleted — it's the same `TradeForm`, just reached via a link instead
  of a hero button.

### 2e. Merge / dedupe UI

Unchanged. The multi-select checkboxes, floating bulk bar, and 2-trade Merge flow all live on the
**trade list**, which is untouched. Paste-created trades land in the list like any other and can be
merged with an SC-imported fill exactly as today.

### 2f. Mobile

- Hero card: full-width, comfortable tap targets. The `<kbd>Ctrl</kbd>+<kbd>V</kbd>` hint reads as
  desktop-centric, so on mobile the copy leads with **"Tap to add a screenshot"** (a tap opens the
  native file/photo picker via a hidden `<input type=file capture>`), with the paste hint secondary.
  - Simplest robust approach: the hero card is a `<label>` wrapping a hidden file input, so tap →
    picker on mobile, and drop/paste still work on desktop. One control, both platforms.
- Everything else already responsive; no new breakpoints needed.

---

## 3. Concrete change list (for the coding pass, post-approval)

**`TradeForm.tsx`**
1. Add a one-shot auto-extract effect: `useEffect` that calls `readScreenshot()` once when the form
   mounted with `initialFile` (ref-guarded; skip in edit mode).
2. Add the static trust line under the screenshot/extracted-values block.

**`IntradayClient.tsx`**
3. Add a `PasteDropZone` sub-component (hero card): drop handler → `setPastedFile`+`setMode('add')`;
   hidden file input for tap/click; the `compact` prop for the has-trades variant; the manual-entry
   link. Render it at the top of the `list`-mode layout (hidden when `isAdding`/`editingId`).
4. Remove the bottom dashed "Log Trade" button (role absorbed by hero + manual link).
5. (Item 5) Wrap the Session journal block in a collapsed-by-default `<details>`/disclosure.

No changes to: paste listener semantics, save/merge/delete handlers, chart, summary bar, bulk actions.

## 4. Risk / collision

- `IntradayClient.tsx` is uncommitted with a **4-line "Profit Captured" label rename** (Pt 11) — NOT
  the achievements feature (that WIP is in other files). My edits are additive (new sub-component +
  layout reorder) and don't touch those 4 lines, so staging is clean: `git add` the label lines and
  my hunks together, or commit the whole file since the rename is intended to ship anyway. Will
  confirm with the parallel session before committing shared files.
- `TradeForm.tsx` is **clean** (not in the uncommitted set) — safe to edit and stage by path.

## 5. Out of scope (explicit)

- Per-row instrument badge in the trade list (doc item 10, P0 — other batch).
- The One-TapeScore merge, verdict-first conditions, n= badges (other P1 items).
- Any `/api/extract-trade` prompt/behavior change — extraction logic is untouched.
