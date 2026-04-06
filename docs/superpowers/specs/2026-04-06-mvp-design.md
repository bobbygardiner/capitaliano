# Capito MVP — Design Spec

## Overview

Live Italian speech-to-text for TV audio. Browser captures mic audio, streams it
to a Node.js backend that proxies to the Mistral Voxtral Realtime API, and
displays a rolling transcript with karaoke-style highlighting.

## System Architecture

```
iPhone (Wide Spectrum mic mode) → macOS audio input
  → Browser: getUserMedia (mono, all processing OFF)
  → AudioContext @ 16kHz (browser auto-resamples from 48kHz)
  → AudioWorkletNode (4096 samples = 256ms chunks, Float32→Int16)
  → Binary WebSocket frame to Node server
  → Mistral SDK RealtimeTranscription client
  → Server forwards Mistral events to browser as JSON
  → Browser renders karaoke-style transcript
```

### Files

| File | Role |
|------|------|
| `server.js` | HTTP static server + WebSocket proxy to Mistral SDK. <100 lines. |
| `public/index.html` | Single page. All CSS and JS inline. |
| `public/pcm-processor.js` | AudioWorklet: buffer accumulation + Float32→Int16 conversion. |
| `package.json` | Three deps: `ws`, `dotenv`, `@mistralai/mistralai` |

### Data Flow

- Browser → Server: binary PCM audio only
- Server → Browser: JSON events only (`transcription.text.delta`,
  `transcription.done`, `transcription.language`, `error`)

The server is a dumb pipe. No parsing, transforming, or storing audio. All
intelligence lives in the browser.

## Audio Pipeline

### Browser Capture

```javascript
getUserMedia({
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
})
```

All processing OFF — these algorithms are tuned for voice calls, not TV audio.
Device selection via `enumerateDevices()` dropdown — Continuity Camera won't be
the default mic.

### AudioWorklet (`pcm-processor.js`)

- Runs on dedicated audio thread (not main thread)
- Receives 128-sample render quantums from AudioContext
- Accumulates into 4096-sample buffer (256ms at 16kHz)
- Converts Float32 [-1.0, 1.0] → Int16 [-32768, 32767]
- Posts ArrayBuffer via `postMessage` with transferable (zero-copy)
- Caps internal buffer at 4x target size to prevent memory leaks

### Main Thread Bridge

- Receives Int16 ArrayBuffer from worklet
- Checks `ws.bufferedAmount < 64KB` before sending
- Drops chunks under backpressure (correct for real-time STT)
- Sends as binary WebSocket frame

### AudioContext

- Created with `{ sampleRate: 16000 }` — browser resamples from 48kHz
- Created inside button click handler (autoplay policy)
- Explicitly `resume()` if suspended

### Teardown

- Stop MediaStream tracks (clears mic indicator)
- Disconnect and close AudioWorklet
- Close AudioContext
- Close WebSocket with code 1000

## Server (`server.js`)

Under 100 lines. Three responsibilities:

### 1. Serve Static Files

Vanilla `http.createServer` on port 3000. Serves `public/` with MIME types for
`.html`, `.js`, `.css`. No Express.

### 2. WebSocket Upgrade

Uses `ws` library. On connection:

- Creates Mistral `RealtimeTranscription` client with API key from `.env`
- Model: `voxtral-mini-transcribe-realtime-2602`
- Audio format: PCM16, 16kHz
- `targetStreamingDelayMs: 480`
- Feeds incoming binary frames from browser as audio chunks

### 3. Event Forwarding

Iterates SDK async event stream, forwards to browser as JSON:

- `transcription.text.delta` → `{ type, text }`
- `transcription.done` → `{ type, text, segments }`
- `transcription.language` → `{ type, language }`
- `error` → `{ type, error }`

No state, no storage, no transformation. Each browser connection gets its own
Mistral session. On browser WebSocket `close` event, end the Mistral audio
stream and close the SDK connection.

## Frontend UI

### Layout

```
┌─────────────────────────────────────────┐
│ [Mic dropdown ▾]  [Start]  ● Capturing  │  ← slim top bar
├─────────────────────────────────────────┤
│                                         │
│ older lines (dimmed)                    │
│                                         │
│ current line (full contrast)            │
│                                         │
└─────────────────────────────────────────┘
```

### Visual Design — Warm Muted

| Token | Value | Usage |
|-------|-------|-------|
| Background | `#FAF8F5` | Page background (cream) |
| Surface | `#F0EDE8` | Top bar |
| Text current | `#3D3529` | Active transcript line |
| Text older | `#C4B5A5` | Completed lines |
| Accent | `#D0171B` | Capturing indicator dot |
| Font | Sora | Google Fonts, system sans-serif fallback |
| Font size | 18-20px | Transcript text |

### Karaoke Behaviour

- `transcription.text.delta` → append text to current line element
- `transcription.done` → finalise current line (dim it), create new line element
- Auto-scroll to bottom on each delta
- All lines remain in the DOM — full scrollable log
- In-memory array: `[{ text, timestamp, final }]` — not persisted in MVP

### Top Bar States

- **Before start:** Mic dropdown + Start button visible. Transcript area empty.
- **During transcription:** Start button hidden, pulsing red dot + "Capturing".
  Mic dropdown stays (read-only).
- **On error:** Red banner below top bar with error message.

## Error Handling

| Scenario | Response |
|----------|----------|
| Mic permission denied | Banner: "Microphone access denied — check browser permissions" |
| WebSocket fails/drops | Banner: "Connection lost — refresh the page" |
| Mistral error event | Banner: show error message from Mistral |

No reconnection logic. Refresh is the recovery path.

## Edge Cases

- **Continuity Camera latency:** First 1-2 seconds may be silence. Ignore.
- **Tab backgrounding:** AudioWorklet not throttled (audio thread). WebSocket
  stays alive. Main thread bridge may delay slightly — acceptable for MVP.
- **Long sessions:** Buffer capped at 4x in worklet. DOM accumulates lines —
  hundreds of nodes for a 90-minute match, not thousands.
- **No mic connected:** `getUserMedia` rejects → mic denied banner.

## Explicitly Out of Scope

- Translation (step 2)
- Context biasing / squad names (step 2)
- Transcript persistence / sessions
- Stop button (refresh to stop)
- Reconnection / retry logic
- VU meter / audio level display
- Offline detection

## Future Considerations

Decisions made with future in mind, without building anything now:

- **Top bar** leaves room for session navigation in a later phase
- **In-memory `[{ text, timestamp, final }]` array** is structured for future
  persistence as JSON session files
- **Server can be extended** with HTTP routes (e.g. `/api/translate`) for
  step 2 — `http.createServer` supports this without Express
- **Audio pipeline** is source-agnostic — swapping input device or adding
  alternative capture methods doesn't change the WebSocket/server layer
- **Sport-agnostic:** nothing in the pipeline is football-specific; context
  biasing (step 2) is a parameter, not an architecture change

## Dependencies

```json
{
  "ws": "WebSocket server",
  "dotenv": "Load .env",
  "@mistralai/mistralai": "Voxtral Realtime SDK"
}
```

## Success Criteria

Run `node server.js`, open `localhost:3000`, select iPhone mic, click Start,
point mic at TV playing Italian commentary. Italian text appears on screen
within ~1 second, flowing line by line in karaoke style.
