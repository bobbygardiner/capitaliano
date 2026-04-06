# Capito Phase 2 — Design Spec

## Overview

Extends the MVP with session management, post-processed translations via Claude API,
entity/idiom highlighting, and a polished karaoke-style UI.

## Architecture

```
Browser                          Server
  │                                │
  ├─ binary PCM audio ──────────►  ├─ Mistral SDK (transcription)
  │                                │    │
  │  ◄── transcription events ─────┤    ▼ on transcription.done:
  │                                │    1. Assign lineId
  │                                │    2. Save to session file
  │                                │    3. Fire async translation
  │  ◄── analysis event ──────────┤       └─ Claude API → structured JSON
  │                                │          (translation + entities + idioms)
  ├─ REST: session CRUD ─────────► │
  │  ◄── JSON responses ──────────┤
```

## File Structure

```
server.js                    # HTTP server + WebSocket + route dispatch
lib/
  sessions.js                # Session CRUD, file I/O, active session state
  translate.js               # Anthropic API client, schema, prompt
public/
  index.html                 # HTML structure + all CSS (inline)
  app.js                     # Application JS (separate file)
  pcm-processor.js           # AudioWorklet (unchanged from Phase 1)
docs/
  italian-football-commentary-vocabulary.md  # Reference for translation prompt
sessions/                    # JSON session files (gitignored)
  index.json                 # Session manifest
  sess_<timestamp>.json      # Individual session files
```

## Session Storage

### File format

`sessions/index.json` — lightweight manifest for listing:
```json
[{ "id": "sess_1712345678901", "name": "...", "startedAt": "...", "endedAt": null, "lineCount": 42 }]
```

`sessions/sess_<id>.json` — full session:
```json
{
  "id": "sess_1712345678901",
  "name": "Serie A: Milan vs Napoli",
  "startedAt": "2026-04-06T20:45:00.000Z",
  "endedAt": null,
  "lines": [{
    "lineId": 0,
    "text": "Leão sulla sinistra, cross per Giroud",
    "timestamp": "2026-04-06T20:46:12.340Z",
    "final": true,
    "translation": "Leão on the left, cross for Giroud",
    "entities": [{ "text": "Leão", "type": "player", "start": 0, "end": 4 }],
    "idioms": []
  }]
}
```

### Persistence

- Active session held in memory, flushed to disk every 5 seconds (atomic write via tmp+rename)
- On server start, resume any session with `endedAt: null`
- On SIGINT/SIGTERM, flush before exit

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/sessions | List all sessions (from index.json) |
| POST | /api/sessions | Create new session `{ name }` → 201 |
| GET | /api/sessions/:id | Get full session |
| POST | /api/sessions/:id/end | End active session |

## Translation Pipeline

### Flow

1. Server receives `transcription.done` from Mistral
2. Assigns `lineId`, saves line to active session
3. Forwards event to browser with `lineId`
4. Fires async `analyzeCommentary(text)` — no await
5. On completion, sends `{ type: 'analysis', lineId, translation, entities, idioms }` to browser
6. Browser updates the line with translation data

### Anthropic API

- Model: `claude-haiku-4-5` (fast, cheap, ~$1/match)
- Structured output via `output_config.format` + `zodOutputFormat()`
- Schema: `{ translation: string, entities: [{text, type, start, end}], idioms: [{expression, meaning}] }`
- System prompt includes Italian football vocabulary reference
- Prompt caching on system prompt for cost reduction
- Error handling: SDK retries 3x, skip on failure (line stays with translation: null)

### Dependencies

Add: `@anthropic-ai/sdk`, `zod`

## WebSocket Protocol (expanded)

### Server → Browser events

| type | fields | description |
|------|--------|-------------|
| transcription.text.delta | text | Streaming delta (unchanged) |
| transcription.done | lineId, text | Finalized line with assigned ID |
| transcription.language | audioLanguage | Detected language |
| analysis | lineId, translation, entities, idioms | Translation result |
| session.active | session | Active session info on connect |
| error | message | Error |

## Frontend UI

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ [≡] [Mic ▾] [Session name]  [Start] [Stop]  ● [EN] [×] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Older line, dimmed (opacity 0.28)                      │
│    translation in italic if toggle on                   │
│                                                         │
│  Recent line (opacity 0.4)                              │
│    translation in italic if toggle on                   │
│                                                         │
│  Recent line (opacity 0.6)                              │
│    translation in italic if toggle on                   │
│                                                         │
│  CURRENT LINE — full opacity, weight 500                │
│    Entities underlined in color, idioms dotted           │
│    translation in italic if toggle on                   │
│                                                         │
└─────────────────────────────────────────────────────────┘

┌── Sessions Panel (slide from left) ─────┐
│  SESSIONS                               │
│  ● Current Session           Today 15:32│
│    Milan vs Napoli        Apr 5, 20:45  │
│    TG1 Notizie            Apr 5, 13:30  │
│  [+ New Session]                        │
└─────────────────────────────────────────┘
```

### Visual Design — Warm Muted (extended palette)

```css
--bg:              #FAF8F5
--surface:         #F0EDE8
--border:          #E5E0D9
--text:            #3D3529
--text-muted:      #C4B5A5
--text-secondary:  #8A8780
--accent:          #D0171B
--entity-player:   #B07D4B   (warm amber)
--entity-team:     #D0171B   (accent red)
--entity-stadium:  #6B8F71   (sage green)
--entity-coach:    #7B6B8A   (muted purple)
```

### Karaoke Cascade

Three-tier opacity/weight system (no size changes — avoids layout reflow):
- Active line: opacity 1, weight 500
- Recent-1: opacity 0.6, weight 400
- Recent-2: opacity 0.4, weight 300
- Older: opacity 0.28, weight 300
- Entrance animation: translateY(8px) + fade in over 0.4s

### Entity Highlighting

- Solid colored underline (2px, offset 3px) per entity type
- Hover: subtle background tint via `color-mix()`
- First occurrence gets small superscript label badge
- CSS-only via `[data-entity]` attribute selectors

### Idiom Highlighting

- Dotted underline in muted color (distinct from entity solid underlines)
- CSS tooltip above on hover (::before pseudo-element)
- Tap-to-show on mobile
- Shows contextual meaning

### Translation Display

- Toggle button [EN] in top bar
- When on: `.show-translations` class on body
- Translation appears below Italian text: 14px, italic, `#9A8E7F`
- max-height animation for smooth reveal

### Session Panel

- Slide-out from left, 300px wide
- Triggered by hamburger [≡] button
- Backdrop overlay when open
- Session items: name, timestamp, line count
- Active session: red left border + pulsing dot
- New session button at bottom

### Premium Polish

- -webkit-font-smoothing: antialiased
- Thin custom scrollbar (4px)
- Button active state: scale(0.97)
- App entrance animation on load
- Smooth scroll on transcript
- Custom select dropdown arrow
- Focus-visible outlines for accessibility

## Error Handling

Same as Phase 1 for transcription errors. Translation failures are silent —
line stays with translation: null, user can see it wasn't translated.

## Out of Scope

- Context biasing with squad names (Phase 3)
- Manual vocabulary/phrase flagging
- Anki export
- PWA / iPad support
- Session editing/renaming
- Reprocessing past sessions
