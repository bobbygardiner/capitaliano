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
line offsets can be computed relative to it.

On session end or client disconnect, close the file stream. On session delete,
remove the `.pcm` file alongside the `.json`.

The file is append-only, so it is safe to read earlier bytes while still writing
(needed for live playback).

### File format

- Raw PCM16, 16kHz, mono, little-endian
- No header — just concatenated audio samples
- ~1.9 MB/min, ~170 MB for a full match
- Byte offset formula: `byteOffset = Math.floor(seconds × 16000 × 2)`

## Line Audio Offsets

`addLine()` in `sessions.js` currently stores `timestamp` as an ISO date string.
Add a new field `audioOffsetSec` — the number of seconds from the session's first
audio chunk to when the line was finalized:

```
audioOffsetSec = (Date.now() - sessionAudioStartTime) / 1000
```

This is stored on each line object alongside the existing `timestamp`. The
existing `timestamp` field is unchanged — `audioOffsetSec` is additive.

The `sessionAudioStartTime` value must be passed from `server.js` (where audio
arrives) into the sessions module so `addLine()` can compute the offset.

## REST Endpoint

```
GET /api/sessions/:id/audio?from=X&to=Y
```

Where `from` and `to` are seconds (floats). The handler:

1. Resolves the `.pcm` file path: `sessions/<id>.pcm`
2. Converts `from`/`to` to byte offsets: `Math.floor(seconds × 16000 × 2)`
3. Reads that byte range from the file (clamped to actual file size)
4. Prepends a 44-byte WAV header (PCM16, 16kHz, mono, correct data length)
5. Responds with `Content-Type: audio/wav`

If `to` is omitted, reads to end of file. If `from` is omitted, starts from 0.

Route pattern: `RE_SESSION_AUDIO = /^\/api\/sessions\/(sess_\d+)\/audio$/`

## Frontend Playback

Each finalized transcript line shows a `▶` play icon next to the elapsed
timestamp (e.g., `▶ 12:34`). The icon is always visible, not hidden behind hover.

### Click behavior

1. Compute `from` = this line's `audioOffsetSec`, `to` = next line's
   `audioOffsetSec` (omit `to` for the last line)
2. Fetch `/api/sessions/:id/audio?from=X&to=Y`
3. Create a blob URL from the response and play via a shared `<audio>` element
   (one per page, reused across lines)
4. While playing, the icon switches to `■` (stop). Clicking again stops playback.

### Live vs review

Play buttons appear on all finalized lines, including during live sessions. The
active streaming line (not yet finalized) does not get a play button. Since the
`.pcm` file is append-only, reading earlier bytes during a live session is safe.

### Audio offset data flow

When rendering lines (both live `transcription.done` events and loaded sessions),
the frontend needs `audioOffsetSec` for each line. This is included in:

- The `transcription.done` WebSocket event (for live lines)
- The session JSON (for loaded/past sessions)

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

No structural changes. The `.pcm` file is a sibling of the `.json` file in the
`sessions/` directory.

## Files Modified

- `server.js` — open PCM file stream on first audio chunk, append chunks, track
  `sessionAudioStartTime`, pass it to sessions module, add audio REST route
- `lib/sessions.js` — accept `audioStartTime`, compute `audioOffsetSec` in
  `addLine()`, delete `.pcm` on session remove
- `public/app.js` — play button rendering, `<audio>` element management, click
  handlers
- `public/index.html` — CSS for play button icon and playing state

## Not In Scope

- Audio compression (opus/mp3) — can be added later if disk usage is a problem
- Waveform visualization — stretch goal from the Phase 3 plan
- Play button on idioms in vocab tab — future enhancement
