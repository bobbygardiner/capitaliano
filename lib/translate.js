import Anthropic from '@anthropic-ai/sdk';

// Lazy-init: dotenv hasn't loaded yet when this module is imported
let anthropic;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ maxRetries: 2, timeout: 15_000 });
  }
  return anthropic;
}

// Haiku pricing per million tokens
const INPUT_COST_PER_MTOK = 1.0;
const OUTPUT_COST_PER_MTOK = 5.0;

function calcCost(usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return (input * INPUT_COST_PER_MTOK + output * OUTPUT_COST_PER_MTOK) / 1_000_000;
}

const VALID_BUCKETS = new Set(['common', 'intermediate', 'advanced']);

function normalizeIdiom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bucket = VALID_BUCKETS.has(raw.bucket) ? raw.bucket : 'intermediate';
  return {
    expression: raw.expression,
    meaning: raw.meaning,
    bucket,
  };
}

function normalizeAnalysis(result, costUsd) {
  const rawIdioms = Array.isArray(result.idioms) ? result.idioms : [];
  return {
    translation: result.translation || null,
    segments: Array.isArray(result.segments) ? result.segments : [],
    entities: Array.isArray(result.entities) ? result.entities : [],
    idioms: rawIdioms.map(normalizeIdiom).filter(Boolean),
    costUsd,
  };
}

async function withRetry(fn, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fn();
    if (result) return result;
    if (attempt === 0) console.log(`[capitaliano] ${label} retry...`);
  }
  return null;
}

function buildSystemPrompt(basePrompt, matchContext) {
  return matchContext ? `${basePrompt}\n\nMatch context:\n${matchContext}` : basePrompt;
}

const SYSTEM_PROMPT = `You are an expert Italian-to-English football commentary translator.

Given Italian football commentary, return a JSON object with these four fields:

## 1. "segments"
Split the Italian text at natural clause boundaries (commas, conjunctions, natural pauses) into chunks of roughly 5-15 words each. Return an array of {it, en} pairs where "it" is the Italian chunk (with player/team names corrected to their proper spelling using match context) and "en" is its English translation. Each English chunk should read naturally. Avoid segments shorter than 3 words — merge short fragments with the adjacent clause.

When correcting player names in segments, only correct names you can confidently match to the squad list. For completely unrecognizable garbled text, keep the original transcription rather than substituting a different word.

Use consistent spelling for player names throughout — always use the exact spelling from the match context (e.g. always "Marcus Thuram" not "Marcos Thuram").

## 2. "translation"
The full English translation as a single string.

## 3. "entities"
Array of named entities [{text, type}] where type is "player"|"team"|"stadium"|"coach". "text" must be the SHORT name exactly as it appears in your corrected segment "it" text (e.g. use "Anguissa" not "Andre-Frank Zambo Anguissa", use "Milan" not "AC Milan"). Only include entities that actually appear in the segments text.

STRICT RULE: Only include entities for names that appear in the match context squad list. If a transcribed name cannot be phonetically matched to any player in the squad list, do NOT create an entity for it. Never invent or guess player names that aren't in the context.

Commentators and TV presenters mentioned at the start of broadcasts are NOT coaches. Only tag actual match coaches (listed in the match context) as type "coach". If you detect a commentator/presenter name, skip it — do not create an entity.

## 4. "idioms"
Array of Italian idioms/expressions [{expression, meaning, bucket}] where meaning explains the football context. For idioms: only tag genuine Italian football expressions or culturally significant phrases. Do NOT tag: common Italian verbs with player names (e.g. "fa Calhanoglu"), basic Italian phrases that aren't football-specific (e.g. "per non rischiare nulla"), or garbled/nonsensical transcription fragments.

For each idiom, set "bucket" to one of "common", "intermediate", or "advanced" reflecting how likely an intermediate Italian learner is to already know the phrase. Use "common" for basic football vocabulary (e.g. "di testa"), "intermediate" for phrases a motivated learner would recognize, and "advanced" for genuinely idiomatic or regional expressions.

## General rules
Use standard English football terminology (pitch, nil, match).

The Italian text comes from speech recognition which often misspells player names. Use the match context (if provided) to correct names to their proper spelling in both segments and entities. Consider how Italian commentators pronounce foreign names — e.g. "Cucu" is how Italians say "Nkunku", "Oion" could be "Hojlund". Be generous with phonetic matching but don't substitute a completely different player if there's no phonetic resemblance.

If the Italian transcription is garbled or nonsensical (common with speech recognition of fast commentary), do NOT translate it literally. Instead, try to interpret the intended meaning from context. If you cannot determine the meaning, keep the garbled Italian in the segment "it" field but set the "en" translation to "[unclear]" rather than producing nonsensical English.

Return ONLY valid JSON.`;

let cachedContext = null;
let cachedPrompt = null;

async function tryAnalyze(italianText, matchContext) {
  if (matchContext !== cachedContext) {
    cachedContext = matchContext;
    cachedPrompt = buildSystemPrompt(SYSTEM_PROMPT, matchContext);
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: cachedPrompt,
      messages: [{ role: 'user', content: `"${italianText}"` }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');

    return normalizeAnalysis(JSON.parse(jsonMatch[0]), calcCost(response.usage));
  } catch (err) {
    console.error(`[capitaliano] Translation failed: ${err.message}`);
    return null;
  }
}

async function analyzeCommentary(italianText, matchContext) {
  return withRetry(() => tryAnalyze(italianText, matchContext), 'Translation');
}

const SPLIT_SYSTEM_PROMPT = `You are an expert Italian-to-English football commentary translator.

You will receive an improved Italian transcription and the original line splits it corresponds to. Your job is to:
1. Distribute the improved text across the original line boundaries (same number of lines)
2. For each line, produce the same analysis as a standard commentary translation

Return a JSON array where each element has: {segments, translation, entities, idioms}.
- "segments": array of {it, en} pairs (Italian chunk + English translation)
- "translation": full English translation of that line
- "entities": [{text, type}] where type is "player"|"team"|"stadium"|"coach"
- "idioms": [{expression, meaning, bucket}] — bucket is one of "common" | "intermediate" | "advanced" reflecting whether an intermediate Italian learner would already know the phrase

Use the match context (if provided) to correct player name spellings.
Return ONLY valid JSON (a JSON array, not wrapped in an object).`;

async function trySplitAnalyze(batchText, originalTexts, matchContext) {
  const userMessage = `Improved transcription:
"${batchText}"

Original line splits (preserve this exact number of lines):
${originalTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: buildSystemPrompt(SPLIT_SYSTEM_PROMPT, matchContext),
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    const result = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(result) || result.length !== originalTexts.length) {
      throw new Error(`Expected ${originalTexts.length} results, got ${Array.isArray(result) ? result.length : 'non-array'}`);
    }

    const costEach = calcCost(response.usage) / originalTexts.length;
    return result.map(r => normalizeAnalysis(r, costEach));
  } catch (err) {
    console.error(`[capitaliano] splitAndAnalyze failed: ${err.message}`);
    return null;
  }
}

async function splitAndAnalyze(batchText, originalTexts, matchContext) {
  return withRetry(() => trySplitAnalyze(batchText, originalTexts, matchContext), 'splitAndAnalyze');
}

const MERGE_SYSTEM_PROMPT = `You are an expert Italian-to-English football commentary translator.

You will receive TWO transcriptions of the same Italian football commentary audio:
1. **Realtime transcription** — produced by a fast streaming model. May have garbled player names but preserves phonetic hints (e.g. "Akancalanoglu" = Calhanoglu, "Turam" = Thuram). May also contain content that the batch version missed.
2. **Batch transcription** — produced by a slower model with name hints. Has better punctuation and sentence structure, but may have completely misheard some words or dropped content.

Your job: produce the BEST possible Italian text by merging both sources. Specifically:
- NEVER drop content that appears in either source. If the realtime version has words/phrases the batch version missed, you MUST include them. If the batch version has content the realtime missed, include that too. The merged text should be the UNION of both, not just one or the other.
- Use the realtime version as the primary source for CONTENT (what was actually said). Use the batch version to improve punctuation, spacing, and structure.
- When the realtime version has a garbled name that phonetically matches a player in the match context, use the correct spelling (even if the batch version heard something completely different)
- When the batch version corrected a name that the realtime garbled, keep the batch correction
- When in doubt, keep more content rather than less — it's better to include a slightly garbled phrase than to drop it entirely

Then translate and analyze the merged result.

Return a JSON object with these fields:
1. "text" — the merged Italian text (best of both sources, with corrected names)
2. "segments" — array of {it, en} pairs at natural clause boundaries (5-15 words each)
3. "translation" — full English translation
4. "entities" — [{text, type}] where type is "player"|"team"|"stadium"|"coach"
5. "idioms" — [{expression, meaning, bucket}] for genuine Italian football expressions; bucket is "common" | "intermediate" | "advanced" reflecting whether an intermediate Italian learner would already know the phrase

Return ONLY valid JSON.`;

async function tryMergeAnalyze(realtimeText, batchText, matchContext) {
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: buildSystemPrompt(MERGE_SYSTEM_PROMPT, matchContext),
      messages: [{ role: 'user', content: `Realtime transcription:\n"${realtimeText}"\n\nBatch transcription:\n"${batchText}"` }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    const result = JSON.parse(jsonMatch[0]);

    return {
      text: result.text || batchText,
      ...normalizeAnalysis(result, calcCost(response.usage)),
    };
  } catch (err) {
    console.error(`[capitaliano] mergeAndAnalyze failed: ${err.message}`);
    return null;
  }
}

async function mergeAndAnalyze(realtimeText, batchText, matchContext) {
  return withRetry(() => tryMergeAnalyze(realtimeText, batchText, matchContext), 'mergeAndAnalyze');
}

export { analyzeCommentary, splitAndAnalyze, mergeAndAnalyze, normalizeAnalysis };
