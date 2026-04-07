# Phase 3 Plan

## 1. Two-Phase Transcription

### Architecture
```
Audio chunks from browser
  │
  ├─► Phase 1: Voxtral Realtime (as now)
  │     → fast deltas, no context bias
  │     → immediate Haiku translation (rough)
  │     → text + translation on screen within ~2s
  │
  └─► Phase 2: Voxtral Batch Streaming (new)
        → accumulate ~5s audio chunks
        → POST to batch API with contextBias (squad names)
        → better transcription with correct player names
        → second Haiku translation (refined)
        → replaces Phase 1 text + translation on screen
```

### UX
- User sees rough text immediately (never waiting)
- Text quietly upgrades 5-10 seconds later with corrected names + better entities/idioms
- Like progressive JPEG — blurry then sharp
- Visual indicator during upgrade (subtle shimmer or fade transition)

### API Details
- Batch endpoint: `POST /v1/audio/transcriptions` with `stream: true`
- Model: `voxtral-mini-transcribe-v2-2602` (batch model, NOT realtime)
- `contextBias`: array of up to 100 player/team/coach names
- Audio format: same PCM16 16kHz chunks, accumulated into ~5 second windows

### Cost
- 2x Mistral (realtime + batch) + 2x Haiku per line
- ~$0.005/line instead of $0.002 — under $2 for a full match

### Implementation Notes
- Buffer audio chunks on the server in ~5s windows
- POST each window to batch API while realtime continues
- Match batch results to existing lines by timestamp alignment
- Send `analysis.upgrade` event to browser to replace Phase 1 content
- Need to handle the case where Phase 2 splits sentences differently than Phase 1

## 2. Audio Preservation + Playback

### Architecture
- Save raw audio as a single file per session (opus/mp3 compressed)
- Each line's `timestamp` maps to a position in the audio file
- Browser can request audio clips: `GET /api/sessions/:id/audio?from=120.5&to=123.0`

### UX
- Play button on each line → plays the ~3 second audio clip
- Play button on idioms in vocab tab → hear the commentator say it
- Waveform visualization (stretch goal)

### Storage
- Raw PCM16 16kHz mono = ~1.9MB/min, ~170MB per match
- Compressed opus = ~170KB/min, ~15MB per match
- Store in `sessions/` alongside the JSON file

### Implementation Notes
- Server accumulates audio chunks and writes to a file
- Use ffmpeg to compress to opus on session end (or stream-compress live)
- Audio clip extraction via ffmpeg: `ffmpeg -ss 120.5 -t 2.5 -i session.opus pipe:1`
- Browser plays via `<audio>` element with blob URL

## 3. Auto-Fetch Squad Rosters

### Architecture
- User enters two team names when creating a session
- Server fetches squad rosters from football-data.org or similar API
- Populates the session context automatically
- Squad names fed into both Phase 2 contextBias and Haiku prompt

### UX
- Session creation form: two team name inputs with autocomplete
- "Fetching squads..." loading state
- Fetched squad shown in the context textarea (editable)
- User can add/remove names before starting

### API Options
- football-data.org: free tier, squad endpoints, Serie A coverage
- API-Football (RapidAPI): broader coverage, more data
- Need: team search by name → squad roster with player names + positions

## 4. Testing

### Test Fixture
- Inter-Roma highlights clip (test/fixtures/italian-commentary.mp3)
- Actual matchday squad context to be provided by user for accurate testing
- Two-phase comparison: Phase 1 only vs Phase 1+2 output quality

### Metrics to Track
- Phase 1 latency (time to first text)
- Phase 2 latency (time to upgrade)
- Entity correction rate (Phase 1 vs Phase 2)
- Translation quality (with/without contextBias)
- Cost per line (single vs two-phase)
- Audio file sizes
