# Vocab Interestingness + Cross-Session Saved Vocab

**Date:** 2026-04-09
**Status:** Design

## Problem

The current Vocab tab lists idioms from the active session in chronological
order, which buries the interesting phrases among common ones. There is also
no way to keep a running, cross-session collection of phrases worth learning.

A user studying Italian via football commentary wants to (1) scan the Vocab
tab and see the interesting idioms first, and (2) bookmark phrases into a
persistent, cross-session collection they can browse later.

## Goals

- Each idiom carries a difficulty bucket — `common`, `intermediate`, or
  `advanced` — reflecting how likely an intermediate Italian speaker is to
  already know it.
- The current-session Vocab tab is sorted Advanced first, grouped by bucket.
- A new top-level "Saved Vocab" view in the sidebar collects saved phrases
  across every session.
- The Saved Vocab view supports search and filtering by bucket.
- Saving the same phrase from multiple sessions merges sources onto a single
  entry.
- All existing sessions are backfilled with buckets once, via a manual
  one-time script.

## Non-goals (v1)

- Inline save button on transcript-underlined idioms — deferred.
- Click-through from a saved entry back to its source session.
- Anki export, tagging, or editing of saved entries.
- Backfilling automatically on every server start.

## Design

### Data model

**Idiom schema** (one field added) — every idiom in `session.lines[].idioms[]`
gains a `bucket` field:

```js
{
  expression: "chiudere la saracinesca",
  meaning: "to shut up shop defensively",
  bucket: "advanced"  // "common" | "intermediate" | "advanced"
}
```

**New file: `sessions/saved-vocab.json`** — the cross-session collection:

```js
{
  entries: [
    {
      id: "sv_1775723456789",
      expression: "chiudere la saracinesca",
      meaning: "to shut up shop defensively",
      bucket: "advanced",
      savedAt: "2026-04-09T20:11:00.000Z",
      sources: [
        {
          sessionId: "sess_1775675460878",
          sessionName: "PSG vs Liverpool",
          lineId: 247,
          contextQuote: "...il Liverpool ha chiuso la saracinesca nel finale...",
          audioOffsetSec: 5234.1
        }
      ]
    }
  ]
}
```

**Dedupe key:** `expression.trim().toLowerCase()`. Saving an expression that
already exists appends a new entry to `sources[]` and does not create a second
row. Removing an expression deletes the entry outright (including all
sources).

### Backend

#### Translation prompt (`lib/translate.js`)

Extend the idioms section of the existing system prompt so Claude returns a
bucket per idiom. Add to the idioms instructions:

> For each idiom, include a `"bucket"` field set to one of `"common"`,
> `"intermediate"`, or `"advanced"`, reflecting how likely an intermediate
> Italian learner is to already know the phrase. Use `"common"` for basic
> football vocabulary (e.g., "di testa"), `"intermediate"` for phrases a
> motivated learner would recognize, and `"advanced"` for genuinely idiomatic
> or regional expressions.

`normalizeAnalysis()` must validate the bucket value and fall back to
`"intermediate"` if the field is missing, misspelled, or unrecognized. No new
cost tracking is needed — bucket is one short token per idiom.

#### New module: `lib/saved-vocab.js`

Follows the same pattern as `lib/sessions.js` (in-memory state + flush timer):

- `init()` — load `sessions/saved-vocab.json` (create empty file if missing).
- `list()` — return entries sorted by `savedAt` descending.
- `add({ expression, meaning, bucket, source })` — lowercased-trimmed dedupe.
  If entry exists, append source (skipping exact duplicate sources by
  `sessionId + lineId`). If not, create new entry with a generated `id`.
- `remove(expression)` — delete the entry by dedupe key.
- `has(expression)` — boolean membership check.
- `shutdown()` — flush on SIGINT/SIGTERM like `sessions.js`.

The file is written through a 5-second debounced flush timer to match the
session persistence pattern.

#### New REST endpoints (`server.js`)

- `GET /api/saved-vocab` → `{ entries: [...] }`
- `POST /api/saved-vocab` → body `{ expression, meaning, bucket, source }`;
  calls `add()`, returns `{ entry, created: true|false }`.
- `POST /api/saved-vocab/remove` → body `{ expression }`; calls `remove()`,
  returns `{ removed: true }`. (Body-based rather than DELETE-with-path-param
  to avoid awkward URL encoding of expressions containing slashes or other
  reserved characters.)

These routes are registered before the session ID regex routes in `server.js`
to avoid pattern conflicts.

#### Backfill script: `scripts/backfill-buckets.js`

A standalone node script invoked manually:

```bash
node scripts/backfill-buckets.js
```

Steps:
1. Load every session file under `sessions/`.
2. For each session, collect idioms that have no `bucket` field into a single
   list (deduped by expression within the session).
3. Send one Claude request per session classifying the batch:

   > Classify each Italian phrase as "common", "intermediate", or "advanced"
   > for an intermediate Italian learner. Return JSON: `{classifications:
   > [{expression, bucket}, ...]}`.

4. Write the bucket back onto every matching idiom entry in the session file.
5. Safe to re-run — idioms with existing buckets are skipped.
6. Logs progress and estimated cost per session (using the same
   `calcCost()` helper from `lib/translate.js`).

Estimated total cost at current volume: ~$0.10-$0.20 for all existing
sessions.

### Frontend

#### Sidebar navigation (`public/index.html`, `public/app.js`)

The existing sessions sidebar grows a "Library" section above the sessions
list. The Library section contains a single "Saved Vocab" nav item displaying
a star icon and the current saved count. Styling matches the existing session
list item look, but with a distinct section label.

New client state: `currentView = "session" | "saved-vocab"`. Clicking "Saved
Vocab" sets `currentView = "saved-vocab"` and swaps the main area. Clicking a
session item resets to `currentView = "session"`. The top bar controls (mic,
start/stop, translation toggle) are hidden when `currentView === "saved-vocab"`.

#### Current-session Vocab tab (`renderVocab()` in `app.js`)

The vocab list is now grouped and sorted:

1. Group idioms by bucket: `advanced`, `intermediate`, `common`,
   `unbucketed`.
2. Sort groups in that order.
3. Within each group, preserve line-order (chronological) ordering.
4. Insert a small uppercase label row between groups
   (`<div class="level-group-label">Advanced</div>`).

Each vocab row grows two additions:
- A colored bucket dot to the left of the expression.
- A star button on the right column, alongside the existing play button.

The star reflects saved state via a client-side `Set<expression>` loaded from
`GET /api/saved-vocab` on app init. Click toggles: calls `POST /api/saved-vocab`
to add or `POST /api/saved-vocab/remove` to remove, updating the Set
optimistically. Failed requests revert the UI and show an error toast.

The `source` payload on save is built from the current line — the session's
id and name, the lineId, a context quote truncated client-side to 120
characters (same logic as today's vocab meta line), and `audioOffsetSec`.
The server stores the truncated quote as-is; it does not re-truncate.

#### Saved Vocab view (new panel in `index.html`)

A new sibling of `#transcript` and `#vocab-panel`:

```html
<div id="saved-vocab-view" class="saved-vocab-view">
  <header class="saved-vocab-header">
    <h2>Saved Vocab</h2>
    <span class="saved-vocab-count"></span>
  </header>
  <div class="saved-vocab-controls">
    <input class="saved-vocab-search" placeholder="Search phrases or meanings…" />
    <div class="saved-vocab-filters">
      <button data-bucket="all" class="filter-chip active">All</button>
      <button data-bucket="advanced" class="filter-chip">Advanced</button>
      <button data-bucket="intermediate" class="filter-chip">Intermediate</button>
      <button data-bucket="common" class="filter-chip">Common</button>
    </div>
  </div>
  <div class="saved-vocab-list"></div>
</div>
```

Rendering (`renderSavedVocab()`):
- Fetches entries from the in-memory cache (populated from
  `GET /api/saved-vocab`).
- Applies client-side search filter (case-insensitive match on `expression`
  and `meaning`).
- Applies bucket filter from the active chip.
- Renders one row per entry: colored bucket dot, expression, meaning,
  primary context quote, and source line.
- Source line shows "from **Session Name**" for single-source entries, or
  "from N sessions" for multi-source entries (with a tooltip listing all
  session names on hover).
- Shows total count in the header: "N phrases across M sessions".
- Empty state: "No saved vocab yet — save phrases from the Vocab tab."

Each row has a star button that removes the entry (calls
`POST /api/saved-vocab/remove`). Rows are not clickable — this is a
reference-only view.

Detecting removed sessions: the sidebar session list is already loaded into
client state, so `renderSavedVocab()` uses that same cache to resolve
`sessionId → sessionName`. Any source whose `sessionId` is absent from the
cache renders as "(session removed)" without an extra network call.

#### CSS

Reuse existing vocab item styles. Add:
- `.bucket-dot`, `.bucket-advanced`, `.bucket-intermediate`, `.bucket-common`
  using the existing entity color vars.
- `.level-group-label` — uppercase, muted, small tracked label.
- `.sidebar-library-section` — mirrors `.sidebar-sessions-section`.
- `.saved-vocab-view`, `.saved-vocab-header`, `.saved-vocab-controls`,
  `.saved-vocab-search`, `.filter-chip`, `.filter-chip.active`,
  `.saved-vocab-list`, `.saved-vocab-empty`.
- `.star-btn` and `.star-btn.saved` — star toggle state.

### Error handling

- **Bucket missing/invalid from Claude** — `normalizeAnalysis()` falls back
  to `"intermediate"`. Never throws.
- **`saved-vocab.json` missing on first run** — `init()` creates an empty
  `{ entries: [] }` file.
- **Save race condition** — two rapid clicks on the same star. Client uses
  optimistic updates on the local Set; server-side `add()` is idempotent.
- **Unknown session in `sources[]`** — if the referenced session was
  deleted, the saved entry still renders. Source line shows "(session
  removed)" for any `sessionId` that no longer exists in the sessions index.
- **Backfill script interrupted** — safe to re-run. Only touches idioms
  without a `bucket` field.
- **Very long saved list** — client-side search stays snappy up to ~1000
  entries. No server-side pagination needed for a personal tool.
- **Malformed `saved-vocab.json`** — `init()` logs a warning and starts from
  an empty collection. The corrupted file is renamed to `saved-vocab.json.bak`
  so it is not silently overwritten.

### Testing

**Unit tests (`lib/saved-vocab.js`)** — use a temporary directory to avoid
polluting the real `sessions/` folder:

- `add()` creates an entry when expression is new.
- `add()` appends source when expression already exists (dedupe by exact
  `sessionId + lineId`).
- `add()` normalizes expression for dedupe (`"Chiudere La"` equals `"chiudere la"`).
- `remove()` deletes an entry by expression.
- `has()` returns correct boolean before and after add/remove.
- `list()` returns entries sorted by `savedAt` descending.
- `init()` handles missing file, empty file, and malformed file gracefully.

**Unit tests (`lib/translate.js`)**:

- `normalizeAnalysis()` preserves valid bucket values.
- `normalizeAnalysis()` falls back to `"intermediate"` when bucket is
  missing, null, or unrecognized.

**Integration tests (`test/api.test.js` or similar)**:

- `POST /api/saved-vocab` creates a new entry.
- `POST /api/saved-vocab` with the same expression appends a source.
- `POST /api/saved-vocab/remove` removes the entry.
- `GET /api/saved-vocab` returns entries sorted by `savedAt` descending.
- All tests run against a temporary `sessions/` directory and clean up every
  artifact they create — both session files and `saved-vocab.json` — per the
  project's test-cleanup convention.

**Manual smoke test (documented in the plan, not automated)**:

1. Start a new session, save an idiom from the Vocab tab, switch to Saved
   Vocab view, verify it renders with source.
2. End the session, create a second one, save the same expression, verify it
   merges into one row showing "from 2 sessions".
3. Remove the entry, verify both sessions' vocab tabs now show the unstarred
   state.
4. Run `node scripts/backfill-buckets.js` on a session with idioms missing
   buckets, verify all idioms gain buckets and the Vocab tab now sorts by
   level.

## Implementation order

1. Update translation prompt in `lib/translate.js` and add bucket validation
   in `normalizeAnalysis()`. Write unit tests.
2. Add `lib/saved-vocab.js` module with unit tests.
3. Add REST endpoints in `server.js` with integration tests.
4. Update `renderVocab()` in `app.js` for bucket grouping and star toggles.
5. Add Saved Vocab view (HTML, CSS, client-side rendering).
6. Add sidebar nav entry and view switching.
7. Write `scripts/backfill-buckets.js` and run it against existing sessions.
8. Manual smoke test pass.

## Open questions

None at this stage — every user-facing decision has been made during
brainstorming. Implementation-level details (exact CSS tokens, DOM element
IDs, test file locations) will be resolved in the writing-plans step.
