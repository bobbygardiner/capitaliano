# Audio Trim Widget Design

**Date:** 2026-04-11
**Status:** Draft

## Problem

Audio playback timing for transcript lines and vocab items doesn't always align
perfectly with the actual speech. Line boundaries are determined by when Mistral
finalizes a sentence, not by precise speech onset/offset. Users need a way to
manually adjust clip boundaries — shifting a transcript line's window earlier or
later, or trimming a vocab clip down to just the relevant words.

## Solution

A unified audio trim modal accessible from any transcript line or saved vocab
item. The modal presents an iTunes-style scrubber (no waveform) with draggable
start/end handles, play/pause, time readouts, and save/reset/cancel controls.
The scrubber loads a generous audio window (default clip ± 30s buffer) so users
can extend beyond the auto-detected boundaries.

## Data Model

### Session lines — two new optional fields

```json
{
  "lineId": 3,
  "audioOffsetSec": 42.24,
  "trimStartSec": null,
  "trimEndSec": null
}
```

- `trimStartSec` / `trimEndSec`: absolute session-time seconds.
- When `null`, playback uses the default range
  (`[prevLine.audioOffsetSec, line.audioOffsetSec]`).
- When set, playback uses these values instead.

### Saved vocab sources — same two fields

```json
{
  "sources": [{
    "sessionId": "sess_abc",
    "lineId": 3,
    "audioOffsetSec": 42.24,
    "trimStartSec": null,
    "trimEndSec": null
  }]
}
```

- Vocab trim is independent of the parent line's trim.
- A user might trim a line to clean up timing but trim the vocab entry to just
  one phrase within that line.

### Session object — new field

```json
{
  "id": "sess_abc",
  "totalDurationSec": 6286.4
}
```

- Computed in the WebSocket close handler (where `pcmBytesWritten` is in scope)
  and passed to `sessions.end()` as a new parameter: `sessions.end(sessionId,
  { totalDurationSec: pcmBytesWritten / 32000 })`. The `end()` function persists
  it alongside `endedAt`.
- For existing sessions without this field, compute on-the-fly from PCM file
  size: `fileSize / 32000`.
- Used for buffer clamping and server-side validation.

## API

### New endpoints

| Method | Endpoint | Body | Purpose |
|--------|----------|------|---------|
| `PATCH` | `/api/sessions/:id/lines/:lineId` | `{ trimStartSec, trimEndSec }` | Save trim for a transcript line |
| `PATCH` | `/api/saved-vocab/:id/trim` | `{ sessionId, lineId, trimStartSec, trimEndSec }` | Save trim for a single vocab source |

**Routing notes:**

- `PATCH /api/sessions/:id/lines/:lineId` requires a new regex pattern
  (`RE_SESSION_LINE`) in `server.js`, placed after the existing session route
  patterns.
- `PATCH /api/saved-vocab/:id/trim` uses `/trim` suffix to avoid ambiguity with
  the existing `/api/saved-vocab/remove` fixed path. The `:id` is the vocab
  entry's `sv_*` id. The body identifies which source to update by `sessionId` +
  `lineId` (a vocab entry may have multiple sources). Only the matching source's
  trim fields are updated — the rest of the sources array is untouched.

### Server-side validation

Both endpoints enforce:
- `trimStartSec >= 0`
- `trimEndSec <= totalDurationSec`
- `trimStartSec < trimEndSec`
- `trimEndSec - trimStartSec >= 0.5` (minimum clip duration)
- Setting both to `null` clears the override (resets to default)

### Existing endpoints — no changes

- `GET /api/sessions/:id/audio?from=&to=` already accepts arbitrary `from`/`to`
  values and clamps to file bounds. No modification needed.

## UI

### Entry point: scissors icon

A scissors icon (✂) appears next to the play button on every transcript line and
vocab row that has audio.

- **Gray** (default): no custom trim applied.
- **Accent purple** (#c8a2ff): custom trim has been saved.
- Clicking opens the trim modal.

### Trim modal layout

```
┌─────────────────────────────────────────────────┐
│ Audio Trim — Line 5: "Cercando di imbucare..."  │
│ Edit clip for this line          PSG vs Liverpool│
│                                                  │
│  0:39.2          ▶ 0:41.5              0:47.8   │
│                                                  │
│  ├──────┊┄┄┄[====|====]┄┄┄┊──────────┤          │
│  0:12.2                          1:17.8          │
│                                                  │
│  ┊┄┄┄┊ Default range                            │
│  [===] Your trim                                 │
│  |    Playhead                                   │
│                                                  │
│  [▶ Play Trim]  [Reset]       [Cancel]  [Save]  │
└─────────────────────────────────────────────────┘
```

**Elements:**
- **Header**: context label ("Edit clip for this line" or "Edit clip for
  [expression]") plus session name.
- **Time display**: trim start (left), playhead position (center), trim end
  (right). Tabular numeric font.
- **Scrubber track**: full range = default clip ± 30s buffer, clamped to
  `[0, totalDurationSec]`.
  - Dashed outline = default range.
  - Solid fill = user's trim selection.
  - Purple handles = draggable start/end.
  - White line = playhead.
- **Play Trim**: plays only the trimmed region. Playhead animates across.
- **Reset**: snaps handles back to the default range.
- **Save**: persists `trimStartSec`/`trimEndSec` to server, updates in-memory
  data, closes modal, toggles scissors icon to accent.
- **Cancel**: closes without saving.

### Modal context labels

- Transcript lines: "Edit clip for this line"
- Vocab items: "Edit clip for [expression]"

This makes the independence of line vs. vocab trims obvious.

## Frontend Logic

### `getEffectiveTrim(lineId, session, overrides)` helper

Single source of truth for resolving trim values. Takes a `lineId` and the full
`session` object (to look up the line and its predecessor in `session.lines`).
Optional `overrides` parameter allows passing `{ trimStartSec, trimEndSec }`
from a vocab source, so the same function works for both contexts.

```
function getEffectiveTrim(lineId, session, overrides = {}) {
  const lines = session.lines || [];
  const idx = lines.findIndex(l => l.lineId === lineId);
  const line = lines[idx];
  const prevLine = idx > 0 ? lines[idx - 1] : null;

  const trimStart = overrides.trimStartSec ?? line.trimStartSec;
  const trimEnd = overrides.trimEndSec ?? line.trimEndSec;

  return {
    from: trimStart != null ? trimStart : (prevLine?.audioOffsetSec ?? 0),
    to:   trimEnd != null   ? trimEnd   : line.audioOffsetSec
  };
}
```

For transcript lines: call `getEffectiveTrim(lineId, session)`.
For vocab items: call `getEffectiveTrim(source.lineId, session, source)` where
`source` is the vocab's source object containing its own trim fields.

This helper is used everywhere: normal play button clicks, the trim modal's
initial handle positions, and the "Play Trim" button inside the modal.

### Playback integration

Existing play buttons call `getEffectiveTrim()` instead of the current manual
range calculation. Custom trims automatically apply to normal playback — users
don't need to open the modal to hear their saved trim.

### Modal interaction flow

1. **Open**: compute default range via `getEffectiveTrim()`. Compute buffer
   range as `[defaultStart - 30, defaultEnd + 30]` clamped to
   `[0, totalDurationSec]`. Fetch audio for the buffer range from the REST
   endpoint.
2. **Load**: create blob URL, bind to an `<audio>` element inside the modal.
   Render scrubber: map audio duration to track width.
3. **Interact**: dragging handles updates trim start/end times. Handle positions
   map to absolute session-time seconds. Handles cannot cross each other.
   Minimum gap = 0.5s.
4. **Play Trim**: set `audio.currentTime` to trim start (relative to buffer
   start), play. Use a `timeupdate` listener to pause when `currentTime >=
   trimEnd` (relative to buffer start). The `timeupdate` event fires ~4x/sec
   so clips may overshoot by up to ~250ms — acceptable for this use case.
5. **Save**: `PATCH` to server with `trimStartSec`/`trimEndSec`. Update
   in-memory session/vocab data. Close modal. Toggle scissors icon accent.
6. **Reset**: snap handles to default range positions. Does not save — user
   must still click Save to persist. If the user clicks Reset then Cancel, the
   previously saved trim (if any) remains unchanged on the server.
7. **Cancel**: close modal, discard changes.

## Constraints

- No new dependencies. Vanilla JS, Web Audio API for decoding if needed,
  `<audio>` element for playback.
- No waveform visualization — scrubber is a simple track with handles.
- PCM byte alignment: `floor(sec * 16000) * 2` for all byte offset calculations
  (already correct in the existing audio endpoint).
- Buffer clamped to `[0, totalDurationSec]` — no assumption that 30s is
  available in both directions.

## Migration

- Existing sessions without `trimStartSec`/`trimEndSec` fields work as-is.
  Frontend uses `!= null` checks (covers both `undefined` and `null`).
- Existing sessions without `totalDurationSec` compute it on-the-fly from PCM
  file size.
- No migration script needed.
