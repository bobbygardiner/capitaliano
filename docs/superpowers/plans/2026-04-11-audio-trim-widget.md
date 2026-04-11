# Audio Trim Widget Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified audio trim modal that lets users adjust clip boundaries for transcript lines and saved vocab items, with an iTunes-style scrubber and persistent save.

**Architecture:** Two new PATCH endpoints persist trim values on lines and vocab sources. A single `getEffectiveTrim()` helper on the frontend resolves trim-or-default for all playback. A modal with a scrubber track, draggable handles, and play/reset/save controls provides the editing UI.

**Tech Stack:** Node.js backend (existing), vanilla JS frontend (existing), HTML `<audio>` element for playback, CSS for modal and scrubber.

---

## Chunk 1: Backend — Data Model & API

### Task 1: Add `totalDurationSec` to session end flow

**Files:**
- Modify: `lib/sessions.js:78-97` (end function)
- Modify: `server.js:180-188` (POST /end handler)
- Modify: `server.js:190-195` (GET /api/sessions/:id handler)

- [ ] **Step 1: Update `sessions.end()` to accept options**

In `lib/sessions.js`, change the `end()` function signature to accept an optional
options object and persist `totalDurationSec`:

```js
// lib/sessions.js:78 — change:
async function end() {
// to:
async function end(opts = {}) {
```

Then after line 81 (`activeSession.data.endedAt = ...`), add:

```js
  if (opts.totalDurationSec != null) {
    activeSession.data.totalDurationSec = opts.totalDurationSec;
  }
```

- [ ] **Step 2: Compute and pass `totalDurationSec` in server.js end-session handler**

In `server.js:180-188`, the POST `/end` handler currently calls `sessions.end()`
with no arguments. The `pcmBytesWritten` variable is scoped to the WebSocket
handler and not accessible here. Instead, compute duration from the PCM file size.

**Note:** The spec mentions computing this in the WebSocket close handler, but
`sessions.end()` is only called from the REST endpoint, never from the WS close
handler. Computing from file size in the REST handler is equivalent and simpler.
The Step 3 GET fallback ensures legacy sessions are also covered.

```js
// server.js — replace lines 180-188:
      const endMatch = urlPath.match(RE_SESSION_END);
      if (endMatch && req.method === 'POST') {
        const active = sessions.getActive();
        if (!active || active.id !== endMatch[1]) {
          return sendJson(res, 409, { error: 'Session is not the active session' });
        }
        // Compute totalDurationSec from PCM file size
        let totalDurationSec = null;
        const pcmPath = resolve('sessions', `${endMatch[1]}.pcm`);
        try {
          const st = await stat(pcmPath);
          totalDurationSec = st.size / 32000;
        } catch {}
        const result = await sessions.end({ totalDurationSec });
        return sendJson(res, 200, result);
      }
```

- [ ] **Step 3: Add `totalDurationSec` to `GET /api/sessions/:id` for ended sessions without the field**

In `server.js`, the GET handler at line 193 returns `sessions.get(id)`. For
existing sessions that were ended before this change, `totalDurationSec` won't
be in the JSON. Add a fallback computation after fetching the session:

```js
// server.js — replace lines 193-195:
        if (req.method === 'GET') {
          const session = await sessions.get(id);
          // Backfill totalDurationSec for legacy sessions
          if (session.endedAt && session.totalDurationSec == null) {
            const pcmPath = resolve('sessions', `${id}.pcm`);
            try {
              const st = await stat(pcmPath);
              session.totalDurationSec = st.size / 32000;
            } catch {}
          }
          return sendJson(res, 200, session);
```

- [ ] **Step 4: Verify manually**

Run the server: `node server.js`
- End a session and check the session JSON file includes `totalDurationSec`
- GET an old session and verify the response includes `totalDurationSec`

- [ ] **Step 5: Commit**

```bash
git add lib/sessions.js server.js
git commit -m "feat: add totalDurationSec to session end flow"
```

---

### Task 2: Add `updateLineTrim()` to sessions module

**Files:**
- Modify: `lib/sessions.js:167-182` (add trim fields to updateLine)
- Modify: `lib/sessions.js:230` (export)

- [ ] **Step 1: Add trim field support to `updateLine()`**

In `lib/sessions.js:168-181`, add trim field handling after line 179:

```js
  if (updates.trimStartSec !== undefined) line.trimStartSec = updates.trimStartSec;
  if (updates.trimEndSec !== undefined) line.trimEndSec = updates.trimEndSec;
```

- [ ] **Step 2: Add a new `updateLineDisk()` function for ended sessions**

The existing `updateLine()` only works on the active session. For ended sessions
(which is the typical case for trimming — you trim after a match), we need a
function that reads from disk, updates, and writes back:

```js
// lib/sessions.js — add after updateLine() (after line 182):
async function updateLineDisk(sessionId, lineId, updates) {
  // If it's the active session, use in-memory update
  if (activeSession && activeSession.data.id === sessionId) {
    return updateLine(lineId, updates);
  }
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  const data = JSON.parse(await readFile(filePath, 'utf-8'));
  const line = data.lines.find(l => l.lineId === lineId);
  if (!line) return false;
  if (updates.trimStartSec !== undefined) line.trimStartSec = updates.trimStartSec;
  if (updates.trimEndSec !== undefined) line.trimEndSec = updates.trimEndSec;
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
  return true;
}
```

- [ ] **Step 3: Export the new function**

In `lib/sessions.js:230`, add `updateLineDisk` to the export:

```js
export { init, list, create, get, update, end, remove, addLine, updateLine, updateLineDisk, getActive, flush, shutdown, setAudioStartedAt };
```

- [ ] **Step 4: Commit**

```bash
git add lib/sessions.js
git commit -m "feat: add trim field support to session line updates"
```

---

### Task 3: Add `updateSourceTrim()` to saved-vocab module

**Files:**
- Modify: `lib/saved-vocab.js` (add updateSourceTrim function and export)

- [ ] **Step 1: Add `findById()` helper**

In `lib/saved-vocab.js`, add after the `has()` function (after line 63):

```js
function findById(id) {
  return state.entries.find(e => e.id === id);
}
```

- [ ] **Step 2: Add `updateSourceTrim()` function**

Add after the `remove()` function (after line 96):

```js
function updateSourceTrim(vocabId, sessionId, lineId, trimStartSec, trimEndSec) {
  const entry = findById(vocabId);
  if (!entry) return null;
  const source = entry.sources.find(s => s.sessionId === sessionId && s.lineId === lineId);
  if (!source) return null;
  source.trimStartSec = trimStartSec;
  source.trimEndSec = trimEndSec;
  dirty = true;
  return entry;
}
```

- [ ] **Step 3: Export the new function**

In `lib/saved-vocab.js:114`, update the export:

```js
export { init, list, has, add, remove, updateSourceTrim, flush, shutdown };
```

- [ ] **Step 4: Commit**

```bash
git add lib/saved-vocab.js
git commit -m "feat: add updateSourceTrim to saved-vocab module"
```

---

### Task 4: Add PATCH endpoints for trim

**Files:**
- Modify: `server.js:35-38` (add RE_SESSION_LINE regex)
- Modify: `server.js:119-137` (add saved-vocab trim route)
- Modify: `server.js:190-206` (add session line trim route)

- [ ] **Step 1: Add `RE_SESSION_LINE` regex**

In `server.js`, after line 38 (`RE_SESSION_AUDIO`), add:

```js
const RE_SESSION_LINE = /^\/api\/sessions\/(sess_\d+)\/lines\/(\d+)$/;
const RE_SAVED_VOCAB_TRIM = /^\/api\/saved-vocab\/(sv_\d+)\/trim$/;
```

- [ ] **Step 2: Add trim validation helper**

Add after the route regex patterns (after the new line from step 1):

```js
function validateTrim(trimStartSec, trimEndSec, totalDurationSec) {
  if (trimStartSec === null && trimEndSec === null) return null; // clearing trim
  if (typeof trimStartSec !== 'number' || typeof trimEndSec !== 'number') {
    return 'trimStartSec and trimEndSec must both be numbers or both be null';
  }
  if (trimStartSec < 0) return 'trimStartSec must be >= 0';
  if (totalDurationSec != null && trimEndSec > totalDurationSec) {
    return 'trimEndSec must be <= totalDurationSec';
  }
  if (trimStartSec >= trimEndSec) return 'trimStartSec must be < trimEndSec';
  if (trimEndSec - trimStartSec < 0.5) return 'trim duration must be >= 0.5s';
  return null;
}
```

- [ ] **Step 3: Add PATCH `/api/sessions/:id/lines/:lineId` handler**

In `server.js`, add before the `idMatch` block (before line 190):

```js
      const lineMatch = urlPath.match(RE_SESSION_LINE);
      if (lineMatch && req.method === 'PATCH') {
        const id = lineMatch[1];
        const lineId = parseInt(lineMatch[2], 10);
        const body = await readBody(req);
        const { trimStartSec = null, trimEndSec = null } = body;

        // Get totalDurationSec for validation
        const session = await sessions.get(id);
        let totalDurationSec = session.totalDurationSec;
        if (totalDurationSec == null) {
          const pcmPath = resolve('sessions', `${id}.pcm`);
          try { const st = await stat(pcmPath); totalDurationSec = st.size / 32000; } catch {}
        }

        const err = validateTrim(trimStartSec, trimEndSec, totalDurationSec);
        if (err) return sendJson(res, 400, { error: err });

        const ok = await sessions.updateLineDisk(id, lineId, { trimStartSec, trimEndSec });
        if (!ok) return sendJson(res, 404, { error: 'Line not found' });
        return sendJson(res, 200, { trimStartSec, trimEndSec });
      }
```

- [ ] **Step 4: Add PATCH `/api/saved-vocab/:id/trim` handler**

In `server.js`, add after the existing saved-vocab POST handler (after line 137):

```js
      const vocabTrimMatch = urlPath.match(RE_SAVED_VOCAB_TRIM);
      if (vocabTrimMatch && req.method === 'PATCH') {
        const vocabId = vocabTrimMatch[1];
        const body = await readBody(req);
        const { sessionId, lineId, trimStartSec = null, trimEndSec = null } = body;
        if (!sessionId || lineId == null) {
          return sendJson(res, 400, { error: 'sessionId and lineId are required' });
        }

        // Get totalDurationSec for validation
        let totalDurationSec = null;
        try {
          const session = await sessions.get(sessionId);
          totalDurationSec = session.totalDurationSec;
          if (totalDurationSec == null) {
            const pcmPath = resolve('sessions', `${sessionId}.pcm`);
            try { const st = await stat(pcmPath); totalDurationSec = st.size / 32000; } catch {}
          }
        } catch {}

        const err = validateTrim(trimStartSec, trimEndSec, totalDurationSec);
        if (err) return sendJson(res, 400, { error: err });

        const entry = savedVocab.updateSourceTrim(vocabId, sessionId, lineId, trimStartSec, trimEndSec);
        if (!entry) return sendJson(res, 404, { error: 'Vocab entry or source not found' });
        return sendJson(res, 200, { entry });
      }
```

- [ ] **Step 5: Verify manually**

Run: `node server.js`
Test with curl:
```bash
# Save a trim on a line
curl -X PATCH http://localhost:3000/api/sessions/sess_XXX/lines/3 \
  -H 'Content-Type: application/json' \
  -d '{"trimStartSec": 39.0, "trimEndSec": 47.5}'

# Clear a trim
curl -X PATCH http://localhost:3000/api/sessions/sess_XXX/lines/3 \
  -H 'Content-Type: application/json' \
  -d '{"trimStartSec": null, "trimEndSec": null}'
```

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: add PATCH endpoints for audio trim"
```

---

## Chunk 2: Frontend — getEffectiveTrim & Playback Integration

### Task 5: Add `getEffectiveTrim()` helper and refactor playback

**Files:**
- Modify: `public/app.js:1408-1444` (playLineRange — use getEffectiveTrim)
- Modify: `public/app.js:1446-1459` (playLineAudio, playSavedVocabAudio — pass overrides)

- [ ] **Step 1: Add `getEffectiveTrim()` function**

In `public/app.js`, add before the `playLineRange()` function (before line 1408):

```js
function getEffectiveTrim(lineId, session, overrides = {}) {
  const lines = session.lines || [];
  const idx = lines.findIndex(l => l.lineId === lineId);
  if (idx === -1) return null;
  const line = lines[idx];
  const prevLine = idx > 0 ? lines[idx - 1] : null;

  const trimStart = overrides.trimStartSec ?? line.trimStartSec;
  const trimEnd = overrides.trimEndSec ?? line.trimEndSec;

  return {
    from: trimStart != null ? trimStart : (prevLine?.audioOffsetSec ?? 0),
    to:   trimEnd != null   ? trimEnd   : line.audioOffsetSec,
  };
}
```

- [ ] **Step 2: Refactor `playLineRange()` to use `getEffectiveTrim()`**

Replace the range calculation in `playLineRange()`. Change lines 1415-1422 from:

```js
  const lines = session.lines || [];
  const idx = lines.findIndex(l => l.lineId === lineId);
  if (idx === -1) return;
  const line = lines[idx];
  const prevLine = idx > 0 ? lines[idx - 1] : null;
  const from = prevLine?.audioOffsetSec ?? 0;
  const to = line.audioOffsetSec;
  if (to == null) return;
```

To:

```js
  const trim = getEffectiveTrim(lineId, session, overrides);
  if (!trim || trim.to == null) return;
  const { from, to } = trim;
```

And update the function signature from:
```js
async function playLineRange(session, lineId, btn, key) {
```
To:
```js
async function playLineRange(session, lineId, btn, key, overrides = {}) {
```

- [ ] **Step 3: Update `playSavedVocabAudio()` to pass source overrides**

In `public/app.js`, update `playSavedVocabAudio()` to pass the source's trim
fields as overrides:

```js
async function playSavedVocabAudio(source, btn) {
  try {
    const session = await loadSessionCached(source.sessionId);
    await playLineRange(session, source.lineId, btn, `saved:${source.sessionId}:${source.lineId}`, source);
  } catch (err) {
    console.error('[capitaliano] Saved vocab audio error:', err);
  }
}
```

- [ ] **Step 4: Verify playback still works**

Run: `node server.js`, open the app, play a transcript line and a saved vocab
item. Verify audio plays the same as before (since no trim values are set yet).

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: add getEffectiveTrim helper, refactor playback"
```

---

## Chunk 3: Frontend — Trim Modal UI

### Task 6: Add trim modal HTML and CSS

**Files:**
- Modify: `public/index.html` (add modal markup and CSS)

- [ ] **Step 1: Add trim modal CSS**

In `public/index.html`, add after the edit-context modal CSS (after the
`.edit-context-panel.open` rule, around line 1123):

```css
    /* --- Audio trim modal --- */
    .trim-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(61, 53, 41, 0.15);
      z-index: 299;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s ease, visibility 0.3s;
    }
    .trim-backdrop.open { opacity: 1; visibility: visible; }

    .trim-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.95);
      width: 520px;
      max-width: 92vw;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-lg);
      z-index: 300;
      padding: 24px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s ease, visibility 0.3s, transform 0.3s var(--ease-out);
    }
    .trim-panel.open {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, -50%) scale(1);
    }

    .trim-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 4px;
    }
    .trim-header h3 {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 70%;
    }
    .trim-header .trim-session-name {
      font-size: 12px;
      color: var(--text-muted);
    }
    .trim-context-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .trim-times {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-variant-numeric: tabular-nums;
      margin-bottom: 12px;
    }
    .trim-time-start, .trim-time-end {
      font-size: 22px;
      font-weight: 600;
      color: var(--accent);
    }
    .trim-time-playhead {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Scrubber track */
    .trim-scrubber {
      position: relative;
      height: 44px;
      margin-bottom: 6px;
      cursor: pointer;
      touch-action: none;
    }
    .trim-track {
      position: absolute;
      top: 18px;
      left: 0;
      right: 0;
      height: 8px;
      background: var(--border);
      border-radius: 4px;
    }
    .trim-default-region {
      position: absolute;
      top: 16px;
      height: 12px;
      border: 1px dashed var(--accent);
      opacity: 0.3;
      border-radius: 3px;
      pointer-events: none;
    }
    .trim-selected-region {
      position: absolute;
      top: 16px;
      height: 12px;
      background: var(--accent);
      opacity: 0.25;
      border-radius: 3px;
      pointer-events: none;
    }
    .trim-handle {
      position: absolute;
      top: 10px;
      width: 6px;
      height: 24px;
      background: var(--accent);
      border-radius: 3px;
      cursor: ew-resize;
      touch-action: none;
      z-index: 2;
    }
    .trim-handle:hover {
      background: var(--accent-hover, var(--accent));
      transform: scaleX(1.3);
    }
    .trim-playhead {
      position: absolute;
      top: 8px;
      width: 2px;
      height: 28px;
      background: var(--text);
      border-radius: 1px;
      pointer-events: none;
      z-index: 1;
    }

    .trim-range-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .trim-legend {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }
    .trim-legend-swatch {
      display: inline-block;
      width: 12px;
      height: 8px;
      border-radius: 2px;
      margin-right: 4px;
      vertical-align: middle;
    }

    .trim-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .trim-actions-left, .trim-actions-right {
      display: flex;
      gap: 10px;
    }
    .trim-btn {
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .trim-btn:hover { opacity: 0.85; }
    .trim-btn-play {
      background: var(--accent);
      color: var(--bg);
      font-weight: 600;
    }
    .trim-btn-reset {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .trim-btn-cancel {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .trim-btn-save {
      background: #2d6a4f;
      color: #e0e0e0;
      font-weight: 600;
    }

    /* Scissors (trim) button styles */
    .line-trim-btn {
      display: inline-block;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-muted);
      margin-right: 4px;
      transition: color 0.15s ease;
      user-select: none;
      vertical-align: baseline;
    }
    .line-trim-btn:hover { color: var(--accent); }
    .line-trim-btn.trimmed { color: var(--accent); }

    .vocab-trim-btn {
      cursor: pointer;
      font-size: 11px;
      color: var(--text-muted);
      transition: color 0.15s ease;
      user-select: none;
    }
    .vocab-trim-btn:hover { color: var(--accent); }
    .vocab-trim-btn.trimmed { color: var(--accent); }

    .saved-vocab-trim-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
      line-height: 1;
      transition: color 0.15s ease;
    }
    .saved-vocab-trim-btn:hover { color: var(--accent); }
    .saved-vocab-trim-btn.trimmed { color: var(--accent); }
```

- [ ] **Step 2: Add trim modal HTML**

In `public/index.html`, add the modal markup at the end of `<body>`, before
the closing `</body>` tag (next to the existing edit-context modal markup):

```html
  <!-- Audio trim modal -->
  <div class="trim-backdrop" id="trimBackdrop"></div>
  <div class="trim-panel" id="trimPanel">
    <div class="trim-header">
      <h3 id="trimTitle"></h3>
      <span class="trim-session-name" id="trimSessionName"></span>
    </div>
    <div class="trim-context-label" id="trimContextLabel"></div>
    <div class="trim-times">
      <span class="trim-time-start" id="trimTimeStart">0:00.0</span>
      <span class="trim-time-playhead" id="trimTimePlayhead">&#9654; 0:00.0</span>
      <span class="trim-time-end" id="trimTimeEnd">0:00.0</span>
    </div>
    <div class="trim-scrubber" id="trimScrubber">
      <div class="trim-track"></div>
      <div class="trim-default-region" id="trimDefaultRegion"></div>
      <div class="trim-selected-region" id="trimSelectedRegion"></div>
      <div class="trim-handle" id="trimHandleStart"></div>
      <div class="trim-handle" id="trimHandleEnd"></div>
      <div class="trim-playhead" id="trimPlayhead"></div>
    </div>
    <div class="trim-range-labels">
      <span id="trimRangeStart">0:00.0</span>
      <span id="trimRangeEnd">0:00.0</span>
    </div>
    <div class="trim-legend">
      <span><span class="trim-legend-swatch" style="border:1px dashed var(--accent);opacity:0.3;background:transparent;"></span>Default</span>
      <span><span class="trim-legend-swatch" style="background:var(--accent);opacity:0.25;"></span>Your trim</span>
    </div>
    <div class="trim-actions">
      <div class="trim-actions-left">
        <button class="trim-btn trim-btn-play" id="trimPlayBtn">&#9654; Play</button>
        <button class="trim-btn trim-btn-reset" id="trimResetBtn">Reset</button>
      </div>
      <div class="trim-actions-right">
        <button class="trim-btn trim-btn-cancel" id="trimCancelBtn">Cancel</button>
        <button class="trim-btn trim-btn-save" id="trimSaveBtn">Save</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Verify the modal renders**

Run: `node server.js`, open the app, open browser dev tools, and manually add
class `open` to `#trimBackdrop` and `#trimPanel`. Verify the modal appears
centered with correct styling.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add trim modal HTML and CSS"
```

---

### Task 7: Add trim modal JavaScript logic

**Files:**
- Modify: `public/app.js` (add trim modal state, open/close, scrubber interaction, save/reset)

This is the largest task. The modal logic goes into `public/app.js`.

- [ ] **Step 1: Add trim modal state variables**

Add near the existing audio state variables (around line 1367):

```js
// --- Trim modal state ---
let trimModalOpen = false;
let trimAudioEl = null;
let trimBlobUrl = null;
let trimContext = null; // { type: 'line'|'vocab', sessionId, lineId, session, vocabId?, source?, defaultFrom, defaultTo, bufferStart, bufferEnd }
let trimStart = 0;  // current handle positions (absolute session seconds)
let trimEnd = 0;
let trimAnimFrame = null;
```

- [ ] **Step 2: Add time formatting helper**

Add near the top of app.js (near other utility functions):

```js
function formatTrimTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
```

- [ ] **Step 3: Add `openTrimModal()` function**

```js
async function openTrimModal({ type, sessionId, lineId, session, vocabId, source }) {
  stopAudioPlayback(); // stop any current playback

  const defaultTrim = getEffectiveTrim(lineId, session, source || {});
  if (!defaultTrim || defaultTrim.to == null) return;

  const totalDuration = session.totalDurationSec || defaultTrim.to + 30;
  const bufferStart = Math.max(0, defaultTrim.from - 30);
  const bufferEnd = Math.min(totalDuration, defaultTrim.to + 30);

  // Determine current trim (saved values or defaults)
  const currentOverrides = source || session.lines.find(l => l.lineId === lineId) || {};
  const hasSavedTrim = currentOverrides.trimStartSec != null;
  trimStart = hasSavedTrim ? currentOverrides.trimStartSec : defaultTrim.from;
  trimEnd = hasSavedTrim ? currentOverrides.trimEndSec : defaultTrim.to;

  trimContext = {
    type, sessionId, lineId, session, vocabId: vocabId || null,
    source: source || null,
    defaultFrom: defaultTrim.from, defaultTo: defaultTrim.to,
    bufferStart, bufferEnd,
  };

  // Fetch audio for buffer range
  try {
    const res = await fetch(`/api/sessions/${sessionId}/audio?from=${bufferStart}&to=${bufferEnd}`);
    if (!res.ok) throw new Error('Audio fetch failed');
    const blob = await res.blob();
    trimBlobUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.error('[capitaliano] Trim audio fetch error:', err);
    return;
  }

  // Set up audio element
  if (!trimAudioEl) {
    trimAudioEl = new Audio();
    trimAudioEl.addEventListener('timeupdate', onTrimTimeUpdate);
  }
  trimAudioEl.src = trimBlobUrl;

  // Populate modal text
  const line = session.lines.find(l => l.lineId === lineId);
  const lineText = line?.text || '';
  const truncText = lineText.length > 40 ? lineText.slice(0, 40) + '...' : lineText;

  const quote = source?.contextQuote || '';
  if (type === 'vocab' && quote) {
    document.getElementById('trimTitle').textContent = `Trim: "${quote.length > 40 ? quote.slice(0, 40) + '...' : quote}"`;
  } else {
    document.getElementById('trimTitle').textContent = `Trim: Line ${lineId}${truncText ? ': "' + truncText + '"' : ''}`;
  }
  document.getElementById('trimSessionName').textContent = session.name || '';
  document.getElementById('trimContextLabel').textContent =
    type === 'vocab' && quote ? `Edit clip for "${quote.length > 50 ? quote.slice(0, 50) + '...' : quote}"` :
    type === 'vocab' ? 'Edit clip for this vocab item' :
    'Edit clip for this line';

  document.getElementById('trimRangeStart').textContent = formatTrimTime(bufferStart);
  document.getElementById('trimRangeEnd').textContent = formatTrimTime(bufferEnd);

  updateTrimUI();

  // Open modal
  document.getElementById('trimBackdrop').classList.add('open');
  document.getElementById('trimPanel').classList.add('open');
  trimModalOpen = true;
}
```

- [ ] **Step 4: Add `closeTrimModal()` function**

```js
function closeTrimModal() {
  document.getElementById('trimBackdrop').classList.remove('open');
  document.getElementById('trimPanel').classList.remove('open');
  trimModalOpen = false;

  if (trimAudioEl) {
    trimAudioEl.pause();
    trimAudioEl.removeAttribute('src');
  }
  if (trimBlobUrl) {
    URL.revokeObjectURL(trimBlobUrl);
    trimBlobUrl = null;
  }
  if (trimAnimFrame) {
    cancelAnimationFrame(trimAnimFrame);
    trimAnimFrame = null;
  }
  trimContext = null;
}
```

- [ ] **Step 5: Add `updateTrimUI()` function**

This updates handle positions, the selected region, and time displays:

```js
function updateTrimUI() {
  if (!trimContext) return;
  const { bufferStart, bufferEnd, defaultFrom, defaultTo } = trimContext;
  const range = bufferEnd - bufferStart;
  if (range <= 0) return;

  const scrubber = document.getElementById('trimScrubber');
  const width = scrubber.offsetWidth;

  const toPercent = (sec) => ((sec - bufferStart) / range) * 100;
  const toPx = (sec) => ((sec - bufferStart) / range) * width;

  // Default region
  const defRegion = document.getElementById('trimDefaultRegion');
  defRegion.style.left = toPercent(defaultFrom) + '%';
  defRegion.style.width = (toPercent(defaultTo) - toPercent(defaultFrom)) + '%';

  // Selected region
  const selRegion = document.getElementById('trimSelectedRegion');
  selRegion.style.left = toPercent(trimStart) + '%';
  selRegion.style.width = (toPercent(trimEnd) - toPercent(trimStart)) + '%';

  // Handles
  document.getElementById('trimHandleStart').style.left = `calc(${toPercent(trimStart)}% - 3px)`;
  document.getElementById('trimHandleEnd').style.left = `calc(${toPercent(trimEnd)}% - 3px)`;

  // Time displays
  document.getElementById('trimTimeStart').textContent = formatTrimTime(trimStart);
  document.getElementById('trimTimeEnd').textContent = formatTrimTime(trimEnd);
}
```

- [ ] **Step 6: Add handle drag logic**

```js
function initTrimDrag(handleId, isStart) {
  const handle = document.getElementById(handleId);
  const scrubber = document.getElementById('trimScrubber');

  function onPointerMove(e) {
    const rect = scrubber.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const { bufferStart, bufferEnd } = trimContext;
    const sec = bufferStart + (x / rect.width) * (bufferEnd - bufferStart);

    if (isStart) {
      trimStart = Math.max(bufferStart, Math.min(sec, trimEnd - 0.5));
    } else {
      trimEnd = Math.max(trimStart + 0.5, Math.min(sec, bufferEnd));
    }
    updateTrimUI();
  }

  function onPointerUp() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}
```

- [ ] **Step 7: Add playback, reset, save, cancel handlers**

```js
function onTrimTimeUpdate() {
  if (!trimContext || !trimAudioEl) return;
  const { bufferStart } = trimContext;
  const currentSec = bufferStart + trimAudioEl.currentTime;

  // Update playhead position
  const { bufferEnd } = trimContext;
  const range = bufferEnd - bufferStart;
  const percent = ((currentSec - bufferStart) / range) * 100;
  document.getElementById('trimPlayhead').style.left = percent + '%';
  document.getElementById('trimTimePlayhead').textContent = '\u25B6 ' + formatTrimTime(currentSec);

  // Pause at trim end
  if (currentSec >= trimEnd) {
    trimAudioEl.pause();
  }
}

function onTrimPlay() {
  if (!trimAudioEl || !trimContext) return;
  const { bufferStart } = trimContext;
  if (trimAudioEl.paused) {
    trimAudioEl.currentTime = trimStart - bufferStart;
    trimAudioEl.play();
  } else {
    trimAudioEl.pause();
  }
}

function onTrimReset() {
  if (!trimContext) return;
  trimStart = trimContext.defaultFrom;
  trimEnd = trimContext.defaultTo;
  updateTrimUI();
}

async function onTrimSave() {
  if (!trimContext) return;
  const { type, sessionId, lineId, vocabId, source, session } = trimContext;

  try {
    if (type === 'line') {
      const res = await fetch(`/api/sessions/${sessionId}/lines/${lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trimStartSec: trimStart, trimEndSec: trimEnd }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Update in-memory session data
      const line = session.lines.find(l => l.lineId === lineId);
      if (line) { line.trimStartSec = trimStart; line.trimEndSec = trimEnd; }
    } else if (type === 'vocab') {
      const res = await fetch(`/api/saved-vocab/${vocabId}/trim`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, lineId, trimStartSec: trimStart, trimEndSec: trimEnd }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Update in-memory source
      if (source) { source.trimStartSec = trimStart; source.trimEndSec = trimEnd; }
    }
  } catch (err) {
    console.error('[capitaliano] Trim save error:', err);
    return; // Don't close on error
  }

  // Update trim icon state
  updateTrimIcons();
  closeTrimModal();
}

function updateTrimIcons() {
  // Transcript line trim icons
  document.querySelectorAll('.line-trim-btn').forEach(btn => {
    const lid = parseInt(btn.dataset.lineId, 10);
    const line = currentSession?.lines?.find(l => l.lineId === lid);
    btn.classList.toggle('trimmed', line?.trimStartSec != null);
  });
  // In-session vocab panel trim icons (these trim the parent line)
  document.querySelectorAll('.vocab-trim-btn').forEach(btn => {
    const lid = parseInt(btn.dataset.lineId, 10);
    if (isNaN(lid)) return;
    const line = currentSession?.lines?.find(l => l.lineId === lid);
    btn.classList.toggle('trimmed', line?.trimStartSec != null);
  });
  // Saved vocab trim icons
  document.querySelectorAll('.saved-vocab-trim-btn').forEach(btn => {
    const vid = btn.dataset.vocabId;
    if (!vid) return;
    const entry = savedVocabCache?.find(e => e.id === vid);
    const hasTrim = entry?.sources?.some(s => s.trimStartSec != null);
    btn.classList.toggle('trimmed', !!hasTrim);
  });
}
```

- [ ] **Step 8: Wire up modal button event listeners**

Add at the end of the DOMContentLoaded or initialization section:

```js
// Trim modal event listeners
document.getElementById('trimBackdrop').addEventListener('click', closeTrimModal);
document.getElementById('trimCancelBtn').addEventListener('click', closeTrimModal);
document.getElementById('trimPlayBtn').addEventListener('click', onTrimPlay);
document.getElementById('trimResetBtn').addEventListener('click', onTrimReset);
document.getElementById('trimSaveBtn').addEventListener('click', onTrimSave);
initTrimDrag('trimHandleStart', true);
initTrimDrag('trimHandleEnd', false);
```

- [ ] **Step 9: Commit**

```bash
git add public/app.js
git commit -m "feat: add trim modal JavaScript logic"
```

---

### Task 8: Add scissors icons to transcript lines, vocab panel, and saved vocab

**Files:**
- Modify: `public/app.js:466-476` (createLineElement — add scissors icon)
- Modify: `public/app.js:1048-1070` (renderVocab — add scissors icon)
- Modify: `public/app.js:1185-1216` (renderSavedVocab — add scissors icon)

- [ ] **Step 1: Add scissors icon to transcript lines**

In `public/app.js`, in `createLineElement()`, after the play button block
(after the `ts.appendChild(playBtn)` line, around line 475), add:

```js
    // Look up the line object to check for existing trim
    const lineObj = currentSession?.lines?.find(l => l.lineId === lineId);
    const trimBtn = document.createElement('span');
    trimBtn.className = 'line-trim-btn' + (lineObj?.trimStartSec != null ? ' trimmed' : '');
    trimBtn.dataset.lineId = lineId;
    trimBtn.textContent = '\u2702';
    trimBtn.title = 'Trim audio clip';
    trimBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentSession) return;
      openTrimModal({ type: 'line', sessionId: currentSession.id, lineId, session: currentSession });
    });
    ts.appendChild(trimBtn);
```

- [ ] **Step 2: Add scissors icon to vocab panel items**

In `public/app.js`, in the `renderVocab()` function, in the innerHTML template
(around line 1055), add a trim button after the play button:

Change:
```js
            ${item.hasAudio ? '<span class="vocab-play-btn" title="Play audio">\u25B6</span> ' : ''}
```
To:
```js
            ${item.hasAudio ? '<span class="vocab-play-btn" title="Play audio">\u25B6</span><span class="vocab-trim-btn" data-line-id="' + item.lineId + '" title="Trim audio">\u2702</span> ' : ''}
```

Then in the event listener section (around line 1065), add after the play button
listener:

```js
      // Vocab panel items trim the parent line (not a standalone vocab source).
      // These are in-session entities without their own independent trim fields —
      // trimming here adjusts the line's clip, which is the correct behavior since
      // vocab panel items share the line's audio range.
      if (item.hasAudio) {
        const trimBtnEl = el.querySelector('.vocab-trim-btn');
        if (trimBtnEl) {
          trimBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!currentSession) return;
            openTrimModal({ type: 'line', sessionId: currentSession.id, lineId: item.lineId, session: currentSession });
          });
        }
      }
```

- [ ] **Step 3: Add scissors icon to saved vocab rows**

In `public/app.js`, in `renderSavedVocab()`, in the innerHTML template
(around line 1195), add a trim button:

Change:
```js
        ${hasAudio ? '<button class="saved-vocab-play-btn" title="Play audio">\u25B6</button>' : ''}
```
To:
```js
        ${hasAudio ? '<button class="saved-vocab-play-btn" title="Play audio">\u25B6</button><button class="saved-vocab-trim-btn' + (firstSource.trimStartSec != null ? ' trimmed' : '') + '" data-vocab-id="' + entry.id + '" title="Trim audio">\u2702</button>' : ''}
```

Then add the event listener (around line 1216):

```js
    if (hasAudio) {
      const trimBtnEl = row.querySelector('.saved-vocab-trim-btn');
      if (trimBtnEl) {
        trimBtnEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const session = await loadSessionCached(firstSource.sessionId);
            openTrimModal({
              type: 'vocab',
              sessionId: firstSource.sessionId,
              lineId: firstSource.lineId,
              session,
              vocabId: entry.id,
              source: firstSource,
            });
          } catch (err) {
            console.error('[capitaliano] Trim modal error:', err);
          }
        });
      }
    }
```

- [ ] **Step 4: Verify scissors icons appear and open the modal**

Run: `node server.js`, open the app, verify:
- Scissors icon appears next to play buttons on transcript lines
- Scissors icon appears next to play buttons on vocab items
- Scissors icon appears next to play buttons on saved vocab rows
- Clicking any scissors icon opens the trim modal
- Trim handles are draggable
- Play Trim plays the trimmed range
- Save persists and closes the modal
- Reset snaps handles to defaults
- Cancel closes without saving
- After saving, the scissors icon turns purple (accent color)

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: add scissors icons for trim on all audio controls"
```

---

## Chunk 4: Integration & Polish

### Task 9: Click-to-seek on scrubber track

**Files:**
- Modify: `public/app.js` (add click handler to scrubber track)

- [ ] **Step 1: Add click-to-seek on the scrubber**

Users should be able to click anywhere on the scrubber track to move the
playhead. Add to the initialization section (near `initTrimDrag` calls):

```js
document.getElementById('trimScrubber').addEventListener('click', (e) => {
  if (!trimContext || !trimAudioEl) return;
  // Don't interfere with handle drags
  if (e.target.classList.contains('trim-handle')) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { bufferStart, bufferEnd } = trimContext;
  const sec = bufferStart + (x / rect.width) * (bufferEnd - bufferStart);
  trimAudioEl.currentTime = sec - bufferStart;
  onTrimTimeUpdate(); // immediate visual update
});
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: add click-to-seek on trim scrubber"
```

---

### Task 10: Handle edge cases and cleanup

**Files:**
- Modify: `public/app.js` (edge case handling)

- [ ] **Step 1: Handle Escape key to close trim modal**

Add to the modal initialization:

```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && trimModalOpen) {
    closeTrimModal();
  }
});
```

- [ ] **Step 2: Invalidate session cache after trim save**

After saving a line trim, the in-memory session data is updated. But if the
session was loaded via `loadSessionCached()`, the cache might serve stale data
on next load. In `onTrimSave()`, after the successful save for type `'line'`,
add:

```js
      // Invalidate cache so next load gets fresh data
      sessionDataCache.delete(sessionId);
```

The cache is `sessionDataCache` (a module-level `const Map` defined at
`public/app.js:1395`), used by `loadSessionCached()` at line 1396.

- [ ] **Step 3: Verify end-to-end**

Full manual test:
1. Open a completed session
2. Click scissors on a transcript line → modal opens
3. Drag handles, play trim, verify audio plays correct range
4. Save → scissors turns purple, normal play button now uses trimmed range
5. Reopen scissors → handles are at the saved positions
6. Reset → handles return to default, save to persist
7. Test saved vocab trim independently
8. Verify a trimmed line's vocab play button still works independently

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: trim modal edge cases and cache invalidation"
```
