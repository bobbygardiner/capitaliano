import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const SESSIONS_DIR = 'sessions';
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');

let activeSession = null;
let flushTimer = null;
let indexCache = null;

// --- Index helpers ---

async function loadIndex() {
  indexCache = JSON.parse(await readFile(INDEX_FILE, 'utf-8'));
  return indexCache;
}

async function saveIndex() {
  const tmpPath = INDEX_FILE + '.tmp';
  await writeFile(tmpPath, JSON.stringify(indexCache, null, 2));
  await rename(tmpPath, INDEX_FILE);
}

// Ensure sessions directory and index exist
async function init() {
  if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) await writeFile(INDEX_FILE, '[]');

  await loadIndex();

  // Resume any unfinished session
  const unfinished = indexCache.find(s => !s.endedAt);
  if (unfinished) {
    const data = JSON.parse(await readFile(join(SESSIONS_DIR, `${unfinished.id}.json`), 'utf-8'));
    activeSession = { data, dirty: false };
    startFlushTimer();
    console.log(`[capito] Resumed session: ${unfinished.name}`);
  }
}

// List all sessions (from cached index)
function list() {
  return indexCache || [];
}

// Create a new session
async function create(name, context) {
  if (activeSession) throw new Error('A session is already active');

  const id = `sess_${Date.now()}`;
  const data = {
    id,
    name: name || 'Untitled Session',
    startedAt: new Date().toISOString(),
    endedAt: null,
    context: context || null,
    lines: [],
  };

  activeSession = { data, dirty: true };
  indexCache.unshift({ id: data.id, name: data.name, startedAt: data.startedAt, endedAt: null, lineCount: 0 });
  await Promise.all([flush(), saveIndex()]);

  startFlushTimer();
  console.log(`[capito] Session created: ${name}`);
  return data;
}

// Get a session by ID
async function get(id) {
  if (activeSession && activeSession.data.id === id) return activeSession.data;
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

// End the active session
async function end() {
  if (!activeSession) throw new Error('No active session');

  activeSession.data.endedAt = new Date().toISOString();
  activeSession.dirty = true;

  const entry = indexCache.find(s => s.id === activeSession.data.id);
  if (entry) {
    entry.endedAt = activeSession.data.endedAt;
    entry.lineCount = activeSession.data.lines.length;
  }

  await Promise.all([flush(), saveIndex()]);
  stopFlushTimer();

  const result = { id: activeSession.data.id, endedAt: activeSession.data.endedAt, lineCount: activeSession.data.lines.length };
  activeSession = null;
  console.log(`[capito] Session ended`);
  return result;
}

// Update a session's name and/or context
async function update(id, fields) {
  if (activeSession && activeSession.data.id === id) {
    if (fields.name !== undefined) {
      activeSession.data.name = fields.name;
      const entry = indexCache.find(s => s.id === id);
      if (entry) entry.name = fields.name;
    }
    if (fields.context !== undefined) {
      activeSession.data.context = fields.context;
    }
    activeSession.dirty = true;
    await Promise.all([flush(), saveIndex()]);
    return activeSession.data;
  }

  // Update an ended session on disk
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  const data = JSON.parse(await readFile(filePath, 'utf-8'));
  if (fields.name !== undefined) {
    data.name = fields.name;
    const entry = indexCache.find(s => s.id === id);
    if (entry) entry.name = fields.name;
  }
  if (fields.context !== undefined) {
    data.context = fields.context;
  }
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
  await saveIndex();
  return data;
}

// Delete a session by ID
async function remove(id) {
  if (activeSession && activeSession.data.id === id) {
    throw new Error('Cannot delete the active session');
  }
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  try { await unlink(filePath); } catch {}
  const idx = indexCache.findIndex(s => s.id === id);
  if (idx !== -1) indexCache.splice(idx, 1);
  await saveIndex();
}

// Add a finalized line to the active session. Returns the lineId.
function addLine(text) {
  if (!activeSession) return null;
  const lineId = activeSession.data.lines.length;
  activeSession.data.lines.push({
    lineId,
    text,
    timestamp: new Date().toISOString(),
    final: true,
    translation: null,
    segments: [],
    entities: [],
    idioms: [],
    costUsd: 0,
  });
  activeSession.dirty = true;
  return lineId;
}

// Update a line with translation/entity/idiom data
function updateLine(lineId, updates) {
  if (!activeSession) return false;
  const line = activeSession.data.lines[lineId];
  if (!line) return false;
  if (updates.translation !== undefined) line.translation = updates.translation;
  if (updates.segments !== undefined) line.segments = updates.segments;
  if (updates.entities !== undefined) line.entities = updates.entities;
  if (updates.idioms !== undefined) line.idioms = updates.idioms;
  if (updates.costUsd !== undefined) line.costUsd = updates.costUsd;
  activeSession.dirty = true;
  return true;
}

// Get the active session (or null)
function getActive() {
  return activeSession ? activeSession.data : null;
}

// Flush active session to disk (atomic write)
async function flush() {
  if (!activeSession || !activeSession.dirty) return;
  const filePath = join(SESSIONS_DIR, `${activeSession.data.id}.json`);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(activeSession.data));
  await rename(tmpPath, filePath);
  activeSession.dirty = false;
}

function startFlushTimer() {
  stopFlushTimer();
  flushTimer = setInterval(() => flush().catch(err => console.error('[capito] Flush error:', err)), 5000);
}

function stopFlushTimer() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

// Graceful shutdown
async function shutdown() {
  stopFlushTimer();
  await flush();
}

export { init, list, create, get, update, end, remove, addLine, updateLine, getActive, flush, shutdown };
