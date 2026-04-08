# CLAUDE.md — Capitaliano

## What this project is
A personal live transcription and translation tool for Italian TV audio. A Node.js
backend proxies mic audio to the Voxtral Realtime API and post-processes each
utterance with translation and entity extraction via Claude Code CLI. The frontend
displays a rolling karaoke-style Italian transcript with optional English translations
and highlighted entities/idioms.

## Current phase: Phase 2
Live transcription with sessions, post-processed translations, entity/idiom
highlighting, and polished karaoke-style UI.

## Stack
- **Backend**: Node.js — audio proxy, session storage, REST API, translation pipeline
- **Frontend**: `index.html` (HTML+CSS) + `app.js` (vanilla JS), no framework, no build step
- **STT**: Mistral Voxtral Realtime API (`voxtral-mini-transcribe-realtime-2602`)
- **Translation**: Claude Code CLI (`claude -p`) for translation + entity extraction
- **Audio**: Browser `getUserMedia` → PCM16 @ 16kHz → WebSocket to Node → Mistral SDK

## Project structure

```
capito/
├── server.js              # HTTP + WebSocket server, REST API, Mistral proxy
├── lib/
│   ├── sessions.js        # Session CRUD, JSON file I/O, flush timer
│   └── translate.js       # Translation via claude -p CLI
├── public/
│   ├── index.html         # HTML structure + all CSS (inline)
│   ├── app.js             # Application JavaScript
│   └── pcm-processor.js   # AudioWorklet for PCM16 conversion
├── sessions/              # Session JSON files (gitignored)
│   └── index.json         # Session manifest
├── docs/
│   ├── italian-football-commentary-vocabulary.md
│   └── superpowers/
│       ├── specs/          # Design specs
│       └── plans/          # Implementation plans
├── package.json
├── .env                   # MISTRAL_API_KEY (gitignored)
├── .env.example
├── context.md
└── CLAUDE.md              # This file
```

## Key technical details
- Audio: PCM16, 16kHz, mono, little-endian via AudioWorklet
- Server intercepts `transcription.done` events to save lines and trigger translation
- Translation is fire-and-forget async: `claude -p` returns JSON with translation, entities, idioms
- Sessions stored as JSON files in sessions/ with 5-second flush timer
- WebSocket protocol: `transcription.text.delta`, `transcription.done` (with lineId), `analysis`, `error`
- Entity types: player, team, stadium, coach — each with colored underlines
- Idioms shown with dotted underlines and CSS hover tooltips

## API endpoints
- `GET /api/sessions` — list all sessions
- `POST /api/sessions` — create new session
- `GET /api/sessions/:id` — get full session
- `POST /api/sessions/:id/end` — end active session

## Principles
- Keep it simple — this is a personal tool, not a product
- No unnecessary dependencies
- Prefer readable code over clever code
- UI should feel smooth and premium without being overcomplicated

## Next steps (do not build yet)
- Context biasing with squad names (Phase 3)
- "Flag this moment" button with half-time review
- PWA / iPad support
- Anki deck export from vocabulary/idioms
