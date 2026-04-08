import Anthropic from '@anthropic-ai/sdk';

// Haiku pricing per million tokens (matches translate.js)
const INPUT_COST_PER_MTOK = 1.0;
const OUTPUT_COST_PER_MTOK = 5.0;

function calcCost(usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return (input * INPUT_COST_PER_MTOK + output * OUTPUT_COST_PER_MTOK) / 1_000_000;
}

let anthropic;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  }
  return anthropic;
}

const DEFAULT_PROMPT_HINT = 'full matchday squads (starting XI + bench), managers, competition, venue';

function buildPrompt(query, promptHint) {
  const hint = promptHint || DEFAULT_PROMPT_HINT;
  return `I'm building context for a live Italian transcription tool.
Search for context about: "${query}"

Find: ${hint}

Return ONLY valid JSON. Adapt the structure to the content type. For example, a football match might use:
{
  "match": "...",
  "competition": "...",
  "venue": "...",
  "managers": ["..."],
  "teams": [{ "name": "...", "squad": ["..."] }]
}

But a cooking show might use:
{
  "show": "...",
  "host": "...",
  "dishes": ["..."],
  "ingredients": ["..."]
}

Use whatever fields best capture the context for this content type.
Use names as they would appear on official sources.
Do not include generic vocabulary or anything not sourced from the web search.`;
}

async function searchContext(query, promptHint) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      { role: 'user', content: buildPrompt(query, promptHint) },
    ],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] },
    ],
  });

  // Extract text blocks (skip search result blocks)
  const textBlocks = response.content.filter(b => b.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  // Extract JSON from response
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in web search response');
  }

  const data = JSON.parse(jsonMatch[0]);

  return { data, costUsd: calcCost(response.usage) };
}

function buildContextString(data) {
  const lines = [];
  const handled = new Set();

  // Known football fields first (for backward compatibility)
  if (data.match) { lines.push(data.match); handled.add('match'); }
  if (data.competition) { lines.push(data.competition); handled.add('competition'); }
  if (data.venue) { lines.push(`Venue: ${data.venue}`); handled.add('venue'); }
  if (data.date) { lines.push(`Date: ${data.date}`); handled.add('date'); }
  if (data.managers?.length) { lines.push(`Managers: ${data.managers.join(', ')}`); handled.add('managers'); }
  if (data.teams?.length) {
    lines.push('');
    for (const team of data.teams) {
      lines.push(`${team.name}: ${team.squad.join(', ')}`);
    }
    handled.add('teams');
  }

  // Generic fallback for any other keys
  for (const [key, value] of Object.entries(data)) {
    if (handled.has(key)) continue;
    const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
    if (Array.isArray(value)) {
      lines.push(`${label}: ${value.join(', ')}`);
    } else if (typeof value === 'string') {
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join('\n');
}

export { searchContext, buildContextString };
