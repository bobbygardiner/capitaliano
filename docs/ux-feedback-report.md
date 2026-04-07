# Capito UX Feedback Report

**Date**: 7 April 2026
**Panel**: 3 UX experts dogfooding live Italian football transcription tool
**Sessions reviewed**: Napoli vs AC Milan (191 lines), Inter-Roma Highlights (17 lines), Full Match Test (active, 5 lines)

---

## Executive Summary

Capito has a strong visual foundation and genuinely useful data pipeline. The warm muted palette, Sora typeface, and karaoke cascade create a reading experience that feels a cut above typical transcription tools. However, the session creation flow is embarrassingly bad (two browser `prompt()` dialogs), there are real data quality issues (5 failed translations out of 191, lines running to 120 words), and several CSS decisions that hurt readability on sustained use. The bones are excellent; the polish needs work.

---

## Expert 1 -- Visual Design & Readability

### What works well

- **Sora is a great typeface choice.** Geometric, clean, reads well at both 19px body and 11px timestamps. The weight ramp (300/400/500/600) is well-used.
- **The warm muted palette** (`#FAF8F5` background, `#3D3529` text) is genuinely pleasant for extended reading. Better than cold white/black for a TV-companion use case.
- **Entity underline colours** are well-differentiated -- player gold (`#B07D4B`), team red (`#D0171B`), stadium green (`#6B8F71`), coach purple (`#7B6B8A`) -- and the 2px solid underlines are visible without being obnoxious.
- **The idiom tooltip** (dark background, 8px border-radius, arrow caret) is beautifully executed. The flip-below behaviour for tooltips near the top of the viewport is a nice touch.

### Issues

**P0: Translation text is too low-contrast**
- `color: #9A8E7F` on `#FAF8F5` background = ~2.8:1 contrast ratio. WCAG AA requires 4.5:1 for body text. This is the most-read secondary element and it's borderline invisible in bright ambient light (watching football with the lights on).
- **Fix**: Use `#7A7068` (~4.5:1 ratio) or darken to at least `var(--text-secondary)` which is `#8A8780` (~3.5:1, still not great but closer).

```css
/* Before */
.segment-translation { color: #9A8E7F; }
.line-translation { color: #9A8E7F; }

/* After */
.segment-translation { color: #736860; }
.line-translation { color: #736860; }
```

**P1: 19px Italian text is slightly too large for dense commentary**
- When lines run long (60-120 words -- common in this data), 19px at 1.65 line-height produces walls of text. At line 26 (102 words) and line 125 (120 words), a single transcript line fills the entire viewport.
- **Fix**: Drop to 17px with 1.6 line-height. Alternatively, keep 19px but add a `max-width: 720px` to the transcript area to improve line length.

```css
.line-italian, .line-segments {
  font-size: 17px;
  line-height: 1.6;
  max-width: 720px;
}
```

**P1: Karaoke cascade opacity of 0.28 is too dim**
- `.transcript.live .transcript-line { opacity: 0.28 }` renders older lines nearly invisible. On a laptop screen in a well-lit room, anything below ~0.35 disappears.
- The scroll-up override (`opacity: 0.85`) is good but the gap between 0.28 and 0.85 is jarring when the mode switches.
- **Fix**: Base opacity 0.35, recent-2 at 0.5, recent-1 at 0.7. Tighten the scrolled-up override to 0.8.

**P1: Timestamp is `#C4B5A5` -- too faint**
- `--text-muted: #C4B5A5` on `#FAF8F5` is only ~1.8:1 contrast. The timestamp is genuinely useful during match review and needs to be readable.
- **Fix**: Use `#A89A8A` for timestamps (at minimum).

**P2: No visual legend for entity colours**
- First-time users have no idea what the underline colours mean. A subtle legend (either in a footer or on hover with a border-color label) would help.

**P2: Segment-pair inline-block layout creates ragged left edges**
- When `.show-translations` is active, each segment pair becomes `inline-block` with `vertical-align: top`. This creates an awkward layout where Italian text no longer flows as a continuous paragraph -- it becomes a choppy grid. On wide screens it looks like a table that forgot its columns.
- **Fix**: Consider a flexbox wrap layout or keep the paragraph flow and only show segment translations on hover/click.

**P2: Cost indicator typography**
- `$0.0023` in 11px muted text in the top bar is forgettable. Consider showing accumulated cost with a subtle dollar icon and round to 2 decimal places during live use (show 4 decimals only in session review).

---

## Expert 2 -- Interaction & Flow

### What works well

- **Start/Stop is clean.** Toggle between start/stop, status dot pulses, mic selector disables during capture. Solid.
- **Translation toggle** -- the `EN` button toggling `show-translations` on `<body>` is elegant. No JS per-line manipulation.
- **Scroll detection** -- detecting scroll-up during live mode and un-dimming the transcript is genuinely thoughtful UX. The 60px threshold for "at bottom" is well-tuned.
- **Sessions panel slide-out** with backdrop -- works intuitively. The left-border accent on the active session is a nice affordance.

### Issues

**P0: Session creation uses two `prompt()` dialogs -- this is unacceptable**
- `prompt('Session name:')` followed by `prompt('Match context:')` is the most un-premium interaction possible. It breaks flow, provides no input validation, looks terrible, and the second prompt asking for squad names/coaches/stadium expects the user to paste a wall of text into a native browser dialog.
- **Fix**: Replace with an inline panel or modal. A simple approach:
  - Add a form inside the sessions panel that slides down when "New" is clicked
  - Session name: text input with placeholder "e.g. Napoli vs Milan"
  - Context: `<textarea>` with placeholder "Paste squad names, coaches, stadium (optional)"
  - "Create" button
  - This can be pure HTML/CSS with no framework.

**P0: No way to edit or add context to an existing session**
- The match context is set at creation time and never editable. If the user forgets to paste the squad list or pastes the wrong one, there is no recourse except deleting and recreating.
- **Fix**: Add a small edit icon on the session name in the top bar, or an "Edit context" option in the sessions panel.

**P1: Delete uses `confirm()` -- inconsistent with the rest of the UI**
- The delete confirmation is a browser `confirm()` dialog. This is less offensive than `prompt()` but still breaks the premium feel.
- **Fix**: Inline confirmation. Change the "Del" button text to "Sure?" with red background on first click, then delete on second click. Auto-revert after 3 seconds.

**P1: Tab bar hidden until session loaded -- confusing empty state**
- The tab bar (Transcript/Vocab) is hidden with `.hidden` until a session loads. This means new users see the empty state with no indication that tabs exist. When a session loads, the tab bar pops in with no transition.
- **Fix**: Always show the tab bar but disable/grey-out when no session is active. Add a fade-in transition.

**P1: No keyboard shortcuts**
- A tool used alongside TV viewing should support keyboard shortcuts: Space to start/stop, T to toggle translations, Escape to close panels.
- **Fix**: Add `keydown` listener with the above mappings.

**P1: Very long lines have no visual treatment**
- Lines of 80-120 words (lines 26, 77, 122, 125, 138 in the Napoli session) create enormous text blocks with no visual break. The segments help when translations are visible, but with translations off, these are walls of text.
- **Fix**: Consider breaking lines with a subtle paragraph marker after ~60 words, or adding a slight left-border for long lines.

**P2: Session panel has no session search/filter**
- With 4 sessions this is fine. With 20+ (after a season), the list will need filtering.

**P2: No "export" functionality on vocab tab**
- The vocab tab collects idioms beautifully but offers no export. The CLAUDE.md mentions Anki export as a future feature -- this should be prioritised.

**P2: Mic selector shows "Loading devices..." briefly on page load**
- The flash of "Loading devices..." is noticeable. Use a placeholder that matches the final state better, or defer rendering until devices are loaded.

**P2: No visual indicator of "analysis in progress"**
- After `transcription.done` fires, there is a delay (1-5 seconds) before the `analysis` event arrives with translation/entities/idioms. During this gap, the line shows raw Italian with no loading indicator. The user might think the system is broken.
- **Fix**: Add a subtle shimmer or pulse to lines awaiting analysis.

---

## Expert 3 -- Data Quality & Pipeline

### What works well

- **Segment-level translation is genuinely excellent.** In the Napoli session, 752 segments across 191 lines, with an average of 4.9 words per segment. 0 segments exceeded 15 words. The clause-boundary splitting is natural and readable.
- **Entity recognition is strong.** 282 player entities, 38 team, 14 coach, 5 stadium across 137/191 lines. Types are well-categorised.
- **Idiom detection is genuinely impressive.** 219 idioms across 140/191 lines -- real Italian football expressions like "palla in verticale", "ripartenza", "uno contro uno", "sotto l'incrocio". These are authentic and educational.
- **Cost is very reasonable.** $0.44 total for 191 lines = $0.0023 per line average. A full 90-minute match at this rate costs roughly $0.45. That is extremely good value.

### Issues

**P0: 5 lines with `translation: null` (failed translations)**
- Lines 51, 77, 83, 122, 125 all have null translations, 0 segments, and $0.00 cost. These represent complete pipeline failures where the Claude API call either timed out or returned unparseable output.
- Line 83 is an advertisement ("BYD 122 Superliberta di EMAI, tua 149 euro al mese") -- the system should probably skip ad transcriptions, but even so it should not silently fail.
- Lines 51 (79 words), 77 (85 words), 122 (114 words), 125 (120 words) are all very long lines. The 1024 `max_tokens` limit in `translate.js` may be insufficient for lines this long, causing truncated JSON output.
- **Fix**:
  1. Increase `max_tokens` to 2048 for lines over 60 words.
  2. Add retry logic (at least 1 retry) on translation failure.
  3. Show a visual indicator on lines where translation failed (e.g. a subtle warning icon).
  4. Log the actual error for debugging.

**P0: Sentence boundary detection produces extreme variance**
- Min line length: 5 words. Max: 120 words. Average: 21.6 words.
- The `MIN_SENTENCE_LENGTH = 40` characters + `SENTENCE_END = /[.!?]\s*$/` logic in `server.js` relies entirely on Mistral producing punctuation. When the commentary stream lacks sentence-ending punctuation (common in rapid play-by-play), the buffer accumulates indefinitely.
- **Fix**: Add a hard maximum. If `sentenceBuffer` exceeds 300 characters (~50-60 words), force a finalization at the next comma, conjunction, or whitespace boundary.

```js
const MAX_SENTENCE_LENGTH = 300;
// In the event handler:
if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
} else if (sentenceBuffer.length >= MAX_SENTENCE_LENGTH) {
  // Force break at last comma or natural pause
  const breakIdx = sentenceBuffer.lastIndexOf(',');
  if (breakIdx > MIN_SENTENCE_LENGTH) {
    finalizeSentence(sentenceBuffer.slice(0, breakIdx + 1));
    sentenceBuffer = sentenceBuffer.slice(breakIdx + 1).trimStart();
  } else {
    finalizeSentence(sentenceBuffer);
    sentenceBuffer = '';
  }
}
```

**P1: Segment Italian text sometimes diverges from original transcription**
- The system prompt instructs Claude to correct player name misspellings in the segment `it` text. This means the segment Italian text can differ from the original transcription. For example, line 2: original has "Fucuca" but segment shows "Nkunku". This is intentional and useful, but means entity text-matching can fail when the entity `text` field matches the corrected name but the original text has the misspelled version.
- Observed: line 2 has entity `"text": "Kers"` but the segment says "Kers" -- this is the uncorrected version. Inconsistent with line 4 where original has "Kunku" but segment has "Nkunku".
- **Fix**: Entity text should match the *segment* text, not the original. The current prompt does say this, but enforcement is inconsistent. Consider a post-processing step that verifies each entity text appears in at least one segment.

**P1: "Modric" appears as a player in the Napoli vs Milan match**
- Line 7 has entity `"Modric"` but Luka Modric does not play for either Napoli or AC Milan. This is likely a speech recognition error (possibly "Lobotka" or another player) that the system confidently misidentified because the match context did not include Modric.
- Similarly, "Zaghi" in line 45 is not in either squad.
- **Fix**: When match context is provided, add validation that identified entities appear in the context. Flag unknown names in a different colour or add a "?" indicator.

**P1: 105 out of 752 segments (14%) have fewer than 3 words**
- Many segments are single-word player names ("Gutierrez.", "McTominay.", "Anguissa."). While these are technically correct segments, they create visual clutter when translations are shown -- each gets its own segment-pair block for just one word.
- **Fix**: Merge consecutive segments shorter than 3 words, or set a minimum segment length in the prompt.

**P2: Active "Full Match Test" session is receiving English audio**
- The test streaming `full-match.mp3` appears to be English commentary (lines like "Center side picks itself. It's pretty much the strongest 11 from last season"). The system dutifully tries to "translate" English into English, producing segments with Italian fabricated by Claude (e.g., `"it": "La formazione si sceglie da se."` for English input).
- This is a test issue, not a product bug, but the system should detect non-Italian audio and either warn or skip translation.
- **Fix**: Check `transcription.language` events from Mistral. If the detected language is not Italian, skip the Claude analysis and show the raw text with a "[non-Italian]" badge.

**P2: Ad transcriptions pollute the session**
- Line 83 is a car advertisement. These are common during match broadcasts and add noise to the transcript.
- **Fix**: Either detect ad-like patterns (brand names, pricing, financing terms) and auto-collapse them, or add a "hide" button per line.

**P2: Dedup regex may be too aggressive**
- The `dedup()` function in `server.js` removes repeated words, but the regex `\b(\w{2,4})\s+\1\w+\b` for stuttered beginnings could potentially mangle legitimate Italian words. For example, "tata tattica" (a legitimate phrase) could be corrupted. Testing with real data has not shown this, but it is a risk.

---

## Prioritised Improvement List

### P0 -- Must Fix
1. **Replace `prompt()` dialogs** for session creation with an inline form/modal
2. **Fix translation contrast** -- `#9A8E7F` is unreadable in bright light; use `#736860` or darker
3. **Add sentence length cap** (300 chars max) to prevent 80-120 word monster lines
4. **Handle translation failures** -- retry once, increase `max_tokens` for long lines, show visual indicator

### P1 -- Should Fix
5. **Allow editing session context** after creation
6. **Reduce base Italian font size** from 19px to 17px with max-width constraint
7. **Increase karaoke cascade base opacity** from 0.28 to 0.35
8. **Improve timestamp contrast** from `#C4B5A5` to `#A89A8A`
9. **Replace `confirm()` delete** with inline two-click confirmation
10. **Add keyboard shortcuts** (Space=start/stop, T=translations, Esc=close)
11. **Add "analysis pending" shimmer** to lines awaiting translation
12. **Validate entities against match context** to catch phantom players like "Modric"
13. **Merge very short segments** (<3 words) with adjacent segments
14. **Always show tab bar** with disabled state instead of hiding

### P2 -- Nice to Have
15. **Entity colour legend** somewhere in the UI
16. **Detect non-Italian audio** and skip translation
17. **Auto-collapse advertisement lines**
18. **Session search/filter** for the sessions panel
19. **Vocab/idiom export** (Anki format or CSV)
20. **Cost display improvements** (2 decimal places during live, 4 in review)
21. **Segment layout refinement** -- avoid choppy inline-block grid when translations are shown
22. **Loading state for mic selector** -- avoid "Loading devices..." flash

---

## Bugs Found

1. **Silent translation failures**: Lines 51, 77, 122, 125 have null translations with no error shown to the user and no retry. Cost is $0.00, indicating the API call failed before any tokens were consumed (likely timeout on long input).

2. **Entity text mismatch**: Entity `text` field sometimes matches the uncorrected original transcription rather than the corrected segment text, causing entity underlines to not render (the text-search highlighting looks for the entity text in the displayed HTML, but the displayed HTML may have the corrected spelling).

3. **Line 83 cost anomaly**: This line has `costUsd: 0.001204` but `translation: null` and 0 segments. This means the API was called and consumed tokens but returned unparseable output. The cost was tracked but the result was lost.

4. **English audio handling**: When non-Italian audio is fed in, Claude fabricates Italian text for the `it` fields in segments, creating a false impression that Italian was transcribed. The system should detect and handle this gracefully.

---

*Report generated by a panel of 3 UX experts reviewing Capito v0.2 (Phase 2)*
