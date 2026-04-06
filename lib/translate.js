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

Given Italian football commentary, return a JSON object with:

1. "segments": split the Italian text at natural clause boundaries (commas, conjunctions, natural pauses) into chunks of roughly 5-15 words each. Return an array of {it, en} pairs where "it" is the Italian chunk (with player/team names corrected to their proper spelling using match context) and "en" is its English translation. Each English chunk should read naturally.

2. "translation": the full English translation as a single string

3. "entities": array of named entities [{text, type}] where type is "player"|"team"|"stadium"|"coach". IMPORTANT: "text" must be the SHORT name exactly as it appears in your corrected segment "it" text (e.g. use "Anguissa" not "Andre-Frank Zambo Anguissa", use "Milan" not "AC Milan"). Only include entities that actually appear in the segments text. Do NOT hallucinate entities that aren't mentioned.

4. "idioms": array of Italian idioms/expressions [{expression, meaning}] where meaning explains the football context

Use standard English football terminology (pitch, nil, match).
IMPORTANT: The Italian text comes from speech recognition which often misspells player names. Use the match context (if provided) to correct names to their proper spelling in both segments and entities. Only correct a name if the transcription is phonetically close to a player in the squad list. Do NOT substitute a completely different player — if unsure, keep the original transcription.
Return ONLY valid JSON.`;

async function analyzeCommentary(italianText, matchContext) {
  const systemPrompt = matchContext
    ? `${SYSTEM_PROMPT}\n\nMatch context:\n${matchContext}`
    : SYSTEM_PROMPT;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
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

export { analyzeCommentary };
