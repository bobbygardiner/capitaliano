import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const SESSIONS_DIR = 'sessions';
const INDEX_FILE = join(SESSIONS_DIR, 'index.json');

let activeSession = null;
let dirty = false;
let flushTimer = null;

// Ensure sessions directory and index exist
async function init() {
  if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) await writeFile(INDEX_FILE, '[]');

  // Resume any unfinished session
  const index = JSON.parse(await readFile(INDEX_FILE, 'utf-8'));
  const unfinished = index.find(s => !s.endedAt);
  if (unfinished) {
    const data = JSON.parse(await readFile(join(SESSIONS_DIR, `${unfinished.id}.json`), 'utf-8'));
    activeSession = { data, dirty: false };
    startFlushTimer();
    console.log(`[capito] Resumed session: ${unfinished.name}`);
  }
}

// List all sessions (from index)
async function list() {
  return JSON.parse(await readFile(INDEX_FILE, 'utf-8'));
}

// Create a new session
async function create(name) {
  if (activeSession) throw new Error('A session is already active');

  const id = `sess_${Date.now()}`;
  const data = {
    id,
    name: name || 'Untitled Session',
    startedAt: new Date().toISOString(),
    endedAt: null,
    lines: [],
  };

  activeSession = { data, dirty: true };
  await flush();

  // Update index
  const index = await list();
  index.unshift({ id: data.id, name: data.name, startedAt: data.startedAt, endedAt: null, lineCount: 0 });
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));

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
  await flush();
  stopFlushTimer();

  // Update index
  const index = await list();
  const entry = index.find(s => s.id === activeSession.data.id);
  if (entry) {
    entry.endedAt = activeSession.data.endedAt;
    entry.lineCount = activeSession.data.lines.length;
    await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
  }

  const result = { id: activeSession.data.id, endedAt: activeSession.data.endedAt, lineCount: activeSession.data.lines.length };
  activeSession = null;
  dirty = false;
  console.log(`[capito] Session ended`);
  return result;
}

// Add a finalized line to the active session. Returns the lineId.
function addLine(text, timestamp) {
  if (!activeSession) return null;
  const lineId = activeSession.data.lines.length;
  activeSession.data.lines.push({
    lineId,
    text,
    timestamp: timestamp || new Date().toISOString(),
    final: true,
    translation: null,
    entities: [],
    idioms: [],
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
  if (updates.entities !== undefined) line.entities = updates.entities;
  if (updates.idioms !== undefined) line.idioms = updates.idioms;
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
  await writeFile(tmpPath, JSON.stringify(activeSession.data, null, 2));
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

export { init, list, create, get, end, addLine, updateLine, getActive, flush, shutdown };
