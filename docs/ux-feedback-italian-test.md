# UX Expert Panel Review: Italian Commentary Test (Inter-Roma)

**Session:** Inter-Roma Test (Italian) (`sess_1775562257553`)
**Date:** 2026-04-07
**Duration monitored:** ~4 minutes of live streaming
**Lines captured:** 27 (lines 0-26)
**API checks:** 3 checks over ~3 minutes (0 lines -> 14 -> 20 -> 27)

---

## Data Quality Metrics

| Metric | Value |
|--------|-------|
| Total lines | 27 |
| Lines with translations | 27 (100%) |
| Lines with segments | 27 (100%) |
| Lines with entities | 20 (74%) |
| Lines with idioms | 22 (81%) |
| Total entities found | 46 |
| Total idioms found | 34 |
| Total session cost | $0.0563 |
| Avg cost per line | $0.0021 |
| Entity types: player | 36 (78%) |
| Entity types: team | 8 (17%) |
| Entity types: stadium | 1 (2%) |
| Entity types: coach | 1 (2%) |

---

## Expert 1 -- Translation Quality

### Overall Rating: 8/10

### Segment Splitting

Segmentation is excellent across the board. The system consistently produces segments in the 3-12 word range, which is ideal for language learners. Long commentary sentences are broken into digestible meaning units.

**Best example -- Line 1 (complex opening monologue):**
A 50-word Italian sentence is split into 7 clean segments, each a natural phrase boundary:
- "pieno questo Inter-Roma di domande sulla corsa a Scudetto" -> "this Inter-Roma match full of questions about the Serie A title race"
- "sul finale di campionato." -> "on the final stretch of the campaign."

**Best example -- Line 14 (fast action sequence):**
6 segments tracking rapid match action:
- "taglio di Dumfries," -> "Dumfries cuts inside,"
- "a sinistra Lautaro servito," -> "Lautaro picked out on the left,"

### Translation Accuracy

Most translations are natural and capture the energy of Italian commentary well.

**Strong translations:**
- Line 9: "inchioda di testa Sommer, ha pareggiato la Roma, 1-1 a 5 dell'intervallo" -> "nails it with a header past Sommer, Roma have equalized, 1-1 with five minutes to half-time" -- captures the urgency perfectly
- Line 19: "che urla il campionato, la sua voglia di tricolore" -> "who are shouting for the title, their hunger for the trophy" -- great energy preservation
- Line 15: "Deus Ex Machina dell'Inter" -> "Inter's saviour" -- appropriately simplified for English readers
- Line 25: "torna la sua anima, torna Lautaro Martinez" -> "his soul returns, Lautaro Martinez returns" -- preserves the rhetorical repetition

### Translation Issues

**Line 4 (P1 -- poor translation):**
- IT: "Turam, tu hai dentro da l'autore, subito la Tula!"
- EN: "Thuram, you're in from the author, quickly the Tula!"
- Problem: The translation is nearly nonsensical. "l'autore" and "la Tula" are likely transcription artifacts that the model failed to interpret. The translation should have attempted to convey the meaning (likely "Thuram, you've cut inside, quick, the shot!") rather than translating garbled words literally.

**Line 17 (P1 -- literal non-translation):**
- IT: "Poche Inter. Poche Inter. Marcus Thuram 4-1."
- EN: "Few Inter. Few Inter. Marcus Thuram 4-1."
- Problem: "Poche" is almost certainly a misheard "Forza" or commentary exclamation. The translation "Few Inter" is meaningless. The system should flag uncertain transcriptions rather than translate them literally.

**Line 11 (P2 -- segment mismatch):**
- Original IT has "Bucasvilar" but the segment shows "Buonasera, 2-1 per l'Inter!" -- the model replaced a garbled word with a plausible Italian word ("Buonasera") in the segment but this doesn't match the original transcription. This is actually a reasonable recovery, but the segment IT text now diverges from the raw transcript.

**Line 13 (P2 -- hallucinated entity):**
- IT: "Destro, tremendo, di accanciare la Noglu."
- EN: "Right foot, tremendous, to set up Nkunku."
- Problem: "Nkunku" is not in either squad. The model hallucinated a player name to fill a garbled transcription.

---

## Expert 2 -- Entity Recognition

### Overall Rating: 8.5/10

### Name Correction from Transcription Errors

The squad context is working exceptionally well. The system consistently corrects misheard player names in the segment text while preserving the original (garbled) transcription in the raw text field.

**Excellent corrections:**

| Raw Transcription | Corrected To | In Squad? |
|-------------------|-------------|-----------|
| "Turam" | "Thuram" | Yes (Inter) |
| "Ciaranoglu" | "Calhanoglu" | Yes (Inter) |
| "Cianoglu" | "Calhanoglu" | Yes (Inter) |
| "Macini" | "Mancini" | Yes (Roma) |
| "Di Casta" | "Dybala" | Yes (Roma) |
| "Maggini" | "Mancini" | Yes (Roma) |
| "D'Arench" | "Dimarco" | Yes (Inter) |
| "Paolo Otaro Martinez" | "Lautaro Martinez" | Yes (Inter) |
| "Turan" | "Thuram" | Yes (Inter) |
| "Marcos Turam" | "Marcus Thuram" | Yes (Inter) |

This is the system's strongest feature. Transcription of foreign names during fast Italian commentary is inherently noisy, and the squad context resolves these beautifully.

### Entity Type Accuracy

Entity types are correct across the dataset:
- **Players** (Thuram, Calhanoglu, Barella, Lautaro Martinez, etc.) -- all correctly tagged as `player`
- **Teams** (Inter, Roma) -- correctly tagged as `team`
- **Stadium** (San Siro) -- correctly tagged as `stadium`
- **Coach** (Dario Marcolin) -- tagged as `coach` (though Marcolin is actually a commentator/pundit, not a coach; he is a former player turned TV analyst)

### Entity Issues

**Line 5 -- Phantom entity:**
- Entities include `{"text":"Lautaro Martinez","type":"player"}` but "Lautaro Martinez" does not appear in the Italian text ("Dopo un minuto a sboccare la partita, Marcos Turam per il capitano!"). The model inferred "il capitano" = Lautaro Martinez and added him as an entity, but his name text does not appear in the segment. This is semantically correct but violates the principle that entity text should match actual text in the line.

**Line 7 -- Uncorrected name:**
- "Paolo Malen" appears in both the raw text and segment text but does not match any squad member. This might be a commentator name or a garbled player name that the model couldn't resolve. No entity was created for it, which is the correct decision (avoid guessing).

**Line 13 -- Hallucinated player:**
- "Nkunku" appears in the segment translation but is not in either squad roster and no entity was created. However the segment Italian text says "la Nkunku" which is a fabricated correction of "la Noglu." The model should have left this uncorrected or flagged it as unknown.

**Line 20 -- Missing entity corrections:**
- "Zielinski," "Pisilli," "Malene," "Cervi" -- several player names appear but only Pellegrini gets an entity. "Zielinski" is plausible (former Serie A player) but not in the provided squad. The others ("Pisilli," "Malene," "Cervi") are likely garbled names that the model couldn't match.

**Line 1 -- Coach vs Commentator:**
- Dario Marcolin is tagged as `coach` but he is a TV commentator. The system needs a `commentator` entity type, or at minimum should not tag non-match participants as coaches.

---

## Expert 3 -- Idiom & Vocabulary Quality

### Overall Rating: 9/10

### Genuine Football Idioms Detected

The idiom detection is the standout feature of this session. 34 idioms were found across 27 lines -- most are authentic Italian football vocabulary that would be genuinely useful for language learners.

**Excellent idiom picks (genuinely educational):**

| Expression | Meaning | Quality |
|-----------|---------|---------|
| "movimento profondo" | a deep run into the attacking third | Authentic football term, perfectly explained |
| "palla in verticale" | a vertical pass that breaks defensive lines | Core tactical vocabulary |
| "inchioda di testa" | nails it with a header | Vivid, common in commentary |
| "tiro da lontano" | a long-range shot | Essential vocabulary |
| "sulla respinta" | on the rebound/deflection | Common match term |
| "voglia di tricolore" | desire to win the Italian championship | Cultural + football fusion |
| "sboccare la partita" | to open/unlock the match | Authentic commentary expression |
| "rimettere in partita" | to get back into the match | Very commonly used |
| "rush finale per lo scudetto" | final push for the title | Commentary staple |
| "schiantando la Roma" | crushing Roma | Vivid and accurate |
| "Come un duomo" | like a cathedral (spectacular goal) | Brilliant cultural reference |
| "Deus Ex Machina" | a saviour figure arriving at a crucial moment | Elevated commentary vocabulary |

**Good contextual idioms:**
- "pesano tanto sul finale di campionato" -- "carry significant weight for the final stretch" -- useful full phrase
- "fresco di trauma nazionale" -- "recently affected by national team difficulties" -- contextual expression
- "3 contro 2" -- "numerical advantage" -- tactical vocabulary
- "torna la sua anima" -- "the team's spirit returns" -- poetic commentary

### Borderline / Questionable Idioms

**Line 10 -- "fa Calhanoglu" tagged as idiom:**
- Meaning given: "Calhanoglu takes the shot; the player shoots at goal"
- Issue: "fa" + [player name] is standard Italian (he does it / he shoots), not really an idiom. This is a common verb usage, not a football-specific expression. **False positive.**

**Line 22 -- "mano aperta" tagged as idiom:**
- Meaning given: "open hand - a handball infraction"
- Issue: This is not a standard football idiom. "Fallo di mano" is the real term. "Mano aperta" literally means "open hand" and the explanation about handball appears to be fabricated context. **False positive.**

**Line 8 -- "per non rischiare nulla" tagged as idiom:**
- Meaning given: "a cautious play to avoid giving away possession"
- Issue: This is just standard Italian ("to not risk anything"), not a football-specific idiom. It is commonly used but not vocabulary worth highlighting separately. **Borderline.**

**Line 6 -- "si viene subito" tagged as idiom:**
- Meaning given: "immediately gets involved in the action"
- Issue: This is garbled Italian (the original transcription is imperfect). The expression as transcribed is not a real idiom. **False positive based on bad transcription.**

### Vocab Panel Data Quality

With 34 idioms detected across 27 lines, the vocab panel would be rich. The context snippets (pulled from the original Italian text) provide good learning material. The expressions cover:
- **Tactical terms:** movimento profondo, palla in verticale, 3 contro 2, tiro da lontano
- **Action verbs:** inchioda, sboccare, schiantare
- **Match vocabulary:** calcio d'angolo, respinta, pareggiare, rimettere in partita
- **Cultural/poetic:** voglia di tricolore, come un duomo, Deus Ex Machina, torna la sua anima

This is a strong vocabulary set. A learner watching Italian football would benefit significantly from these annotations.

### False Positive Rate

Approximately 3-4 out of 34 idioms are false positives (9-12%), which is acceptable but could be improved. The main pattern is tagging common Italian phrases (not football-specific) or player-name phrases as idioms.

---

## P0/P1 Fix Verification (CSS/JS)

### Confirmed Fixes in Place

1. **Segmented inline display** -- CSS classes `.line-segments`, `.segment-pair`, `.segment-italian`, `.segment-translation` all present and styled. Segments flow inline as intended (`display: inline` for `.segment-pair`).

2. **Entity highlighting** -- `[data-entity]` CSS with underline styling, color-coded by type (player/team/stadium/coach). Hover states with `color-mix` background. `highlightEntitiesHtml()` applies highlights with longest-first sorting to avoid partial matches.

3. **Idiom tooltips** -- `[data-idiom]::before` pseudo-element with tooltip positioning, hover reveal, and `.tooltip-below` flip for elements near top of viewport. `highlightIdiomsHtml()` applies dotted underline + tooltip on hover.

4. **Karaoke cascade** -- `.transcript.live .transcript-line` opacity cascade (active=1.0, recent-1=0.7, recent-2=0.5, older=0.35). `updateLineClasses()` efficiently updates only last 4 elements.

5. **Scroll detection** -- `.scrolled-up` class added when user scrolls up during live mode, which un-dims older lines for readability (opacity: 0.8).

6. **Translation toggle** -- `body.show-translations` class toggles segment translations between `display: none` and `display: block`. EN toggle button with active state.

7. **Tab switching** -- Transcript/Vocab tabs with proper active state management.

8. **Cost tracking** -- `costIndicator` updated per-line via `event.costUsd`, displayed as `$0.0563` format.

9. **Pending analysis shimmer** -- `.pending-analysis` class adds shimmer animation to lines awaiting LLM response.

10. **Session management** -- Edit context modal, delete confirmation with 3-second timeout, end session functionality all present.

11. **Persistent WebSocket** -- Auto-reconnect with 3-second backoff. Binary audio streaming with backpressure check (`bufferedAmount < 65536`).

12. **Entity + Idiom highlighting in segments** -- `applySegments()` correctly applies both `highlightEntitiesHtml()` and `highlightIdiomsHtml()` to each segment's Italian text.

### No Missing P0/P1 Fixes Detected

All critical UX features appear to be implemented and wired up correctly.

---

## Summary of Remaining Issues

### P1 (Should Fix)

1. **Literal translation of garbled text (Lines 4, 17):** When the transcription is garbled beyond recognition, the translation should either attempt semantic interpretation from context or flag the line as "unclear" rather than producing nonsensical English.

2. **Hallucinated player name (Line 13):** "Nkunku" is not in either squad. The entity correction system should refuse to substitute names not in the squad context.

3. **Coach entity type for commentator (Line 1):** Dario Marcolin is a commentator, not a coach. Either add a `commentator` type or don't tag non-match participants.

### P2 (Nice to Fix)

4. **Phantom entities (Line 5):** Entity text ("Lautaro Martinez") should match text actually present in the line. Inferred entities (from "il capitano") should use the text as it appears.

5. **False positive idioms (~4 instances):** "fa Calhanoglu", "mano aperta", "si viene subito" are not genuine football idioms. Tighten idiom detection to avoid tagging common Italian phrases.

6. **Segment text divergence from raw transcript (Line 11):** "Bucasvilar" -> "Buonasera" in segments is a creative recovery but means segment Italian text no longer matches the raw `text` field. Consider whether segments should be corrections of the transcript or faithful to it.

7. **Uncorrected names (Line 20):** Several potential player names ("Pisilli", "Malene", "Cervi") went without entity correction or flagging. When names are unresolvable, they should be left as-is (which they were), but the translation also failed to resolve them.

### P3 (Minor)

8. **Translation inconsistency with "Marcos" vs "Marcus":** The transcript uses both "Marcos Turam" (line 5) and "Marcus Thuram" (line 16-17). The segment corrections alternate between "Marcos Thuram" and "Marcus Thuram". Should be standardized to match the squad context ("Marcus Thuram").

9. **Line 10 translation stutter:** "Bastoni, Calhanoglu, Calhanoglu," -- the doubled "Calhanoglu" in the segment may be from replacing two different garbled names ("Zielinski, Ciaranoglu") with one corrected name. "Zielinski" was dropped and "Ciaranoglu" corrected, resulting in an inaccurate segment.

---

## Verdict

The system performs impressively well on live Italian football commentary. Entity correction via squad context is the strongest feature -- resolving "Ciaranoglu" to "Calhanoglu" and "Turam" to "Thuram" consistently is a major usability win. Idiom detection produces genuinely educational vocabulary with a low false-positive rate. Segment splitting is clean and natural. Translations capture commentary energy well in most cases but break down when facing heavily garbled transcription input. Cost is very reasonable at ~$0.002 per line.

**Recommendation:** Ship as-is, with priority fixes for literal translation of garbled text (P1) and hallucinated entity names (P1).
