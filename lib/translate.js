import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  maxRetries: 2,
  timeout: 15_000,
});

const SYSTEM_PROMPT = `You are an expert Italian-to-English football commentary translator.

Given Italian football commentary, return a JSON object with:

1. "segments": split the Italian text at natural clause boundaries (commas, conjunctions, natural pauses) into chunks of roughly 5-15 words each. Return an array of {it, en} pairs where "it" is the Italian chunk and "en" is its English translation. The Italian chunks must concatenate (with spaces) to reconstruct the original text. Each English chunk should read naturally.

2. "translation": the full English translation as a single string

3. "entities": array of named entities [{text, type}] where type is "player"|"team"|"stadium"|"coach" and text is as it appears in the Italian

4. "idioms": array of Italian idioms/expressions [{expression, meaning}] where meaning explains the football context

Use standard English football terminology (pitch, nil, match).
Return ONLY valid JSON.`;

async function analyzeCommentary(italianText) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `"${italianText}"` },
      ],
    });

    const text = response.content[0]?.text || '';
    // Strip markdown code blocks if present
    const jsonStr = text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    const result = JSON.parse(jsonStr);

    return {
      translation: result.translation || null,
      segments: Array.isArray(result.segments) ? result.segments : [],
      entities: Array.isArray(result.entities) ? result.entities : [],
      idioms: Array.isArray(result.idioms) ? result.idioms : [],
    };
  } catch (err) {
    console.error(`[capito] Translation failed: ${err.message}`);
    return null;
  }
}

export { analyzeCommentary };
