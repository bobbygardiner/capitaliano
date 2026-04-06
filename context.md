# Capito — Project Context

## What this is
A personal tool for live transcription and translation of Italian TV audio
(primarily football commentary). The goal is to
glance at a second screen and understand what was just said in Italian.

## How it came about
Validated through manual testing in Mistral AI Studio:
- iPhone used as mic via macOS Continuity Camera, placed near TV speaker
- Voxtral handled Italian football commentary well at close range
- Player names are the main weak point — addressable via context biasing in later steps

## Validation status
- STT quality: confirmed viable with iPhone mic near TV
- Translation: not yet tested, deferred to step 2
- Audio capture: iPhone → Continuity Camera → Mac system input → getUserMedia ✓

## Three-step roadmap
1. **MVP** (now): Voxtral Realtime streaming → rolling Italian transcript only
2. **Step 2**: Add football domain expertise — vocabulary library, context biasing
   with squad names, translation via Anthropic API
3. **Step 3**: Live domain context — squad fetching at match start, referee names,
   match-specific setup UI

## Future ideas
- "Flag this moment" button — press when you don't catch something,
  reviewed at half time / full time with vocab extraction (idioms etc.)
- PWA / iPad version for portability between rooms
- Extend to Italian news, talk shows, other live TV
- Wireless mic (DJI Mic Mini) for cleaner audio

## Tech decisions
- Voxtral Realtime (`voxtral-mini-transcribe-realtime-2602`) for STT
- Mistral SDK requires Node.js backend — cannot connect directly from browser
- No frameworks, no build step — vanilla JS frontend, minimal Node backend
- API keys in .env (gitignored)
- Served over localhost (secure context for getUserMedia, no HTTPS needed locally)
