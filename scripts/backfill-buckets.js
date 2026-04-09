#!/usr/bin/env node
import { config } from 'dotenv';
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

const SESSIONS_DIR = 'sessions';
const MODEL = 'claude-haiku-4-5-20251001';
const INPUT_COST_PER_MTOK = 1.0;
const OUTPUT_COST_PER_MTOK = 5.0;
const VALID_BUCKETS = new Set(['common', 'intermediate', 'advanced']);
const CHUNK_SIZE = 40; // phrases per API call to stay within output token limits

const client = new Anthropic({ maxRetries: 2, timeout: 30_000 });

function calcCost(usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return (input * INPUT_COST_PER_MTOK + output * OUTPUT_COST_PER_MTOK) / 1_000_000;
}

async function listSessionFiles() {
  const entries = await readdir(SESSIONS_DIR);
  return entries
    .filter(f => f.startsWith('sess_') && f.endsWith('.json'))
    .map(f => join(SESSIONS_DIR, f));
}

function collectUnbucketed(session) {
  const unique = new Map();
  for (const line of session.lines || []) {
    for (const idiom of line.idioms || []) {
      if (idiom.bucket && VALID_BUCKETS.has(idiom.bucket)) continue;
      const key = (idiom.expression || '').trim().toLowerCase();
      if (!key) continue;
      if (!unique.has(key)) unique.set(key, idiom.expression);
    }
  }
  return [...unique.values()];
}

async function classifyChunk(expressions) {
  const systemPrompt = `You are classifying Italian football commentary phrases by difficulty for an intermediate Italian learner.

For each phrase, return a "bucket" of one of:
- "common": basic football vocabulary the learner already knows (e.g. "di testa")
- "intermediate": phrases a motivated learner would recognize
- "advanced": genuinely idiomatic or regional expressions

Return ONLY a JSON object: {"classifications": [{"expression": "...", "bucket": "..."}, ...]}
The classifications array must have the same length and order as the input phrases.`;

  const userMessage = `Classify these ${expressions.length} phrases:\n\n${expressions.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in response');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.classifications)) throw new Error('Missing classifications array');

  const byKey = new Map();
  for (const c of parsed.classifications) {
    if (!c?.expression) continue;
    const bucket = VALID_BUCKETS.has(c.bucket) ? c.bucket : 'intermediate';
    byKey.set(String(c.expression).trim().toLowerCase(), bucket);
  }
  return { byKey, cost: calcCost(response.usage) };
}

async function classifyBatch(expressions) {
  const allByKey = new Map();
  let totalCost = 0;
  for (let i = 0; i < expressions.length; i += CHUNK_SIZE) {
    const chunk = expressions.slice(i, i + CHUNK_SIZE);
    const { byKey, cost } = await classifyChunk(chunk);
    for (const [k, v] of byKey) allByKey.set(k, v);
    totalCost += cost;
  }
  return { byKey: allByKey, cost: totalCost };
}

function applyBuckets(session, byKey) {
  let updated = 0;
  for (const line of session.lines || []) {
    for (const idiom of line.idioms || []) {
      if (idiom.bucket && VALID_BUCKETS.has(idiom.bucket)) continue;
      const key = (idiom.expression || '').trim().toLowerCase();
      const bucket = byKey.get(key) || 'intermediate';
      idiom.bucket = bucket;
      updated++;
    }
  }
  return updated;
}

async function processSession(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const session = JSON.parse(raw);
  const expressions = collectUnbucketed(session);
  if (!expressions.length) {
    console.log(`[skip] ${session.id} — no unbucketed idioms`);
    return 0;
  }
  console.log(`[classify] ${session.id} (${session.name}) — ${expressions.length} unique phrases`);
  const { byKey, cost } = await classifyBatch(expressions);
  const updated = applyBuckets(session, byKey);
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(session, null, 2));
  await rename(tmp, filePath);
  console.log(`[write]    ${session.id} — updated ${updated} idioms, cost $${cost.toFixed(4)}`);
  return cost;
}

async function main() {
  const files = await listSessionFiles();
  console.log(`Found ${files.length} session files`);
  let total = 0;
  for (const f of files) {
    try {
      total += await processSession(f);
    } catch (err) {
      console.error(`[error] ${f}: ${err.message}`);
    }
  }
  console.log(`Done. Total cost: $${total.toFixed(4)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
