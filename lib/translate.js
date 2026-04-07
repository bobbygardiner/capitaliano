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
Array of Italian idioms/expressions [{expression, meaning}] where meaning explains the football context. For idioms: only tag genuine Italian football expressions or culturally significant phrases. Do NOT tag: common Italian verbs with player names (e.g. "fa Calhanoglu"), basic Italian phrases that aren't football-specific (e.g. "per non rischiare nulla"), or garbled/nonsensical transcription fragments.

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
    cachedPrompt = matchContext ? `${SYSTEM_PROMPT}\n\nMatch context:\n${matchContext}` : SYSTEM_PROMPT;
  }
  const systemPrompt = cachedPrompt;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `"${italianText}"` },
      ],
    });

    const text = response.content[0]?.text || '';
    // Extract the first valid JSON object — Haiku sometimes adds text after it
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    const result = JSON.parse(jsonMatch[0]);

    // Calculate cost from usage
    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const costUsd = (inputTokens * INPUT_COST_PER_MTOK + outputTokens * OUTPUT_COST_PER_MTOK) / 1_000_000;

    return {
      translation: result.translation || null,
      segments: Array.isArray(result.segments) ? result.segments : [],
      entities: Array.isArray(result.entities) ? result.entities : [],
      idioms: Array.isArray(result.idioms) ? result.idioms : [],
      costUsd,
    };
  } catch (err) {
    console.error(`[capito] Translation failed: ${err.message}`);
    return null;
  }
}

async function analyzeCommentary(italianText, matchContext) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await tryAnalyze(italianText, matchContext);
    if (result) return result;
    if (attempt === 0) console.log('[capito] Translation retry...');
  }
  return null;
}

export { analyzeCommentary };
