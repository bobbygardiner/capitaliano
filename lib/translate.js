import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SYSTEM_CONTEXT = `You are an expert Italian-to-English football commentary translator.

Given Italian football commentary, return a JSON object with:

1. "segments": split the Italian text at natural clause boundaries (commas, conjunctions, relative pronouns, natural breath pauses) into chunks of roughly 5-15 words each. Return an array of {it, en} pairs where "it" is the Italian chunk and "en" is a natural English translation of that chunk. The Italian chunks must concatenate (with spaces) to reconstruct the original text. Each English chunk should read naturally on its own.

2. "translation": the full natural English translation as a single string (for fallback/accessibility)

3. "entities": array of named entities found [{text, type}] where type is "player"|"team"|"stadium"|"coach" and text is the entity as it appears in the Italian

4. "idioms": array of Italian idioms/expressions found [{expression, meaning}] where meaning explains what it means in football context

Use standard English football terminology (pitch, nil, match, etc).

Return ONLY valid JSON, no markdown, no explanation.`;

async function analyzeCommentary(italianText) {
  const prompt = `${SYSTEM_CONTEXT}\n\nAnalyze this Italian football commentary:\n\n"${italianText}"`;

  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt, '--output-format', 'json'], {
      timeout: 30000,
      maxBuffer: 128 * 1024,
    });

    const result = JSON.parse(stdout.trim());

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
