# CLAUDE.md — Capito

## What this project is
A personal live transcription tool for Italian TV audio. A Node.js backend
proxies mic audio from the browser to the Voxtral Realtime API. The frontend
displays a rolling Italian transcript in real time.

## Current phase: MVP
Transcription only. No translation yet. Goal: watch a football match and read
a rolling Italian transcript on a second screen.

## Stack
- **Backend**: Node.js (minimal — just enough to proxy audio to Mistral)
- **Frontend**: Single `index.html`, vanilla JS, no framework, no build step
- **STT**: Mistral Voxtral Realtime API (`voxtral-mini-transcribe-realtime-2602`)
- **Audio**: Browser `getUserMedia` → PCM16 @ 16kHz → WebSocket to Node → Mistral SDK
- **No Anthropic API in MVP** — translation is step 2

## Project structure

```
capito/
├── server.js              # HTTP + WebSocket server, Mistral SDK proxy
├── public/
│   ├── index.html         # Single-page app (HTML, CSS, JS inline)
│   └── pcm-processor.js   # AudioWorklet for PCM16 conversion
├── package.json           # Three deps: ws, dotenv, @mistralai/mistralai
├── .env                   # MISTRAL_API_KEY (gitignored)
├── .env.example           # Template for .env
├── context.md             # Project context and roadmap
├── CLAUDE.md              # This file
└── docs/
    └── superpowers/
        ├── specs/          # Design specs
        └── plans/          # Implementation plans
```

## Key technical details
- Audio format Voxtral expects: PCM16, 16kHz, mono, little-endian
- Browser captures via `getUserMedia`, converts Float32 → Int16 via Web Audio API
- Backend opens WebSocket to Mistral, forwards audio chunks, streams back deltas
- Event types from Mistral: `transcription.text.delta`, `transcription.done`, error
- Transcript display: append deltas in real time, new line on `transcription.done`

## Principles
- Keep it simple — this is a personal tool, not a product
- No unnecessary dependencies
- Don't add translation, UI polish, or step 2 features until MVP is working
- Prefer readable code over clever code

## What success looks like for MVP
Run `node server.js`, open `localhost:3000`, click start, point mic at TV,
see Italian commentary appear on screen within ~1 second of it being spoken.

## Next steps (do not build yet)
- Translation via Anthropic API (Claude Sonnet) on each `transcription.done` event
- Context biasing with squad names
- "Flag this moment" button with half-time review
- PWA / iPad support
