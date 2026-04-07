# Audio Preservation with Per-Line Playback — Design

## Overview

Save raw audio during transcription sessions and enable per-line playback. Each
transcript line gets an audio offset so clips can be extracted by byte position
from a single raw PCM file. No compression, no ffmpeg, no new dependencies.

## Audio Storage

When a WebSocket client sends its first binary audio chunk, open a writable file
stream at `sessions/<session-id>.pcm`. Append every subsequent binary chunk to
this file — the same PCM16 16kHz mono data already being sent to Mistral.

Track `sessionAudioStartTime` (the `Date.now()` when the first chunk arrives) so
line offsets can be computed relative to it. Persist this value in the session
JSON as `audioStartedAt` (ISO string) so it survives reconnection.

On reconnection (client disconnects and reconnects to an active session) or
server restart, the file stream is opened lazily on the first audio chunk — the
same code path as initial creation, but opening in append mode when the file
already exists. `sessionAudioStartTime` is restored from the persisted
`audioStartedAt`. This means no special recovery logic is needed in
`sessions.init()` — the "open on first chunk" behavior handles all cases.

On session end or client disconnect, close the file stream. On session delete,
remove the `.pcm` file alongside the `.json`.

The file is append-only, so it is safe to read earlier bytes while still writing
(needed for live playback).

### File format

- Raw PCM16, 16kHz, mono, little-endian
- No header — just concatenated audio samples
- ~1.9 MB/min, ~170 MB for a full match
- Byte offset formula: `byteOffset = Math.floor(seconds × 16000) × 2`
  (multiply before ×2 to guarantee even byte alignment for 16-bit samples)

## Line Audio Offsets

`addLine()` in `sessions.js` currently stores `timestamp` as an ISO date string.
Add a new field `audioOffsetSec` — the number of seconds from the session's first
audio chunk to when the line was finalized.

**Timing note:** `audioOffsetSec` marks when the line was *finalized* (after
Mistral processing + sentence accumulation), not when the speech was originally
spoken. This means the offset points to slightly after the actual speech. This is
acceptable because playback uses `from = previous line's offset` to
`to = this line's offset`, which naturally captures the speech that occurred in
that window. The first line plays from offset 0.

### Computation

`server.js` computes the offset in `finalizeSentence()` where it already calls
`sessions.addLine()`:

```js
const audioOffsetSec = sessionAudioStartTime
  ? (Date.now() - sessionAudioStartTime) / 1000
  : null;
sessions.addLine(text, audioOffsetSec);
```

`addLine()` in `sessions.js` accepts the pre-computed offset as a second
parameter and stores it on the line object. This keeps the sessions module
decoupled from audio timing concerns.

## REST Endpoint

```
GET /api/sessions/:id/audio?from=X&to=Y
```

Where `from` and `to` are seconds (floats). The handler:

1. Resolves the `.pcm` file path: `sessions/<id>.pcm`
2. Returns 404 if the file does not exist (e.g., sessions from before this
   feature, or sessions where no audio was sent)
3. Converts `from`/`to` to byte offsets: `Math.floor(seconds × 16000) × 2`
4. Clamps to actual file size
5. Reads that byte range from the file
6. Prepends a WAV header using the existing `pcmToWav()` from `lib/audio.js`
7. Responds with `Content-Type: audio/wav`

If `to` is omitted, reads to end of file. If `from` is omitted, starts from 0.

Route pattern: `RE_SESSION_AUDIO = /^\/api\/sessions\/(sess_\d+)\/audio$/`

## Frontend Playback

Each finalized transcript line shows a `▶` play icon next to the elapsed
timestamp (e.g., `▶ 12:34`). The icon is always visible, not hidden behind hover.
Only rendered when the line has a non-null `audioOffsetSec`.

### Click behavior

1. Compute `from` = previous line's `audioOffsetSec` (or 0 for the first line),
   `to` = this line's `audioOffsetSec`. This captures the audio window in which
   the speech for this line occurred, since `audioOffsetSec` marks finalization
   (end of the speech window).
2. Fetch `/api/sessions/:id/audio?from=X&to=Y`
3. Create a blob URL from the response and play via a shared `<audio>` element
   (one per page, reused across lines)
4. While playing, the icon switches to `■` (stop). Clicking again stops playback.

### Live vs review

Play buttons appear on all finalized lines, including during live sessions. The
active streaming line (not yet finalized) does not get a play button. Since the
`.pcm` file is append-only, reading earlier bytes during a live session is safe.

### Audio offset data flow

When rendering lines, the frontend needs `audioOffsetSec` for each line:

- **Live lines:** the `transcription.done` WebSocket event includes
  `audioOffsetSec` (added to the existing broadcast in `finalizeSentence()`)
- **Loaded sessions:** `audioOffsetSec` is on each line in the session JSON
- **`createLineElement()`** accepts `audioOffsetSec` as a parameter and renders
  the play button when it is non-null

The client-side session state (`currentSession.lines`) also stores
`audioOffsetSec` so the click handler can look up adjacent line offsets.

## Data Model Changes

### Line object (sessions.js)

New field on each line:

```json
{
  "lineId": 0,
  "text": "...",
  "timestamp": "2026-04-07T18:30:00.000Z",
  "audioOffsetSec": 42.5,
  ...
}
```

### Session JSON

New field on the session object:

```json
{
  "id": "sess_123",
  "audioStartedAt": "2026-04-07T18:29:17.500Z",
  ...
}
```

The `.pcm` file is a sibling of the `.json` file in `sessions/`.

## Interaction with Batch Pipeline

The batch pipeline (`lib/batch.js`) also consumes audio chunks via
`pushChunk()`. These are independent consumers — the `.pcm` file captures all
audio contiguously, while the batch pipeline buffers and resets per sentence.
No interference between them.

## Files Modified

- `server.js` — open PCM file stream on first audio chunk (append mode if file
  exists), append chunks, track `sessionAudioStartTime`, persist as
  `audioStartedAt`, compute offset in `finalizeSentence()` and pass to
  `addLine()`, include `audioOffsetSec` in `transcription.done` broadcast, add
  audio REST route (before `RE_SESSION_ID` match), parse `from`/`to` query
  params via `new URL()`, serve WAV using `pcmToWav(data, 16000)` from
  `lib/audio.js`, return 404 when `.pcm` file missing
- `lib/sessions.js` — `addLine(text, audioOffsetSec)` stores
  `audioOffsetSec: audioOffsetSec ?? null` on the line object, `remove()`
  deletes `.pcm` file alongside `.json`
- `public/app.js` — specific change sites:
  - `createLineElement(lineId, text, timestamp, audioOffsetSec)` — renders play
    button when `audioOffsetSec` is non-null
  - `renderSession()` — passes `line.audioOffsetSec` to `createLineElement()`
  - `handleEvent` `transcription.done` case — reads `event.audioOffsetSec` and
    stores it on the client-side line object pushed to `currentSession.lines`
  - New: shared `<audio>` element, play/stop click handlers, blob URL management
- `public/index.html` — CSS for play button icon and playing state

## Not In Scope

- Audio compression (opus/mp3) — can be added later if disk usage is a problem
- Waveform visualization — stretch goal from the Phase 3 plan
- Play button on idioms in vocab tab — future enhancement
