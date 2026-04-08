# Phase 3 Plan

## 1. Two-Phase Transcription — DISCARDED

Attempted and tested live. Batch upgrades were sometimes worse than realtime
(e.g., "Akancalhanoglu" → "accanciare a N'dicka" instead of keeping Calhanoglu).
The batch model transcribes independently and can produce completely different,
worse text for garbled audio. Discarded in favour of single-phase realtime with
better context biasing (see section 3).

## 2. Audio Preservation + Playback — IMPLEMENTED

Already built. Server records raw PCM to `sessions/{id}.pcm`, serves WAV clips
via `GET /api/sessions/:id/audio?from=X&to=Y`. Playback UI in the frontend.

## 3. Web Search Context Biasing

### Architecture
- User types a session name (e.g. "PSG vs Liverpool, Champions League")
- Optional "Search for context" toggle on session creation form
- When enabled, server fires a single Claude Haiku API call with `web_search` tool
- Haiku searches the web for match details: full matchday squads, managers, venue
- Returns structured JSON which auto-populates the session context
- Squad names fed into Haiku translation/analysis prompts as context

### Why Web Search Instead of Football APIs
- Works for any content, not just football — tennis, podcasts, news, cooking shows
- No external API dependencies or API keys to manage
- Single provider (Anthropic) already in the stack
- Gets real, current data (actual matchday squads, not stale training data)

### API Details
- Model: `claude-haiku-4-5` with `web_search_20260209` tool (`allowed_callers: ["direct"]`)
- Single call at session start, ~$0.05-0.17 depending on search depth
- Prompt asks for full matchday squad (starting XI + bench), managers, competition, venue
- Response is structured JSON — no post-processing needed

### UX
- Session creation form: existing name + context fields
- New toggle: "Search for context" (default off)
- When toggled on and session name entered: "Searching..." loading state
- Results auto-populate the context textarea (editable before starting)
- User can review, tweak, or clear before hitting start
- When toggled off: works exactly as now (manual context or none)

### Prompt Template
```
I'm building context for a live Italian transcription tool.
Search for the full matchday squads (not just starting XI — include
substitutes) for this match: "{sessionName}"

Return ONLY valid JSON with this structure:
{
  "match": "Team A vs Team B",
  "competition": "...",
  "venue": "...",
  "date": "...",
  "managers": ["...", "..."],
  "teams": [
    { "name": "...", "squad": ["Player Name", "..."] }
  ]
}

Include the full matchday squad (starting XI + bench) for each team.
Use the player names as they would appear on official teamsheets.
Do not include generic vocabulary or anything not sourced from the
web search.
```

### Cost
- ~$0.05-0.17 per session (one-time, at creation)
- Opt-in only — zero cost if toggle is off
- Bulk of cost is input tokens from web search results

## 4. Testing

### Test Fixture
- Inter-Roma highlights clip (test/fixtures/italian-commentary.mp3)
- Actual matchday squad context to be provided by user for accurate testing

### Metrics to Track
- Web search context quality (are the squads correct and complete?)
- Entity recognition rate with vs without web search context
- Translation quality with vs without context
- Web search cost per session
- Web search latency (time from toggle to populated context)
