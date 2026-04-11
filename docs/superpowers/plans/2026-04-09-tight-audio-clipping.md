# Tight Audio Clipping Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every saved line a tight, per-phrase audio window so Anki export (and in-app playback) can produce Refold-quality clips without trailing/leading silence.

**Architecture:** Layer two sources of timing on top of today's single `audioOffsetSec`:
1. **Start-of-utterance snapshot from WebSocket deltas** — cheap, always-on, ±400ms accuracy. Gives every line a `startOffsetSec` alongside the existing `audioOffsetSec` (end).
2. **Segment timestamps from Voxtral batch** (Phase 2 only) — requires adding `timestampGranularities: ['segment']` to the batch transcription call we already make, and dropping `language: 'it'` (empirically proven incompatible in the probe). Segments come back relative to the submitted slice; the pipeline converts them to absolute session seconds and splits them across the lineIds that were coalesced into the slice. Stored on each line as `audioSegments`.

A new HTTP endpoint `/api/sessions/:id/lines/:lineId/audio` looks up the best available window (segments > start+end offsets > fallback) and serves the existing `/api/sessions/:id/audio` PCM reader with a tight `from`/`to`.

**Tech Stack:** Node.js (already), `@mistralai/mistralai` v2 SDK (already — probe confirmed `timestampGranularities` is a typed request field and `TranscriptionResponse.segments` is a typed response field). No new dependencies.

**Out of scope for this plan:**
- Anki export / .apkg generation / card templates (follow-on plan)
- Word-level granularity (segment is already phrase-tight — probe showed `[0.6, 14.4]` and `[15.2, 19.9]` on a real 20s sample)
- VAD post-processing (not needed at segment precision)
- UI playback changes (the endpoint is the handoff)
- Backfill of historical sessions (new data only; endpoint degrades gracefully for old lines)

---

## Background & Key Facts

**Current state of session data:**
- `sessions/<id>.pcm` — continuous mono PCM16 @ 16kHz for the whole session (`server.js:457-461`).
- Each `line` in `sessions/<id>.json` carries a single `audioOffsetSec` that equals `pcmBytesWritten / 32000` captured inside `finalizeSentence` (`server.js:339-343`). That's **end-of-utterance-ish** in the session PCM — there is no explicit start, and no word/segment timing.
- The existing endpoint `GET /api/sessions/:id/audio?from=&to=` (`server.js:139-178`) already reads an arbitrary byte range from the PCM, wraps in a WAV header, and serves it. Keep it.

**Line schema as it ships today** (from `lib/sessions.js:148-165`):
```js
{
  lineId, text, timestamp,
  audioOffsetSec,       // scalar, end-of-utterance-ish (keep as-is)
  final: true,
  translation: null,
  segments: [],         // <-- COLLISION WARNING: this is translation/analysis text splits
                        //     from Claude, NOT audio segments. Do not reuse this field.
  entities: [],
  idioms: [],
  costUsd: 0,
}
```
New fields added by this plan: `startOffsetSec`, `audioSegments`, `endOffsetSec`. Use the name `audioSegments` — not `segments` — to avoid collision with the existing translation field.

**Phase 2 gating:** `createBatchPipeline` is only constructed when `CAPITO_PHASE2=1` (`server.js:281,294`). Segment timestamps therefore only populate when Phase 2 is enabled. The delta-snapshot `startOffsetSec` path is unconditional and works in both phases.

**Voxtral probe findings (2026-04-09, real session audio):**
- `timestampGranularities: ['segment']` with `contextBias` and no `language` → clean response with typed `segments[{type, text, start, end, speakerId}]`, start/end in seconds, 0.1s precision.
- `language: 'it'` + `timestampGranularities` → HTTP 503 `"overflow"`. Must drop the language param when requesting timestamps.
- Text output is **identical** across language=it and autodetect calls on Italian audio, so dropping the language param costs us nothing in accuracy.
- Voxtral caches audio prompts (`cached_tokens: 368` on re-submitted clip) — pure upside for the coalescing pipeline.

---

## File Structure

**Create:**
- `lib/segment-math.js` — pure helpers for window computation and segment filtering. Isolated, unit-testable, no IO, no SDK deps.
- `test/segment-math.test.js` — unit tests for the helpers above.

**Modify:**
- `lib/batch.js` — track slice byte boundaries, record per-line marker positions, request segment timestamps, convert to absolute session seconds, split across coalesced lines, pass through `onUpgrade`.
- `lib/sessions.js` — `addLine` accepts `startOffsetSec`; `updateLine` accepts `startOffsetSec`, `endOffsetSec`, `audioSegments`.
- `server.js` — snapshot `startOffsetSec` from first delta after a finalize; pass a `getSessionPcmBytes` getter into the batch pipeline; add the `/api/sessions/:id/lines/:lineId/audio` route.
- `test/batch.test.js` — extend existing tests to cover segment passthrough and per-line splitting.
- `test/audio-endpoint.test.js` — add tests for the new per-line audio endpoint.

**Intentionally not touched:**
- `lib/translate.js` — audio segments never go through Claude. The pipeline attaches them directly to the upgrade result after `mergeFn`/`splitAnalyzeFn` return.
- `public/app.js` — UI can consume the new endpoint in a follow-on PR.

---

## Chunk 1: Core plumbing, timestamp wiring, endpoint

### Task 1: Pure segment math helpers

**Files:**
- Create: `lib/segment-math.js`
- Test: `test/segment-math.test.js`

- [ ] **Step 1: Read relevant context**

Read `lib/batch.js` end-to-end (it's ~190 lines) so you understand the existing `markSentence` / coalesce flow. You'll call these helpers from there in Task 4.

- [ ] **Step 2: Write the failing tests**

Create `test/segment-math.test.js` with:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLineWindows,
  relativeToAbsoluteSegments,
  filterSegmentsForWindow,
  segmentsToBounds,
} from '../lib/segment-math.js';

describe('computeLineWindows', () => {
  it('returns a single window spanning the whole slice for one line', () => {
    // Slice started at byte 320000 (10s into the session). One marker at
    // byte 640000 — i.e., 10 more seconds of audio were appended before
    // markSentence fired. The returned window is RELATIVE to slice start,
    // so it runs from 0s to 10s.
    const windows = computeLineWindows(
      [{ lineId: 5, bytesAtMark: 640000 }],
      320000,
    );
    assert.deepEqual(windows, [
      { lineId: 5, startSec: 0, endSec: 10 },
    ]);
  });

  it('splits a coalesced slice across multiple lines', () => {
    // Slice start: byte 0. Two markers: lineId 0 at 160000 (5s), lineId 1 at 480000 (15s).
    const windows = computeLineWindows(
      [
        { lineId: 0, bytesAtMark: 160000 },
        { lineId: 1, bytesAtMark: 480000 },
      ],
      0,
    );
    assert.deepEqual(windows, [
      { lineId: 0, startSec: 0,  endSec: 5  },
      { lineId: 1, startSec: 5,  endSec: 15 },
    ]);
  });

  it('handles slice that does not start at byte 0', () => {
    // Slice starts at 32000 bytes (1s), two markers at 64000 (2s) and 160000 (5s).
    const windows = computeLineWindows(
      [
        { lineId: 7, bytesAtMark: 64000  },
        { lineId: 8, bytesAtMark: 160000 },
      ],
      32000,
    );
    // Windows are expressed in seconds RELATIVE to the slice start.
    assert.deepEqual(windows, [
      { lineId: 7, startSec: 0, endSec: 1 },
      { lineId: 8, startSec: 1, endSec: 4 },
    ]);
  });
});

describe('relativeToAbsoluteSegments', () => {
  it('shifts every segment by the slice start seconds', () => {
    const rel = [
      { text: 'ciao',  start: 0.6, end: 1.2 },
      { text: 'mondo', start: 1.3, end: 2.0 },
    ];
    const abs = relativeToAbsoluteSegments(rel, 10);
    assert.deepEqual(abs, [
      { text: 'ciao',  startSec: 10.6, endSec: 11.2 },
      { text: 'mondo', startSec: 11.3, endSec: 12.0 },
    ]);
  });

  it('returns [] for null/undefined input', () => {
    assert.deepEqual(relativeToAbsoluteSegments(null, 10), []);
    assert.deepEqual(relativeToAbsoluteSegments(undefined, 10), []);
  });
});

describe('filterSegmentsForWindow', () => {
  // All inputs are in seconds RELATIVE to the slice start (the shape the
  // batch pipeline works in before converting to absolute).
  const segs = [
    { text: 'a', start: 0.6, end: 1.0 },
    { text: 'b', start: 1.2, end: 1.8 },
    { text: 'c', start: 5.0, end: 5.4 },
    { text: 'd', start: 5.5, end: 6.0 },
  ];

  it('returns segments whose midpoint falls inside the window', () => {
    const got = filterSegmentsForWindow(segs, 0, 2);
    assert.deepEqual(got.map(s => s.text), ['a', 'b']);
  });

  it('includes a segment straddling the boundary if its midpoint is inside', () => {
    // Segment c: midpoint 5.2. Window 5..6 → include.
    const got = filterSegmentsForWindow(segs, 5, 6);
    assert.deepEqual(got.map(s => s.text), ['c', 'd']);
  });

  it('returns an empty array when no segments fall inside', () => {
    const got = filterSegmentsForWindow(segs, 10, 12);
    assert.deepEqual(got, []);
  });
});

describe('segmentsToBounds', () => {
  it('returns {startSec, endSec} padded by padSec on each side', () => {
    const segs = [
      { startSec: 10.6, endSec: 11.2 },
      { startSec: 11.3, endSec: 12.0 },
    ];
    assert.deepEqual(segmentsToBounds(segs, 0.1), { startSec: 10.5, endSec: 12.1 });
  });

  it('clamps a negative padded start to 0', () => {
    const segs = [{ startSec: 0.05, endSec: 0.5 }];
    assert.deepEqual(segmentsToBounds(segs, 0.1), { startSec: 0, endSec: 0.6 });
  });

  it('returns null for empty input', () => {
    assert.equal(segmentsToBounds([], 0.1), null);
    assert.equal(segmentsToBounds(null, 0.1), null);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/segment-math.test.js`
Expected: FAIL — module not found / helpers undefined.

- [ ] **Step 4: Implement the helpers**

Create `lib/segment-math.js`:

```js
// lib/segment-math.js
// Pure helpers for mapping between byte offsets, seconds, and Voxtral segments.
// No IO, no SDK dependencies — trivially unit-testable.

const BYTES_PER_SEC = 32000; // 16kHz * 2 bytes mono

/**
 * Given a list of markers {lineId, bytesAtMark} and the byte offset where the
 * current batch slice begins in the session PCM, return a per-line window
 * expressed in seconds RELATIVE to the slice start.
 *
 * Markers must be in call order. bytesAtMark is the session's cumulative
 * pcmBytesWritten at the instant markSentence was called for that line.
 */
export function computeLineWindows(markers, sliceStartBytes) {
  const windows = [];
  let prevBytes = sliceStartBytes;
  for (const { lineId, bytesAtMark } of markers) {
    windows.push({
      lineId,
      startSec: (prevBytes - sliceStartBytes) / BYTES_PER_SEC,
      endSec:   (bytesAtMark - sliceStartBytes) / BYTES_PER_SEC,
    });
    prevBytes = bytesAtMark;
  }
  return windows;
}

/**
 * Convert Voxtral's per-slice segments {text, start, end} to absolute session
 * seconds {text, startSec, endSec}, given where this slice started in the
 * session PCM.
 */
export function relativeToAbsoluteSegments(segments, sliceStartSec) {
  if (!Array.isArray(segments)) return [];
  return segments.map(seg => ({
    text: seg.text,
    startSec: sliceStartSec + seg.start,
    endSec:   sliceStartSec + seg.end,
  }));
}

/**
 * Filter relative-time segments (as returned by Voxtral) by whether their
 * midpoint falls inside [startSec, endSec]. Used to bucket segments across
 * coalesced lineIds.
 */
export function filterSegmentsForWindow(segments, startSec, endSec) {
  if (!Array.isArray(segments)) return [];
  return segments.filter(seg => {
    const mid = (seg.start + seg.end) / 2;
    return mid >= startSec && mid <= endSec;
  });
}

/**
 * Given absolute-time segments {startSec, endSec}, return a tight bounding
 * window {startSec, endSec} padded by padSec on each side. Returns null if
 * there are no segments.
 */
export function segmentsToBounds(segments, padSec = 0) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let start = segments[0].startSec;
  let end = segments[0].endSec;
  for (const seg of segments) {
    if (seg.startSec < start) start = seg.startSec;
    if (seg.endSec > end) end = seg.endSec;
  }
  return {
    startSec: Math.max(0, start - padSec),
    endSec: end + padSec,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/segment-math.test.js`
Expected: PASS, all 10 assertions.

- [ ] **Step 6: Commit**

```bash
git add lib/segment-math.js test/segment-math.test.js
git commit -m "add segment-math helpers for tight audio clipping"
```

---

### Task 2: Capture startOffsetSec from WebSocket deltas

**Files:**
- Modify: `server.js` (delta handler in `startMistral`, `finalizeSentence`, `addLine` call)
- Modify: `lib/sessions.js:addLine` signature
- Test: manual — this flows through live audio; covered by integration check in Task 7

This is the always-on, Phase-2-independent piece.

- [ ] **Step 1: Read current delta & finalize flow**

Read `server.js:336-400` closely. The key facts:
- `sentenceBuffer` accumulates delta text.
- `finalizeSentence(raw)` is called when the buffer hits sentence end or size cap.
- Today `finalizeSentence` captures only `audioOffsetSec = pcmBytesWritten / 32000`.
- The **very first delta of a new utterance** is the one where we want to snapshot the PCM position — that's our start-of-utterance.

- [ ] **Step 2: Extend `lib/sessions.js:addLine` to accept `startOffsetSec`**

Edit `lib/sessions.js:148-165`. Change signature and persist:

```js
function addLine(text, audioOffsetSec, startOffsetSec) {
  if (!activeSession) return null;
  const lineId = activeSession.data.lines.length;
  activeSession.data.lines.push({
    lineId,
    text,
    timestamp: new Date().toISOString(),
    startOffsetSec: startOffsetSec ?? null,
    audioOffsetSec: audioOffsetSec ?? null,
    final: true,
    translation: null,
    segments: [],
    entities: [],
    idioms: [],
    costUsd: 0,
  });
  activeSession.dirty = true;
  return lineId;
}
```

Also extend `updateLine` (line 168-182) so the Phase-2 upgrade path can later write `audioSegments`, `startOffsetSec`, and `endOffsetSec`:

```js
function updateLine(lineId, updates) {
  if (!activeSession) return false;
  const line = activeSession.data.lines[lineId];
  if (!line) return false;
  if (updates.text !== undefined) line.text = updates.text;
  if (updates.translation !== undefined) line.translation = updates.translation;
  if (updates.segments !== undefined) line.segments = updates.segments;
  if (updates.entities !== undefined) line.entities = updates.entities;
  if (updates.idioms !== undefined) line.idioms = updates.idioms;
  if (updates.costUsd !== undefined) line.costUsd = updates.costUsd;
  if (updates.phase1Text !== undefined) line.phase1Text = updates.phase1Text;
  if (updates.phase1Translation !== undefined) line.phase1Translation = updates.phase1Translation;
  if (updates.startOffsetSec !== undefined) line.startOffsetSec = updates.startOffsetSec;
  if (updates.endOffsetSec !== undefined) line.endOffsetSec = updates.endOffsetSec;
  if (updates.audioSegments !== undefined) line.audioSegments = updates.audioSegments;
  activeSession.dirty = true;
  return true;
}
```

- [ ] **Step 3: Snapshot start-of-utterance in `server.js`**

In the `wss.on('connection', ...)` handler, add a new variable next to `sentenceBuffer`:

```js
let sentenceBuffer = '';
let utteranceStartBytes = null;   // ← NEW: pcmBytesWritten at first delta of current utterance
```

In the delta branch (currently `server.js:373-392`), snapshot the start at the first delta of each new utterance:

```js
if (event.type === 'transcription.text.delta') {
  // Snapshot start-of-utterance at the first delta after a finalize (or ever).
  if (utteranceStartBytes === null) {
    utteranceStartBytes = pcmBytesWritten;
  }
  broadcast(event);
  if (captureDeltas) { /* ...existing... */ }
  sentenceBuffer += event.text;
  if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
    sentenceCount++;
    finalizeSentence(sentenceBuffer);
    sentenceBuffer = '';
  } else if (sentenceBuffer.length >= 500) {
    sentenceCount++;
    finalizeSentence(sentenceBuffer);
    sentenceBuffer = '';
  }
}
```

Update `finalizeSentence` (currently `server.js:336-355`) to read and clear the snapshot, and pass it through:

```js
function finalizeSentence(raw) {
  const text = cleanText(raw.trim());
  if (!text) {
    utteranceStartBytes = null; // reset even on empty finalize
    return;
  }
  const audioOffsetSec = pcmBytesWritten > 0
    ? pcmBytesWritten / 32000
    : null;
  const startOffsetSec = utteranceStartBytes !== null
    ? utteranceStartBytes / 32000
    : null;
  utteranceStartBytes = null; // reset for next utterance

  const lineId = sessions.addLine(text, audioOffsetSec, startOffsetSec);
  broadcast({ type: 'transcription.done', lineId, text, audioOffsetSec, startOffsetSec });

  if (lineId !== null) {
    const ctx = sessions.getActive()?.context;
    analyzeCommentary(text, ctx).then(analysis => {
      if (analysis) {
        sessions.updateLine(lineId, analysis);
        broadcast({ type: 'analysis', lineId, text, ...analysis });
      }
    });
    if (pipeline) pipeline.markSentence(lineId, text);
  }
}
```

Also clear the snapshot on the `transcription.done` branch at `server.js:393-399` so a mid-event reset doesn't leak into the next utterance:

```js
} else if (event.type === 'transcription.done') {
  console.log('[capitaliano] Mistral stream ended (transcription.done)');
  if (sentenceBuffer.trim()) {
    sentenceCount++;
    finalizeSentence(sentenceBuffer);
    sentenceBuffer = '';
  }
  utteranceStartBytes = null;
}
```

- [ ] **Step 4: Smoke test — start the server and record a short session**

Run: `npm start` in one terminal, open `http://localhost:3000` in a browser, start a session, speak (or play Italian audio) for 10-20 seconds, stop. Run:

```bash
node -e "const s=JSON.parse(require('fs').readFileSync('sessions/' + require('fs').readdirSync('sessions').filter(f => f.match(/sess_\d+\.json/)).sort().reverse()[0])); console.log(s.lines.slice(0,5).map(l => ({id: l.lineId, startOffsetSec: l.startOffsetSec, audioOffsetSec: l.audioOffsetSec, text: l.text.slice(0, 40)})));"
```

Expected: every recent line has a numeric `startOffsetSec` that is ≤ `audioOffsetSec`, and typically 1-10 seconds less. If `startOffsetSec` is `null` for new lines, the snapshot isn't firing.

**Clean up the test session afterward** (per saved feedback — test artifacts must not pollute the UI):

```bash
ls sessions/sess_*.json | tail -5
# delete the smoke-test session file + its .pcm
rm sessions/sess_<test_id>.json sessions/sess_<test_id>.pcm
# manually edit sessions/index.json to remove the entry, or run:
node -e "const fs=require('fs'); const i=JSON.parse(fs.readFileSync('sessions/index.json')); fs.writeFileSync('sessions/index.json', JSON.stringify(i.filter(s => s.id !== 'sess_<test_id>'), null, 2));"
```

- [ ] **Step 5: Commit**

```bash
git add server.js lib/sessions.js
git commit -m "capture startOffsetSec from first delta of each utterance"
```

---

### Task 3: Request segment timestamps from Voxtral batch

**Files:**
- Modify: `lib/batch.js:184-192` (`transcribeBatch` function)
- Test: `test/batch.test.js` (new `transcribeBatch` behavior is exercised via the pipeline tests in Task 4; no standalone test for this task since it calls the live API)

- [ ] **Step 1: Update `transcribeBatch` signature**

In `lib/batch.js:184-192`, change:

```js
export async function transcribeBatch(wavBuffer, contextBias) {
  const result = await getMistralClient().audio.transcriptions.complete({
    model: 'voxtral-mini-latest',
    file: new Blob([wavBuffer], { type: 'audio/wav' }),
    timestampGranularities: ['segment'],
    ...(contextBias.length > 0 ? { contextBias } : {}),
  });
  return {
    text: result.text || '',
    segments: Array.isArray(result.segments) ? result.segments : [],
  };
}
```

Key changes from today:
1. **Drop `language: 'it'`** — confirmed incompatible with `timestampGranularities` (probe got HTTP 503 overflow; autodetect produced identical Italian text on the same audio).
2. **Add `timestampGranularities: ['segment']`** — typed SDK field (`node_modules/@mistralai/mistralai/src/models/components/audiotranscriptionrequest.ts:40`).
3. **Return shape changes from `{text}` to `{text, segments}`** — callers in `submitBatch` need to handle the new field (done in Task 4).

`contextBias` stays; it's orthogonal to timestamps.

- [ ] **Step 2: Verify `submitBatch` still compiles with the new return shape**

At `lib/batch.js:63-68`, `submitBatch` already does:

```js
const batchResult = await transcribeFn(wavBuffer);
if (!batchResult || !batchResult.text) return;
```

That code is untouched by Task 3 — `batchResult.text` still works, `batchResult.segments` is ignored for now. The `markers`/`sliceStartBytes` plumbing and the consumption of `batchResult.segments` both land in Task 4. **No code change to `submitBatch` in this task.**

- [ ] **Step 3: Update existing batch tests to use the new return shape**

In `test/batch.test.js`, every `transcribeFn` mock currently returns `{ text: '...' }`. Leave them alone — the new code reads `batchResult.text` the same way. The tests should still pass because `batchResult.segments` being undefined is handled.

- [ ] **Step 4: Run existing tests**

Run: `node --test test/batch.test.js`
Expected: PASS (no behavioral change; the return shape is a superset).

- [ ] **Step 5: Commit**

```bash
git add lib/batch.js
git commit -m "request segment timestamps from Voxtral batch"
```

---

### Task 4: Track slice boundaries and split segments across coalesced lines

**Files:**
- Modify: `lib/batch.js` — `createBatchPipeline` options + `pushChunk` + `markSentence` + `submitBatch`
- Modify: `server.js:294-310` — pass a `getSessionPcmBytes` getter into `createBatchPipeline`
- Test: `test/batch.test.js` — add coverage for the new segment passthrough

This is the central task. Keep the existing accumulate-coalesce flow; add byte-offset tracking on top of it.

- [ ] **Step 1: Read Task 1's `segment-math.js` and re-read `lib/batch.js`**

You need to hold both files in mind for this task.

- [ ] **Step 2: Write the failing test — single-line batch attaches segments**

Append to `test/batch.test.js` inside the `describe('BatchPipeline', ...)` block:

```js
it('attaches absolute audioSegments to a single-line batch upgrade', async () => {
  const upgrades = [];
  let sessionPcmBytes = 0;
  const pipeline = createBatchPipeline({
    getSessionPcmBytes: () => sessionPcmBytes,
    contextBias: [],
    onUpgrade: (lineId, result) => upgrades.push({ lineId, result }),
    transcribeFn: async () => ({
      text: 'ciao mondo',
      // Voxtral returns seconds relative to the submitted WAV.
      segments: [
        { text: 'ciao',  start: 0.6, end: 1.0 },
        { text: 'mondo', start: 1.1, end: 1.7 },
      ],
    }),
    mergeFn: async (_rt, batchText) => ({
      text: batchText, translation: 'hello world',
      segments: [], entities: [], idioms: [], costUsd: 0.001,
    }),
  });

  // Simulate the session having written 10s of PCM already (byte 320000),
  // then push 12s of chunks that represent seconds 10..22.
  sessionPcmBytes = 320000;
  const chunkSize = 8192;
  const chunksFor12s = Math.ceil(384000 / chunkSize);
  for (let i = 0; i < chunksFor12s; i++) {
    pipeline.pushChunk(Buffer.alloc(chunkSize));
    sessionPcmBytes += chunkSize;
  }
  pipeline.markSentence(0, 'original text');
  await pipeline.flush();

  assert.equal(upgrades.length, 1);
  const { audioSegments } = upgrades[0].result;
  assert.ok(Array.isArray(audioSegments));
  assert.equal(audioSegments.length, 2);
  // Converted to absolute session seconds: slice started at 10s in, so
  // relative 0.6 → absolute 10.6.
  assert.equal(audioSegments[0].text, 'ciao');
  assert.ok(Math.abs(audioSegments[0].startSec - 10.6) < 0.01);
  assert.ok(Math.abs(audioSegments[0].endSec - 11.0) < 0.01);
  assert.ok(Math.abs(audioSegments[1].startSec - 11.1) < 0.01);
});

it('splits audioSegments across two coalesced lines by relative midpoint', async () => {
  const upgrades = [];
  let sessionPcmBytes = 0;
  const pipeline = createBatchPipeline({
    getSessionPcmBytes: () => sessionPcmBytes,
    contextBias: [],
    onUpgrade: (lineId, result) => upgrades.push({ lineId, result }),
    transcribeFn: async () => ({
      text: 'uno due tre quattro',
      // 20s slice with four word-ish segments — two before the 10s boundary,
      // two after.
      segments: [
        { text: 'uno',     start: 0.5, end: 1.0 },
        { text: 'due',     start: 4.0, end: 4.6 },
        { text: 'tre',     start: 11.0, end: 11.6 },
        { text: 'quattro', start: 18.0, end: 18.8 },
      ],
    }),
    mergeFn: async (_rt, batchText) => ({
      text: batchText, translation: batchText,
      segments: [], entities: [], idioms: [], costUsd: 0.001,
    }),
    splitAnalyzeFn: async (_batchText, originals) =>
      originals.map(() => ({
        text: 'split', translation: 'split',
        segments: [], entities: [], idioms: [], costUsd: 0.001,
      })),
  });

  // Slice starts at byte 0 (sessionPcmBytes=0).
  sessionPcmBytes = 0;
  const chunkSize = 8192;
  // First line: push 5s of audio, then mark.
  const chunksFor5s = Math.ceil(160000 / chunkSize);
  for (let i = 0; i < chunksFor5s; i++) {
    pipeline.pushChunk(Buffer.alloc(chunkSize));
    sessionPcmBytes += chunkSize;
  }
  pipeline.markSentence(0, 'first line');
  // Second line: push 15s more of audio, then mark (triggers coalesced submit
  // because total >10s threshold).
  const chunksFor15s = Math.ceil(480000 / chunkSize);
  for (let i = 0; i < chunksFor15s; i++) {
    pipeline.pushChunk(Buffer.alloc(chunkSize));
    sessionPcmBytes += chunkSize;
  }
  pipeline.markSentence(1, 'second line');
  await pipeline.flush();

  assert.equal(upgrades.length, 2);

  // Line 0's window is [0s, 5s] relative to slice. Segments 'uno' (0.75 mid)
  // and 'due' (4.3 mid) belong to it. Their absolute seconds are unchanged
  // because the slice started at 0.
  const a = upgrades.find(u => u.lineId === 0).result.audioSegments;
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(s => s.text), ['uno', 'due']);

  // Line 1's window is [5s, 20s]. 'tre' (11.3 mid) and 'quattro' (18.4 mid).
  const b = upgrades.find(u => u.lineId === 1).result.audioSegments;
  assert.equal(b.length, 2);
  assert.deepEqual(b.map(s => s.text), ['tre', 'quattro']);
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `node --test test/batch.test.js`
Expected: FAIL — `audioSegments` is undefined on the upgrade result, the coalesced test fails because `getSessionPcmBytes` isn't consumed.

- [ ] **Step 4: Implement byte tracking in `lib/batch.js`**

Rewrite the top of `createBatchPipeline` and the flow through `pushChunk` / `markSentence` / `submitBatch` to track slice boundaries. Full replacement for the relevant functions:

```js
export function createBatchPipeline(options) {
  const {
    onUpgrade,
    transcribeFn,
    mergeFn,
    splitAnalyzeFn,
    getSessionPcmBytes,  // <-- NEW: () => current session pcmBytesWritten
  } = options;

  let chunks = [];
  let totalBytes = 0;
  // Byte offset in session PCM where the current accumulator started.
  let sliceStartBytes = null;
  // Marker list for lines currently in the accumulator.
  let markers = [];          // Array<{lineId, bytesAtMark}>
  let pending = null;        // { audioChunks, lineIds, originalTexts, markers, sliceStartBytes }
  const inflight = new Set();

  function currentSessionBytes() {
    return typeof getSessionPcmBytes === 'function' ? getSessionPcmBytes() : 0;
  }

  function pushChunk(chunk) {
    if (sliceStartBytes === null) {
      // First chunk of a new slice. Mark where this slice begins in the
      // session PCM (before this chunk is written).
      sliceStartBytes = currentSessionBytes();
    }
    chunks.push(chunk);
    totalBytes += chunk.length;
    if (totalBytes > MAX_AUDIO_BYTES) {
      console.warn('[capitaliano] Audio buffer exceeded 1MB without markSentence, discarding');
      chunks = [];
      totalBytes = 0;
      markers = [];
      sliceStartBytes = null;
      pending = null;
    }
  }

  function extractAudio() {
    const buffer = totalBytes > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    const bytes = totalBytes;
    const extractedMarkers = markers;
    const extractedStart = sliceStartBytes;
    chunks = [];
    totalBytes = 0;
    markers = [];
    sliceStartBytes = null;
    return { buffer, bytes, markers: extractedMarkers, sliceStartBytes: extractedStart };
  }

  function flushPendingWith(audioBuffer, lineId, originalText, bytes, extractedMarkers, extractedSliceStart) {
    pending.audioChunks.push(audioBuffer);
    // Markers from the new extraction are already absolute byte positions;
    // concat them onto pending's existing markers. sliceStartBytes stays at
    // pending's original value (the earliest slice start).
    pending.markers.push(...extractedMarkers);
    pending.lineIds.push(lineId);
    pending.originalTexts.push(originalText || '');
    const merged = pending;
    pending = null;
    submitBatch(
      Buffer.concat(merged.audioChunks),
      merged.lineIds,
      merged.originalTexts,
      merged.markers,
      merged.sliceStartBytes,
    );
  }

  function markSentence(lineId, originalText) {
    // Record this marker against the current (still-open) slice before
    // extracting. bytesAtMark is the session pcm position RIGHT NOW.
    markers.push({ lineId, bytesAtMark: currentSessionBytes() });

    const { buffer: audioBuffer, bytes, markers: extractedMarkers, sliceStartBytes: extractedStart } = extractAudio();

    if (pending) {
      // Always merge with pending, regardless of length
      flushPendingWith(audioBuffer, lineId, originalText, bytes, extractedMarkers, extractedStart);
    } else if (bytes < COALESCE_THRESHOLD) {
      // Short utterance, no pending — start coalescing
      pending = {
        audioChunks: [audioBuffer],
        lineIds: [lineId],
        originalTexts: [originalText || ''],
        markers: extractedMarkers,
        sliceStartBytes: extractedStart,
      };
    } else {
      // Long utterance, no pending — submit directly
      submitBatch(audioBuffer, [lineId], [originalText || ''], extractedMarkers, extractedStart);
    }
  }
```

And replace `submitBatch` to compute per-line segment assignments:

```js
  async function submitBatch(audioBuffer, lineIds, originalTexts, sliceMarkers, sliceStartBytes) {
    const wavBuffer = pcmToWav(audioBuffer, 16000);
    const promise = (async () => {
      try {
        const batchResult = await transcribeFn(wavBuffer);
        if (!batchResult || !batchResult.text) return;

        const relSegments = Array.isArray(batchResult.segments) ? batchResult.segments : [];
        const sliceStartSec = (sliceStartBytes ?? 0) / 32000;

        if (lineIds.length === 1) {
          const analysis = await mergeFn(originalTexts[0], batchResult.text);
          if (analysis) {
            analysis.audioSegments = relativeToAbsoluteSegments(relSegments, sliceStartSec);
            onUpgrade(lineIds[0], analysis);
          }
        } else if (splitAnalyzeFn) {
          const results = await splitAnalyzeFn(batchResult.text, originalTexts);
          if (results && results.length === lineIds.length) {
            const costEach = results.reduce((s, r) => s + (r.costUsd || 0), 0) / lineIds.length;
            const windows = computeLineWindows(sliceMarkers || [], sliceStartBytes ?? 0);
            for (let i = 0; i < lineIds.length; i++) {
              results[i].costUsd = costEach;
              const window = windows[i];
              const relForLine = window
                ? filterSegmentsForWindow(relSegments, window.startSec, window.endSec)
                : [];
              results[i].audioSegments = relativeToAbsoluteSegments(relForLine, sliceStartSec);
              onUpgrade(lineIds[i], results[i]);
            }
          } else {
            console.warn('[capitaliano] splitAndAnalyze returned wrong count, falling back');
            const analysis = await mergeFn(originalTexts[0], batchResult.text);
            if (analysis) {
              analysis.audioSegments = relativeToAbsoluteSegments(relSegments, sliceStartSec);
              onUpgrade(lineIds[0], analysis);
            }
          }
        }
      } catch (err) {
        console.error(`[capitaliano] Batch upgrade failed for lines ${lineIds.join(',')}: ${err.message}`);
      }
    })();

    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }
```

Also update the `flush` function — it currently submits pending without markers:

```js
  async function flush() {
    if (pending) {
      submitBatch(
        Buffer.concat(pending.audioChunks),
        pending.lineIds,
        pending.originalTexts,
        pending.markers,
        pending.sliceStartBytes,
      );
      pending = null;
    }
    if (inflight.size > 0) { /* ...unchanged... */ }
  }
```

Add these imports at the top of `lib/batch.js`:

```js
import {
  computeLineWindows,
  filterSegmentsForWindow,
  relativeToAbsoluteSegments,
} from './segment-math.js';
```

- [ ] **Step 5: Wire `getSessionPcmBytes` in `server.js`**

At `server.js:294-310`, pass the getter:

```js
const pipeline = phase2Enabled ? createBatchPipeline({
  contextBias: [],
  getSessionPcmBytes: () => pcmBytesWritten,
  onUpgrade: (lineId, result) => {
    const active = sessions.getActive();
    const line = active?.lines?.[lineId];
    const phase1 = (line && !line.phase1Text)
      ? { phase1Text: line.text, phase1Translation: line.translation }
      : {};
    sessions.updateLine(lineId, { ...phase1, ...result });
    broadcast({ type: 'analysis.upgrade', lineId, ...result });
  },
  transcribeFn: (wavBuffer) => transcribeBatch(wavBuffer, getContextBias()),
  mergeFn: (realtimeText, batchText, _ctx) =>
    mergeAndAnalyze(realtimeText, batchText, sessions.getActive()?.context),
  splitAnalyzeFn: (batchText, originals, _ctx) =>
    splitAndAnalyze(batchText, originals, sessions.getActive()?.context),
}) : null;
```

`sessions.updateLine` already knows how to persist `audioSegments` from Task 2.

- [ ] **Step 6: CRITICAL — fix the `pushChunk` vs `pcmBytesWritten` ordering in the ws message handler**

Today `server.js:457-463` increments `pcmBytesWritten` **before** calling `pipeline.pushChunk(data)`. That breaks the `sliceStartBytes = getSessionPcmBytes()` capture in Task 4's `pushChunk`: by the time the pipeline asks for the current byte count, the chunk has already been counted, so the slice start is overstated by one chunk's worth of bytes (typically ~8KB / ~0.25s). All downstream segment→absolute-seconds conversions drift by that amount.

Reorder the block so `pipeline.pushChunk` runs BEFORE the increment. The current code looks like:

```js
if (pcmStream) {
  const buf = Buffer.from(data);
  pcmStream.write(buf);
  pcmBytesWritten += buf.length;
}

if (pipeline) pipeline.pushChunk(data);
```

Change to:

```js
if (pipeline) pipeline.pushChunk(data);

if (pcmStream) {
  const buf = Buffer.from(data);
  pcmStream.write(buf);
  pcmBytesWritten += buf.length;
}
```

This matches the ordering assumed by the test fixtures in Step 2 (`pushChunk` first, then `sessionPcmBytes += chunkSize`).

**Do NOT** try to compensate inside `pushChunk` by subtracting the chunk length — that's fragile if `pcmStream` is ever not open when the pipeline is running.

- [ ] **Step 7: Run the batch tests**

Run: `node --test test/batch.test.js`
Expected: all 6 tests PASS (3 original + 2 new + 1 existing coalesce test).

- [ ] **Step 8: Commit**

```bash
git add lib/batch.js server.js test/batch.test.js
git commit -m "track slice boundaries and split Voxtral segments per coalesced line"
```

---

### Task 5: Per-line tight audio endpoint

**Files:**
- Modify: `server.js` — add route + matcher, factor PCM-reading into a helper so the new endpoint can share it
- Modify: `test/audio-endpoint.test.js` — add tests

The existing `/api/sessions/:id/audio?from=&to=` stays as the low-level raw-range endpoint. The new `/api/sessions/:id/lines/:lineId/audio[?tight=1&padMs=100]` is a convenience that picks the best window from the line data.

- [ ] **Step 1: Write the failing tests**

The existing `test/audio-endpoint.test.js` already defines a `writeFakePcm(sessionId, durationSec)` helper at the top of the file that writes `durationSec * 32000` bytes of mono PCM16 @ 16kHz. Reuse it as-is.

Append to `test/audio-endpoint.test.js`:

```js
import { mkdir, writeFile as wf, unlink as rm, rename as rn } from 'node:fs/promises';

describe('GET /api/sessions/:id/lines/:lineId/audio', () => {
  const fakeId = 'sess_9999999998';
  let originalIndex;

  before(async () => {
    await writeFakePcm(fakeId, 30);
    // Read current index, save a copy, splice in a fake session entry.
    const fs = await import('node:fs/promises');
    originalIndex = await fs.readFile('sessions/index.json', 'utf-8');
    const idx = JSON.parse(originalIndex);
    idx.push({ id: fakeId, name: 'fixture', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), lineCount: 3 });
    await fs.writeFile('sessions/index.json', JSON.stringify(idx, null, 2));

    // Session file with three lines, each exercising a different window source.
    const sessionData = {
      id: fakeId,
      name: 'fixture',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      context: null,
      lines: [
        // Line 0: has audioSegments (tightest source).
        {
          lineId: 0, text: 'uno', timestamp: new Date().toISOString(),
          startOffsetSec: 0.5, audioOffsetSec: 5.0, final: true, translation: null,
          segments: [], entities: [], idioms: [], costUsd: 0,
          audioSegments: [
            { text: 'uno', startSec: 1.0, endSec: 2.5 },
          ],
        },
        // Line 1: has startOffsetSec + audioOffsetSec but no audioSegments.
        {
          lineId: 1, text: 'due', timestamp: new Date().toISOString(),
          startOffsetSec: 10.0, audioOffsetSec: 14.0, final: true, translation: null,
          segments: [], entities: [], idioms: [], costUsd: 0,
        },
        // Line 2: legacy line — only audioOffsetSec.
        {
          lineId: 2, text: 'tre', timestamp: new Date().toISOString(),
          audioOffsetSec: 22.0, final: true, translation: null,
          segments: [], entities: [], idioms: [], costUsd: 0,
        },
      ],
    };
    await wf(`sessions/${fakeId}.json`, JSON.stringify(sessionData));
  });

  after(async () => {
    try { await rm(`sessions/${fakeId}.json`); } catch {}
    try { await rm(`sessions/${fakeId}.pcm`); } catch {}
    // Restore original index.
    if (originalIndex !== undefined) {
      const fs = await import('node:fs/promises');
      await fs.writeFile('sessions/index.json', originalIndex);
    }
  });

  it('uses audioSegments bounds when available, padded by padMs', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/lines/0/audio?padMs=100`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    // Segment window is [1.0, 2.5], padded by 0.1s each side → [0.9, 2.6] = 1.7s.
    // WAV bytes = 1.7 * 32000 + 44 = 54400 + 44 = 54444
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 54444);
  });

  it('falls back to startOffsetSec..audioOffsetSec when no audioSegments', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/lines/1/audio?padMs=0`);
    assert.equal(res.status, 200);
    // Window [10.0, 14.0] = 4s. WAV bytes = 4 * 32000 + 44 = 128044.
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 128044);
  });

  it('falls back to a default pre-roll window for legacy lines (only audioOffsetSec)', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/lines/2/audio?padMs=0`);
    assert.equal(res.status, 200);
    // Legacy fallback: 5 seconds ending at audioOffsetSec (22.0) → [17.0, 22.0] = 5s.
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 5 * 32000 + 44);
  });

  it('404s when the line does not exist', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/lines/99/audio`);
    assert.equal(res.status, 404);
  });

  it('404s when the session does not exist', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/sess_0000000001/lines/0/audio`);
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Start the server in another terminal: `npm start`. Then:

Run: `node --test test/audio-endpoint.test.js`
Expected: FAIL — the new `/lines/:lineId/audio` route returns 404 for everything.

- [ ] **Step 3: Implement the endpoint**

In `server.js`, add a new regex constant near the other `RE_*` constants:

```js
const RE_SESSION_LINE_AUDIO = /^\/api\/sessions\/(sess_\d+)\/lines\/(\d+)\/audio$/;
```

Add a helper near `sendJson` that serves a PCM window (extracted from the existing inline logic at `server.js:139-178`). `open`, `stat`, `pcmToWav`, and `resolve` are already imported at the top of `server.js` — no new imports needed for this helper:

```js
async function servePcmWindow(res, pcmPath, fromSec, toSec) {
  let fileSize;
  try {
    const s = await stat(pcmPath);
    fileSize = s.size;
  } catch {
    return sendJson(res, 404, { error: 'No audio for this session' });
  }

  let startByte = Math.floor(fromSec * 16000) * 2;
  let endByte = Math.floor(toSec * 16000) * 2;
  startByte = Math.max(0, Math.min(startByte, fileSize));
  endByte = Math.max(startByte, Math.min(endByte, fileSize));

  const length = endByte - startByte;
  const fd = await open(pcmPath, 'r');
  const pcmData = Buffer.alloc(length);
  await fd.read(pcmData, 0, length, startByte);
  await fd.close();

  const wav = pcmToWav(pcmData, 16000);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': wav.length,
  });
  res.end(wav);
}
```

Refactor the existing `/api/sessions/:id/audio` handler to use `servePcmWindow` (kept for back-compat):

```js
const audioMatch = urlPath.match(RE_SESSION_AUDIO);
if (audioMatch && req.method === 'GET') {
  const id = audioMatch[1];
  const pcmPath = resolve('sessions', `${id}.pcm`);
  const params = new URL(req.url, 'http://localhost').searchParams;
  const fromSec = parseFloat(params.get('from')) || 0;
  let toSec;
  if (params.get('to') !== null) {
    toSec = parseFloat(params.get('to'));
  } else {
    // Legacy behavior: read to end of file
    try {
      const s = await stat(pcmPath);
      toSec = s.size / 32000;
    } catch {
      return sendJson(res, 404, { error: 'No audio for this session' });
    }
  }
  return servePcmWindow(res, pcmPath, fromSec, toSec);
}
```

Add the new per-line handler **above** the generic `/api/sessions/:id` matcher (the generic one is too greedy — place this first):

```js
const lineAudioMatch = urlPath.match(RE_SESSION_LINE_AUDIO);
if (lineAudioMatch && req.method === 'GET') {
  const [, sessId, lineIdStr] = lineAudioMatch;
  const lineId = parseInt(lineIdStr, 10);
  const pcmPath = resolve('sessions', `${sessId}.pcm`);

  let session;
  try {
    session = await sessions.get(sessId);
  } catch {
    return sendJson(res, 404, { error: 'Session not found' });
  }
  const line = session.lines?.[lineId];
  if (!line) {
    return sendJson(res, 404, { error: 'Line not found' });
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const padMs = parseFloat(params.get('padMs'));
  const padSec = Number.isFinite(padMs) ? padMs / 1000 : 0.1; // default 100ms

  // Prefer audioSegments → tightest. Fall back to [startOffsetSec, audioOffsetSec].
  // Legacy fallback: 5s pre-roll ending at audioOffsetSec.
  let fromSec, toSec;
  if (Array.isArray(line.audioSegments) && line.audioSegments.length > 0) {
    const bounds = segmentsToBounds(line.audioSegments, padSec);
    fromSec = bounds.startSec;
    toSec = bounds.endSec;
  } else if (typeof line.startOffsetSec === 'number' && typeof line.audioOffsetSec === 'number') {
    fromSec = Math.max(0, line.startOffsetSec - padSec);
    toSec = line.audioOffsetSec + padSec;
  } else if (typeof line.audioOffsetSec === 'number') {
    // Legacy fallback — old sessions only have the end offset. Give a 5s
    // pre-roll with no extra pad (the window is already deliberately loose).
    fromSec = Math.max(0, line.audioOffsetSec - 5);
    toSec = line.audioOffsetSec;
  } else {
    return sendJson(res, 404, { error: 'Line has no audio timing' });
  }

  return servePcmWindow(res, pcmPath, fromSec, toSec);
}
```

Add the import at the top of `server.js`:

```js
import { segmentsToBounds } from './lib/segment-math.js';
```

- [ ] **Step 4: Run all audio endpoint tests**

Make sure the server is running (`npm start`). Then:

Run: `node --test test/audio-endpoint.test.js`
Expected: all tests PASS (5 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add server.js test/audio-endpoint.test.js
git commit -m "add per-line tight audio endpoint"
```

---

### Task 6: Full verification against a real session

**Files:** no code changes — this is empirical verification.

- [ ] **Step 1: Run the whole test suite**

Run: `node --test test/`
Expected: all tests PASS across the project.

- [ ] **Step 2: Live smoke test with Phase 2 enabled**

Run:

```bash
CAPITO_PHASE2=1 npm start
```

Open the UI, start a new test session named "tight-clip-smoke", speak (or play) Italian audio for ~30-60 seconds with several distinct phrases. End the session.

- [ ] **Step 3: Inspect the produced session file**

```bash
node -e "
const fs = require('fs');
const path = 'sessions/' + fs.readdirSync('sessions')
  .filter(f => f.match(/sess_\\d+\\.json/))
  .sort().reverse()[0];
const s = JSON.parse(fs.readFileSync(path));
console.log('session:', s.id, s.name);
for (const l of s.lines.slice(0, 5)) {
  console.log({
    lineId: l.lineId,
    startOffsetSec: l.startOffsetSec,
    audioOffsetSec: l.audioOffsetSec,
    audioSegments: l.audioSegments?.slice(0, 2),
    text: l.text.slice(0, 60),
  });
}"
```

Expected:
- Every line has a numeric `startOffsetSec` ≤ `audioOffsetSec` (from Task 2).
- Most lines have a populated `audioSegments` array (from Task 4), each entry with `startSec`/`endSec` that fall inside `[startOffsetSec - 1, audioOffsetSec + 1]` roughly. (If no `audioSegments`, the batch pipeline may not have flushed for that line — acceptable if the line was very short.)

- [ ] **Step 4: Fetch a tight clip and sanity-check it**

```bash
# Replace <session_id> and <lineId>.
curl -o /tmp/clip.wav 'http://localhost:3000/api/sessions/<session_id>/lines/<lineId>/audio?padMs=100'
afplay /tmp/clip.wav
```

Expected: the clip starts near the first spoken word of the chosen phrase and ends near the last, with ≤~200ms of leading/trailing silence. Compare to the fuzzy window you'd get from the existing `?from=&to=` endpoint with a conservative 5s window — the new clip should be noticeably tighter.

- [ ] **Step 5: Clean up the smoke-test session**

```bash
# Find the id.
ls -t sessions/sess_*.json | head -1
# Delete json + pcm.
rm sessions/sess_<smoke_id>.json sessions/sess_<smoke_id>.pcm
# Remove from index (edit manually, or use jq / node).
node -e "
const fs = require('fs');
const id = 'sess_<smoke_id>';
const idx = JSON.parse(fs.readFileSync('sessions/index.json'));
fs.writeFileSync('sessions/index.json', JSON.stringify(idx.filter(s => s.id !== id), null, 2));
"
```

Per saved feedback: test artifacts must not pollute the UI. Verify with a quick `cat sessions/index.json | grep smoke` — should be empty.

- [ ] **Step 6: Commit (docs only, no-op if nothing changed)**

No commit required unless you made fixes along the way.

---

## Notes for the executor

- **DO NOT add backwards-compatibility shims** for sessions recorded before this change. The per-line endpoint's fallback chain (audioSegments → start+end → legacy 5s pre-roll) is exactly enough; no migration needed.
- **DO NOT remove `language: 'it'` anywhere else** — it only goes away from `transcribeBatch`. The realtime websocket path (`server.js:357-418`) does not pass `language` either, so nothing to change there.
- **DO NOT touch `line.segments`** — that's the translation text splits field owned by `normalizeAnalysis` in `lib/translate.js`. The new field is `line.audioSegments`.
- **DO NOT attempt word-level granularity.** The probe showed segment-level is already phrase-tight and word-level costs ~6× more completion tokens.
- **If `test/audio-endpoint.test.js` fails with `ECONNREFUSED`**, you forgot to start the server in another terminal. These are live HTTP tests, not mocks.
- **If Phase 2 tests fail because `audioSegments` is `undefined`**, check that `getSessionPcmBytes` is being passed into `createBatchPipeline` (Task 4 Step 5) — that's the most likely miss.
- **Reference skill:** @superpowers:test-driven-development for the failing-test-first loop. @superpowers:verification-before-completion before claiming any task done — specifically, run the exact test command and confirm PASS in the output.

---

## What this unlocks

After this plan ships, an Anki export follow-up becomes straightforward:
1. Iterate saved-vocab entries (`sessions/saved-vocab.json`) — each already references a sessionId + lineId in its `source`.
2. For each entry, GET `/api/sessions/:id/lines/:lineId/audio?padMs=100` to grab a tight WAV.
3. Feed sentence text + translation + meaning + audio into a genanki-style `.apkg` generator (Python subprocess or Node port).

That's a separate plan.
