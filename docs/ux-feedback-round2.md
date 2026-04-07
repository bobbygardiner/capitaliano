# Capito UX Feedback Report — Round 2

**Date**: 7 April 2026
**Panel**: 3 UX experts dogfooding Capito v0.3 (post P0+P1 fixes)
**Sessions reviewed**: Full Match Test (163 lines, completed), Napoli vs AC Milan (191 lines, baseline comparison), Full Match Test 15min (active, 0 lines — stream inactive during review window)
**Previous report**: `docs/ux-feedback-report.md` (22 issues identified against v0.2)

---

## Executive Summary

The P0/P1 fixes have materially improved the product. Translation failures dropped from 5/191 (2.6%) to 1/163 (0.6%). The max line length dropped from 120 words to 99 words (and from 17 lines over 300 chars to just 1). The inline session form, edit modal, and keyboard shortcuts are all well-implemented. Translation contrast is now `#736860` which is a meaningful improvement. However, one edge-case bug in the sentence length cap allowed a 540-char line through, the `--text-muted` CSS variable for timestamps was not updated (still `#C4B5A5`), and the English-audio fabrication problem from v0.2 persists — the Full Match Test session has 163 lines of English commentary with fabricated Italian in the segment `it` fields.

---

## Confirmed Fixed (13 of 22 issues from Round 1)

### P0 Fixes — All Confirmed

**1. Inline session creation form (was P0 #1)** — CONFIRMED FIXED
- `prompt()` dialogs are gone. The `#new-session-form` slides down inside the sessions panel with a text input and textarea. `createSessionBtn` POSTs to `/api/sessions` with `{name, context}`. The form has proper focus management (`sessionNameInput.focus()`) and a Cancel button. Well done.

**2. Translation contrast (was P0 #2)** — CONFIRMED FIXED
- `.segment-translation` and `.line-translation` both use `color: #736860`. This is approximately 4.6:1 contrast against `#FAF8F5` — meets WCAG AA. The previous `#9A8E7F` (~2.8:1) is completely gone from the CSS.

**3. Sentence length cap (was P0 #3)** — MOSTLY FIXED (see regression below)
- The `MAX_SENTENCE_LENGTH = 300` logic is implemented in `server.js` lines 231-242. It tries to break at the last comma; if none found past `MIN_SENTENCE_LENGTH`, it force-finalizes. The Napoli session (pre-fix) had 17 lines over 300 chars; the Full Match Test (post-fix) has only 1. That is a 94% reduction.

**4. Translation failure handling (was P0 #4)** — CONFIRMED FIXED
- `translate.js` now has retry logic: `analyzeCommentary()` loops `attempt < 2`, retrying once on failure. The Anthropic client is configured with `maxRetries: 2, timeout: 15_000`. `max_tokens` is now `2048` (was 1024). Translation failures dropped from 5/191 (2.6%) to 1/163 (0.6%). The single remaining failure (line 162, `$0.00` cost) suggests a timeout or API error that exhausted retries — acceptable.

### P1 Fixes — All Confirmed

**5. Edit session context modal (was P1 #5)** — CONFIRMED FIXED
- Full modal implementation: `#edit-context-panel` with backdrop, scale animation, name input + context textarea, Save/Cancel buttons. The `editSessionBtn` (pencil icon `&#9998;`) appears in the top bar next to the session name. Save PATCHes to `/api/sessions/:id`. Escape key closes it via the keyboard shortcut handler.

**6. Font size reduction (was P1 #6)** — CONFIRMED FIXED
- `.line-italian` and `.line-segments` are both `font-size: 17px; line-height: 1.6`. The `max-width: 720px` constraint is on `.transcript-line`. All three changes applied as recommended.

**7. Karaoke opacity (was P1 #7)** — CONFIRMED FIXED
- `.transcript.live .transcript-line { opacity: 0.35 }` (was 0.28). The graduated cascade is in place: `recent-2` at 0.5, `recent-1` at 0.7, `active` at 1.0. Scrolled-up override is 0.8. The gaps between steps are tighter and should feel smoother.

**8. Inline delete (was P1 #9)** — CONFIRMED FIXED
- Two-click delete with auto-revert. First click: `delBtn.textContent = 'Sure?'` with red accent background. Second click: DELETEs via API. `setTimeout` reverts after 3000ms. No more `confirm()` dialogs.

**9. Keyboard shortcuts (was P1 #10)** — CONFIRMED FIXED
- `keydown` listener with input field guard (`e.target.tagName === 'INPUT'` etc.). Space toggles start/stop, T toggles translations, Escape closes sessions panel and edit modal. Implementation is clean.

**10. Pending-analysis shimmer (was P1 #11)** — CONFIRMED FIXED
- `.transcript-line.pending-analysis` applies a shimmer animation via `background: linear-gradient(90deg, ...)` with `background-size: 200% 100%` and a 2s ease-in-out infinite animation. The class is added on `transcription.done` and removed on `analysis` event. Good.

**11. Tab bar always visible (was P1 #14)** — CONFIRMED FIXED
- The `#tab-bar` is never hidden with `.hidden`. Instead, it uses a `.disabled` class that greys out tabs (`color: var(--border-strong); pointer-events: none`). The class is removed when a session loads. Always-visible with a disabled state — exactly as recommended.

**12. Max tokens increased (was P0 #4, part)** — CONFIRMED FIXED
- `max_tokens: 2048` in `translate.js` line 45 (was 1024).

**13. Missing space fix in cleanText (was a bug)** — CONFIRMED FIXED
- Two regexes in `server.js`: `RE_MISSING_SPACE_CAMEL` for `([a-z])([A-Z])` and `RE_MISSING_SPACE_PUNCT` for `([.!?,;:])([A-Za-z])`. Both handle Unicode ranges. Regexes are hoisted to module scope (no per-call compilation). Correct.

---

## Regressions and Edge Cases

### REGRESSION: Sentence cap bypass on large deltas (NEW, P1)

The 300-char cap in `server.js` (line 231) checks `sentenceBuffer.length >= 300` after each `text.delta` event. However, the check runs only once per delta. If Mistral delivers a single large chunk that pushes the buffer from, say, 250 to 540 chars, the code enters the `else if` branch, finds no comma in the first 300 chars, and force-finalizes the **entire 540-char buffer** without splitting.

**Evidence**: Line 21 in Full Match Test is 540 chars / 99 words. The text contains no commas until position 488. The 300-char cap correctly triggered but could not split, so it emitted the full oversized line.

**Fix**: After the force-finalize in the `else` branch, add a `while` loop or recursive call to handle remaining buffer content:

```js
} else {
  // Force break at roughly 300 chars even without punctuation
  const breakPoint = Math.min(sentenceBuffer.length, 300);
  const spaceIdx = sentenceBuffer.lastIndexOf(' ', breakPoint);
  const bp = spaceIdx > MIN_SENTENCE_LENGTH ? spaceIdx : breakPoint;
  finalizeSentence(sentenceBuffer.slice(0, bp));
  sentenceBuffer = sentenceBuffer.slice(bp).trimStart();
}
```

### NOT FIXED: Timestamp contrast (was P1 #8)

The `.line-timestamp` color is now `#A89A8A` (updated from `#C4B5A5`). However, `--text-muted` CSS variable is still `#C4B5A5` on line 17 of `index.html`. This variable is used for the cost indicator, session meta, vocab time, and waiting indicator. These secondary elements remain at ~1.8:1 contrast. The timestamp itself is fixed; the variable is not.

**Impact**: Low — timestamps are the most important muted element and they are fixed. But the inconsistency means `--text-muted` is a trap: any new element using it will be too faint.

**Fix**: Update `--text-muted: #A89A8A` in the `:root` block to match the timestamp fix.

---

## Remaining Issues from Round 1 (Not Yet Addressed)

### Still Open — P1

**P1 #12: Entity validation against match context** — NOT ADDRESSED
- The Full Match Test session (which has no squad context) shows "Derby della Bandolina" classified as `stadium` (line 7) — it should be an event/fixture name, not a stadium. "Marcus Turan" (line 1) and "Nadea" as a team (line 2) appear to be speech recognition errors that were not caught.
- The Napoli session still has the "Modric" phantom entity from the previous report.
- The system prompt in `translate.js` now includes the instruction "Only include entities whose names appear in the match context (if provided)" — this is a prompt-level fix but there is no code-level validation.

**P1 #13: Very short segments** — IMPROVED but not fully resolved
- Full Match Test: 30/400 segments (7.5%) have fewer than 3 words. This is down from 105/752 (14.0%) in the Napoli session. The prompt now says "Avoid segments shorter than 3 words — merge short fragments with the adjacent clause." The prompt-level fix halved the rate, but 7.5% is still noticeable.

**P1 #9 (renumbered): Segment layout** — NOT ADDRESSED (was P2 #21)
- `.show-translations .segment-pair { display: inline-block }` still creates the choppy grid layout. No flexbox alternative was implemented.

### Still Open — P2

**P2 #15: Entity colour legend** — NOT ADDRESSED
**P2 #16: Non-Italian audio detection** — NOT ADDRESSED (see data quality section below)
**P2 #17: Auto-collapse advertisements** — NOT ADDRESSED
**P2 #18: Session search/filter** — NOT ADDRESSED
**P2 #19: Vocab/idiom export** — NOT ADDRESSED
**P2 #20: Cost display rounding** — NOT ADDRESSED (still shows 4 decimal places during live via `costUsd.toFixed(4)`)
**P2 #22: Loading state for mic selector** — NOT ADDRESSED (still shows "Loading devices...")

---

## New Issues Found in v0.3

### NEW P1: English audio still produces fabricated Italian segments

The Full Match Test session (163 lines) was fed English commentary audio. The system:
1. Transcribes correctly in English via Mistral
2. Sends the English text to Claude for "analysis"
3. Claude dutifully fabricates Italian segments for the English input

Example (line 0): Original English text "Center side picks itself..." gets segments with `it: "La formazione si sceglie da sé."` — this is Claude inventing Italian text, not transcribing it.

4% of segments in the first 30 lines contain obvious English words in the `it` field, but most are fully fabricated Italian that reads plausibly — making it actively misleading for language learners.

The `transcription.language` event is already handled in `app.js` (line 519-520) with just a `console.log`. No server-side detection exists.

**Fix**: In `server.js`, check the language from Mistral events. If non-Italian, skip the Claude analysis and mark the line with a `language` field.

### NEW P2: In-memory session lookup bug in analysis handler

In `app.js` line 496, the analysis event handler looks up the line with `const line = currentSession.lines[event.lineId]`. This uses `lineId` as an array index, but `lineId` is a sequential counter that may not match the array index if lines were added to a session that was loaded mid-stream. For a fresh session this works, but for a resumed session where the first `lineId` is, say, 50, `currentSession.lines[50]` would be `undefined` even though the line exists at array index 0.

**Impact**: Idioms from resumed sessions won't appear in the Vocab tab during live streaming. Low severity since most users start fresh sessions.

### NEW P2: Edit modal does not update sessions panel

When the user renames a session via the edit modal (`saveContextBtn` click handler), `sessionNameEl.textContent` is updated but `loadSessionsList()` is not called. If the sessions panel is subsequently opened, it shows the old name until a manual refresh.

---

## Data Quality Metrics — Comparative

| Metric | Napoli v0.2 (191 lines) | Full Match Test v0.3 (163 lines) | Delta |
|---|---|---|---|
| Null translations | 5 (2.6%) | 1 (0.6%) | -80% |
| Lines > 300 chars | 17 (8.9%) | 1 (0.6%) | -94% |
| Lines > 60 words | 13 (6.8%) | 1 (0.6%) | -92% |
| Max word count | 120 | 99 | -18% |
| Avg word count | 21.6 | 14.2 | -34% |
| Short segments (<3 words) | 105/752 (14.0%) | 30/400 (7.5%) | -46% |
| Avg cost/line | $0.0023 | $0.0015 | -35% |
| Total entities | 339 | 246 | similar (fewer lines) |
| Entity-segment mismatches | observed | 0 in 16 checked | fixed |
| Lines with $0 cost (pipeline failures) | 4 | 1 | -75% |

**Key observations**:
- The sentence length cap is working well. The distribution shifted heavily toward 1-20 word lines (87% of lines in v0.3 vs ~50% estimated in v0.2).
- Translation reliability is much better. The retry logic + higher max_tokens reduced failures from 5 to 1.
- Cost per line decreased 35%, likely because shorter lines need fewer output tokens.
- Entity-segment text matching appears fixed — 0 mismatches found in a 16-line sample (the prompt instruction to use corrected names in both segments and entities is being followed).
- The one remaining null translation (line 162) has $0.00 cost, indicating the API call failed before consuming tokens. The retry logic attempted but both tries failed. This line is only 72 chars, so length is not the issue — likely a transient API error.

---

## Recommendations — Prioritised

### Must Fix (before next review)
1. **Fix sentence cap bypass**: Add word-boundary splitting in the force-break path so no line exceeds ~300 chars even without commas
2. **Detect non-Italian audio**: Use Mistral's language detection to skip Claude analysis on English input and display a `[non-Italian]` badge

### Should Fix
3. **Update `--text-muted` variable**: Change from `#C4B5A5` to `#A89A8A` for consistency with the timestamp fix
4. **Fix sessions panel stale name**: Call `loadSessionsList()` after a successful PATCH in the edit modal handler
5. **Fix lineId array lookup**: Use `lines.find(l => l.lineId === event.lineId)` instead of direct index access

### Nice to Have
6. Entity colour legend
7. Vocab/Anki export
8. Session search/filter
9. Cost display rounding (2 decimals live, 4 in review)
10. Segment layout improvements (flexbox wrap instead of inline-block grid)

---

*Report generated by a panel of 3 UX experts reviewing Capito v0.3 (post P0+P1 fixes)*
*Compared against: `docs/ux-feedback-report.md` (v0.2 baseline, 22 issues)*
