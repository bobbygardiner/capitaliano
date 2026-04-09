import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'http://localhost:3000';
const SAVED_PATH = resolve('sessions', 'saved-vocab.json');

async function snapshotSaved() {
  if (!existsSync(SAVED_PATH)) return { entries: [] };
  return JSON.parse(await readFile(SAVED_PATH, 'utf-8'));
}

let originalContents;

// Note: GET/POST reflect in-memory state immediately — the 5s flush timer
// only affects on-disk persistence, not test visibility.

function source(overrides = {}) {
  return {
    sessionId: 'sess_test',
    sessionName: 'Test',
    lineId: 0,
    contextQuote: 'ctx',
    audioOffsetSec: 1,
    ...overrides,
  };
}

before(async () => {
  originalContents = existsSync(SAVED_PATH) ? await readFile(SAVED_PATH, 'utf-8') : null;
  // Reset saved-vocab file to a known empty state
  await writeFile(SAVED_PATH, JSON.stringify({ entries: [] }, null, 2));
  // Ask the server to reload by hitting GET (no-op reload; server already loaded on boot).
  // The integration test relies on fresh server state — skip if entries already present.
});

after(async () => {
  // Clean up any entries we added so UI isn't polluted
  const snap = await snapshotSaved();
  for (const e of snap.entries) {
    if (e.expression?.startsWith('TEST_')) {
      await fetch(`${BASE}/api/saved-vocab/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: e.expression }),
      });
    }
  }
  if (originalContents !== null) {
    await writeFile(SAVED_PATH, originalContents);
  }
});

describe('GET /api/saved-vocab', () => {
  it('returns an object with an entries array', async () => {
    const res = await fetch(`${BASE}/api/saved-vocab`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.entries));
  });
});

describe('POST /api/saved-vocab', () => {
  it('creates a new entry', async () => {
    const res = await fetch(`${BASE}/api/saved-vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: 'TEST_chiudere',
        meaning: 'test meaning',
        bucket: 'advanced',
        source: source({ sessionId: 'sess_test_a', lineId: 0 }),
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.created, true);
    assert.equal(data.entry.expression, 'TEST_chiudere');
    assert.equal(data.entry.bucket, 'advanced');
    assert.equal(data.entry.sources.length, 1);
  });

  it('appends source on duplicate expression', async () => {
    // First create
    await fetch(`${BASE}/api/saved-vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: 'TEST_merge',
        meaning: 'm',
        bucket: 'advanced',
        source: source({ sessionId: 'sess_test_b', lineId: 0 }),
      }),
    });
    // Then add again from different session
    const res = await fetch(`${BASE}/api/saved-vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: 'TEST_merge',
        meaning: 'm',
        bucket: 'advanced',
        source: source({ sessionId: 'sess_test_c', lineId: 5 }),
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, false);
    assert.equal(data.entry.sources.length, 2);
  });

  it('400s when body is missing expression', async () => {
    const res = await fetch(`${BASE}/api/saved-vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meaning: 'm', bucket: 'common', source: source() }),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/saved-vocab/remove', () => {
  it('removes an existing entry', async () => {
    await fetch(`${BASE}/api/saved-vocab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: 'TEST_remove_me',
        meaning: 'm',
        bucket: 'common',
        source: source({ sessionId: 'sess_test_d' }),
      }),
    });
    const res = await fetch(`${BASE}/api/saved-vocab/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: 'TEST_remove_me' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.removed, true);

    const getRes = await fetch(`${BASE}/api/saved-vocab`);
    const { entries } = await getRes.json();
    assert.equal(entries.find(e => e.expression === 'TEST_remove_me'), undefined);
  });
});
