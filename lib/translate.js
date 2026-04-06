import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SYSTEM_CONTEXT = `You are an expert Italian-to-English football commentary translator.

Given Italian football commentary, return a JSON object with:
1. "translation": natural English translation preserving commentator energy
2. "entities": array of named entities found [{text, type, start, end}] where type is "player"|"team"|"stadium"|"coach" and start/end are character offsets in the Italian text
3. "idioms": array of Italian idioms/expressions found [{expression, meaning}] where meaning explains what it means in football context

Use standard English football terminology (pitch, nil, match, etc).

Return ONLY valid JSON, no markdown, no explanation.`;

async function analyzeCommentary(italianText) {
  const prompt = `${SYSTEM_CONTEXT}\n\nAnalyze this Italian football commentary:\n\n"${italianText}"`;

  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt, '--output-format', 'json'], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    const result = JSON.parse(stdout.trim());

    // Validate basic shape
    return {
      translation: result.translation || null,
      entities: Array.isArray(result.entities) ? result.entities : [],
      idioms: Array.isArray(result.idioms) ? result.idioms : [],
    };
  } catch (err) {
    console.error(`[capito] Translation failed: ${err.message}`);
    return null;
  }
}

export { analyzeCommentary };
