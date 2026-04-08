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

const PROMPT_TEMPLATE = `I'm building context for a live Italian transcription tool. Search for the full matchday squads (not just starting XI — include substitutes) for this match: "{query}"

Return ONLY valid JSON with this structure:
{
  "match": "Team A vs Team B",
  "competition": "...",
  "venue": "...",
  "date": "...",
  "managers": ["...", "..."],
  "teams": [
    { "name": "...", "squad": ["Player Name", "..."] }
  ]
}

Include the full matchday squad (starting XI + bench) for each team. Use the player names as they would appear on official teamsheets. Do not include generic vocabulary or anything not sourced from the web search.`;

async function searchContext(query) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      { role: 'user', content: PROMPT_TEMPLATE.replace('{query}', query) },
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

  if (data.match) lines.push(data.match);
  if (data.competition) lines.push(data.competition);
  if (data.venue) lines.push(`Venue: ${data.venue}`);
  if (data.date) lines.push(`Date: ${data.date}`);
  if (data.managers?.length) lines.push(`Managers: ${data.managers.join(', ')}`);

  if (data.teams) {
    lines.push('');
    for (const team of data.teams) {
      lines.push(`${team.name}: ${team.squad.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export { searchContext, buildContextString };
