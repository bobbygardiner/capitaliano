import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const CT_PATH = 'content-types.json';

let anthropic;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ maxRetries: 2, timeout: 30_000 });
  }
  return anthropic;
}

function slugify(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function list() {
  const data = await readFile(CT_PATH, 'utf-8');
  return JSON.parse(data);
}

async function add(label) {
  const id = slugify(label);
  const types = await list();
  if (types.find(t => t.id === id)) {
    throw new Error(`Content type "${id}" already exists`);
  }

  const promptHint = await generatePromptHint(label);
  const newType = { id, label: label.trim(), promptHint };
  types.push(newType);
  await writeFile(CT_PATH, JSON.stringify(types, null, 2));
  return newType;
}

async function generatePromptHint(label) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `Given a content type called "${label}", what specific context should I search for to help with live Italian transcription? Reply with ONLY a short comma-separated list of what to find (e.g. "host names, guest names, topics discussed"). No explanation, just the list.`,
      },
    ],
  });

  const text = response.content[0]?.text?.trim();
  if (!text) throw new Error('Failed to generate prompt hint');
  return text;
}

export { list, add, generatePromptHint, slugify };
