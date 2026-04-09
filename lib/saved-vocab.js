import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';

let state = { entries: [] };
let dirty = false;
let flushTimer = null;
let activeFilePath = null;

function normalize(expression) {
  return String(expression || '').trim().toLowerCase();
}

function startFlushTimer() {
  stopFlushTimer();
  flushTimer = setInterval(() => {
    flush().catch(err => console.error('[capitaliano] saved-vocab flush error:', err));
  }, 5000);
}

function stopFlushTimer() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

async function init(filePath) {
  activeFilePath = filePath;
  state = { entries: [] };
  dirty = false;

  if (!existsSync(filePath)) {
    await writeFile(filePath, JSON.stringify(state, null, 2));
  } else {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        state = { entries: parsed.entries };
      }
    } catch (err) {
      console.error('[capitaliano] saved-vocab.json corrupted — renaming to .bak and starting empty:', err.message);
      await rename(filePath, filePath + '.bak');
      await writeFile(filePath, JSON.stringify(state, null, 2));
    }
  }

  startFlushTimer();
}

function list() {
  return [...state.entries].sort((a, b) => {
    const ta = new Date(a.savedAt).getTime();
    const tb = new Date(b.savedAt).getTime();
    return tb - ta;
  });
}

function findByExpression(expression) {
  const key = normalize(expression);
  return state.entries.find(e => normalize(e.expression) === key);
}

function has(expression) {
  return !!findByExpression(expression);
}

async function add({ expression, meaning, bucket, source }) {
  const existing = findByExpression(expression);
  if (existing) {
    const dup = existing.sources.find(s => s.sessionId === source.sessionId && s.lineId === source.lineId);
    if (!dup) {
      existing.sources.push(source);
      dirty = true;
    }
    return { entry: existing, created: false };
  }

  const entry = {
    id: `sv_${Date.now()}${Math.floor(Math.random() * 1000)}`,
    expression: String(expression).trim(),
    meaning: meaning || '',
    bucket: bucket || 'intermediate',
    savedAt: new Date().toISOString(),
    sources: [source],
  };
  state.entries.push(entry);
  dirty = true;
  return { entry, created: true };
}

async function remove(expression) {
  const key = normalize(expression);
  const before = state.entries.length;
  state.entries = state.entries.filter(e => normalize(e.expression) !== key);
  const removed = state.entries.length < before;
  if (removed) dirty = true;
  return removed;
}

async function flush() {
  if (!dirty || !activeFilePath) return;
  const tmp = activeFilePath + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, activeFilePath);
  dirty = false;
}

async function shutdown() {
  stopFlushTimer();
  await flush();
  activeFilePath = null;
  state = { entries: [] };
  dirty = false;
}

export { init, list, has, add, remove, flush, shutdown };
