# Two-Phase Transcription — Design Spec

## Overview

Add a second transcription pass using the Mistral Voxtral Batch API with `context_bias`
(squad names) to progressively upgrade realtime transcription. The user sees rough text
immediately from the Realtime API, then text quietly upgrades ~5-10s later with corrected
player names and better entity extraction.

## Architecture

### Data flow

```
Browser PCM chunks (8KB, 256ms each)
  │
  ├─► Mistral Realtime (existing)
  │     → sentence segmentation in server.js
  │     → addLine() + broadcast transcription.done
  │     → Haiku translation (phase 1) → broadcast analysis
  │
  └─► BatchPipeline (new, lib/batch.js)
        → pushChunk(): appends to growing audio buffer
        → markSentence(lineId): triggered by finalizeSentence()
            → extract audio since last mark
            → coalesce if <3s with next sentence
            → pcmToWav() → POST /v1/audio/transcriptions
                with context_bias + stream:true
            → Haiku re-translation (phase 2)
            → sessions.updateLine() + broadcast analysis.upgrade
```

The two paths are fully independent — realtime never waits for batch, batch never
blocks realtime. Both read from the same chunk stream via two consecutive function
calls in the WebSocket message handler.

### Adaptive batching via realtime sentence boundaries

Instead of fixed time windows, batch boundaries are driven by the realtime
transcription's sentence detection. When `finalizeSentence()` fires (Mistral Realtime
detected a complete thought), the audio for that utterance is extracted and sent to
the batch API.

This approach:
- Aligns batch windows with natural speech rhythm (3-15s for football commentary)
- Maximizes context_bias effectiveness (full sentence context for name resolution)
- Gives 1:1 mapping between realtime lines and batch results
- Avoids mid-sentence splits that degrade ASR accuracy

**Coalescing**: Utterances shorter than 3s (~96KB of PCM) are held and merged with the
next sentence. The merged batch result is split back to original line boundaries by
Haiku (see Batch-to-line matching below).

### Audio buffer lifecycle

The `chunks[]` array in `batch.js` grows as audio arrives. When `markSentence()` fires,
it records a `lastMarkOffset` (cumulative byte count at the previous mark) and extracts
only the chunks between `lastMarkOffset` and the current position. Extracted chunks are
dropped from the array (spliced out) and concatenated into a WAV for the batch call.
This keeps memory bounded to the audio between the last two sentence boundaries — typically
3-15s (~96-480KB).

**Max audio cap**: If no `markSentence()` fires and the pending audio exceeds 1MB (~30s),
the pipeline logs a warning, clears the entire `chunks[]` array, and resets
`lastMarkOffset` to 0 — effectively discarding the unmatched audio. This handles edge
cases like long crowd noise or mic silence where the text accumulator's 500-char ceiling
never triggers because no text arrives. No offset arithmetic is needed since both
counters reset together.

## Module structure

### `lib/audio.js` (~40 lines)

Pure utility, no state.

- `pcmToWav(buffer, sampleRate)` — wraps raw PCM16 in a 44-byte WAV header, returns
  a Buffer ready to POST. No ffmpeg dependency.

### `lib/batch.js` (~120 lines)

- `createBatchPipeline(options)` — factory returning a pipeline object
  - Options: `contextBias` (string[]), `onUpgrade` (callback)
- Pipeline API:
  - `pushChunk(chunk)` — appends to current audio window
  - `markSentence(lineId)` — extracts audio since last mark, fires async batch
    transcription + Haiku re-translation
  - `flush()` — process any remaining audio on disconnect
- Internal state: `chunks[]` array with `lastMarkOffset`, byte counter, pending
  short-utterance buffer with `lineIds[]` for coalescing, `inflight` Set tracking
  active batch requests

### `server.js` changes

- Import and wire up batch pipeline in the WebSocket connection handler
- Feed each audio chunk to both Mistral Realtime AND `pipeline.pushChunk(chunk)`
- In `finalizeSentence()`, also call `pipeline.markSentence(lineId)`
- `onUpgrade` callback: `sessions.updateLine()` + `broadcast({ type: 'analysis.upgrade', ... })`
- On WS close: `await pipeline.flush()` before closing Mistral connection
- Simplify sentence accumulator (see below)

### `lib/translate.js` changes

- `analyzeCommentary()` — unchanged, called by both realtime and batch paths
- New: `splitAndAnalyze(batchText, originalTexts[], matchContext)` — for coalesced
  lines, splits batch result back to original line boundaries via Haiku

### `public/app.js` changes

- Handle new `analysis.upgrade` event type
- In-viewport lines: 200ms cross-fade animation
- Off-screen lines: silent update
- Never reflow (insert/delete lines) — only in-place text/entity/translation updates

### `lib/sessions.js` changes

- `updateLine()` must also accept and persist a `text` field, so phase 2's corrected
  Italian text is saved to the session JSON. Add: `if (updates.text !== undefined)
  line.text = updates.text;`

## Sentence accumulator simplification

Remove the comma-split logic from `server.js`. Current code has three paths; new code
has two:

```js
// Path 1: clean sentence end (>40 chars + sentence-ending punctuation)
if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
}
// Path 2: safety ceiling (replaces old 300-char comma-split)
else if (sentenceBuffer.length >= 500) {
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
}
```

The 500-char ceiling (~30s of speech) is generous enough to almost never fire. It
exists only as a safety net for unpunctuated walls of text from Mistral.

## Batch-to-line matching

### Simple case (most lines)

One realtime sentence → one batch call → upgrade targets that `lineId`. Trivial 1:1
mapping.

### Coalesced case (~15% of lines)

Multiple short utterances (<3s each) merged into one batch call. The batch returns a
single improved text covering multiple original lines.

**Resolution via Haiku**: A new function `splitAndAnalyze(batchText, originalTexts[],
matchContext)` in `lib/translate.js` sends the batch result to Haiku with a prompt like:

```
The following Italian text was re-transcribed with improved accuracy:
"[batchText]"

It corresponds to these original lines (preserve this exact split):
1. "[originalText1]"
2. "[originalText2]"

For each line, return a JSON array where each element has the same schema as
analyzeCommentary: {segments, translation, entities, idioms}.
```

Response schema: `Array<{segments, translation, entities, idioms}>` — one entry per
original line. The function validates the array length matches `originalTexts.length`.
On validation failure, falls back to calling `analyzeCommentary()` on the full batch
text and applying the result to the first line only.

This respects the "never reflow" rule and costs one extra Haiku call for coalesced groups.
Cost for the `splitAndAnalyze` call is divided equally across the coalesced `lineIds`.

**Coalescing state machine**: The pending coalesce buffer holds `{chunks, lineIds, bytes}`.
When `markSentence` is called:
1. If pending buffer is empty and this utterance is <3s: store in pending buffer, return
2. If pending buffer has content: merge this utterance into it, submit the combined audio,
   clear the pending buffer
3. If pending buffer is empty and this utterance is >=3s: submit directly

This means at most two utterances are coalesced at once — no unbounded accumulation.
If a third short utterance arrives while a previous coalesced batch is in-flight,
it simply starts a new pending buffer.

## WebSocket protocol

### New event: `analysis.upgrade`

```json
{
  "type": "analysis.upgrade",
  "lineId": 3,
  "text": "Lautaro Martínez riceve palla sulla trequarti",
  "translation": "Lautaro Martínez receives the ball in the final third",
  "segments": [{"it": "...", "en": "..."}],
  "entities": [{"text": "Lautaro Martínez", "type": "player"}],
  "idioms": [],
  "costUsd": 0.0024,
  "phase": 2
}
```

Same shape as `analysis` with a different type so the frontend distinguishes first-pass
from upgrade.

### Frontend upgrade flow

1. Receive `analysis.upgrade` → look up line element by `lineId`
2. Check if line is in viewport (`getBoundingClientRect`)
3. **In viewport**: add `upgrading` CSS class → 200ms cross-fade (opacity 0.4 → 1.0) →
   apply new segments/entities/idioms → remove class
4. **Off-screen**: apply immediately, no animation
5. Update in-memory `currentSession.lines[lineId]`
6. Accumulate cost display (both phase 1 and phase 2 costs)

### CSS

```css
.transcript-line.upgrading {
  animation: upgrade-fade 200ms ease-out;
}
@keyframes upgrade-fade {
  from { opacity: 0.4; }
  to { opacity: 1; }
}
```

No `pending-upgrade` indicator between phase 1 analysis and phase 2 upgrade. The
phase 1 result already gives the user something to read; the upgrade is meant to be
subtle.

## context_bias population

Parse the session's free-text `context` field into a `context_bias` string array.
Parsing happens in `lib/batch.js` at pipeline creation time (reads `getActive().context`),
not in `sessions.js` — avoids coupling session storage to batch-specific logic.

- Split by lines, then by commas/semicolons/colons
- Filter tokens that look like proper nouns (start with uppercase, 2+ characters)
- Include team names, coach names
- Cap at 100 entries (Mistral API limit)

The parsing is heuristic — it extracts proper nouns from the structured text the user
pastes (e.g., the format in `test/fixtures/inter-roma-context.txt`).

**Note**: Italian `context_bias` is marked as experimental by Mistral. Effectiveness
should be validated with the Inter-Roma test fixture.

## Mistral Batch API details

- Endpoint: `POST /v1/audio/transcriptions`
- Model: `voxtral-mini-latest` (alias for the latest batch transcription model; verify
  against `@mistralai/mistralai` SDK at implementation time)
- Parameter: `context_bias` (snake_case, array of strings, max 100)
- Audio format: WAV (PCM16 16kHz mono with 44-byte header)
- Supports up to 3 hours per request
- Use `stream: true` — buffer the streamed response to completion before passing to
  Haiku (single-utterance responses are small, streaming is just the transport)

## Error handling

- **Batch API failure (HTTP 4xx/5xx or timeout)**: Log the error with lineId. Do not
  retry — the phase 1 result stands. The user simply never sees an upgrade for that
  line. No frontend notification needed.
- **Haiku translation failure on phase 2**: Same — log and skip. Phase 1 translation
  remains.
- **`splitAndAnalyze` validation failure** (wrong array length for coalesced lines):
  Fall back to `analyzeCommentary()` on the full batch text, apply result to the first
  lineId only. Log a warning.

## flush() behavior on disconnect

`pipeline.flush()` is called from the WS `close` handler before ending the Mistral
connection:

1. If there is pending audio in the coalesce buffer, submit it as a final batch call
2. Wait for all in-flight batch requests (tracked in `inflight` Set) to settle
   (Promise.allSettled), with a 10s timeout to prevent indefinite hangs if the batch
   API is slow — on timeout, log a warning and proceed with cleanup
3. `updateLine` calls that arrive after `activeSession` is nulled return `false`
   silently (existing behavior) — this is acceptable since the session JSON was already
   flushed to disk by the periodic timer

## Cost

Both translation passes fire for every line:
- Phase 1: Mistral Realtime + Haiku translation
- Phase 2: Mistral Batch + Haiku translation
- ~$0.005/line, ~$1 for a full 90-min match (~200 lines)
- Acceptable for a personal tool

## Testing

- Use `test/fixtures/italian-commentary.mp3` (Inter-Roma highlights) with
  `test/fixtures/inter-roma-context.txt` as match context
- Compare Phase 1-only output vs Phase 1+2 output for entity correction quality
- Measure: time to first text, time to upgrade, entity accuracy improvement

### `test/send-audio.js` changes

- Add `--context <file>` flag that reads a text file and passes it as `context` when
  creating the session (enables testing context_bias with the fixture)
- Log `analysis.upgrade` events alongside existing `analysis` logging, showing the
  phase 1 → phase 2 diff for each line
- Track upgrade latency (time between `transcription.done` and `analysis.upgrade`)
