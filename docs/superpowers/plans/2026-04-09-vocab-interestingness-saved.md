# Vocab Interestingness + Saved Vocab — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank idioms by difficulty and let the user save interesting ones to a persistent, cross-session collection accessible from the sidebar.

**Architecture:** Extend the existing Anthropic translation prompt so each idiom carries a `bucket` (`common | intermediate | advanced`). Add a new `lib/saved-vocab.js` module that mirrors `lib/sessions.js` (in-memory state + debounced flush). Expose `/api/saved-vocab` endpoints. Update the current-session Vocab tab to group+sort by bucket and add a star toggle. Add a new top-level "Saved Vocab" view rendered in place of the session panels when selected from the sidebar. Finish with a one-shot backfill script.

**Tech Stack:** Node.js (ESM), `node:test` runner, `@anthropic-ai/sdk`, vanilla HTML/CSS/JS frontend (no build step).

**Spec:** `docs/superpowers/specs/2026-04-09-vocab-interestingness-saved-design.md`

**Running tests:** `node --test test/<file>.test.js` for a single file; `node --test` for all. Integration tests against `/api/*` endpoints require the server running on `localhost:3000` — start it with `npm start` in a second terminal.

**Commit style (from `git log`):** short imperative subject, lowercase type prefix, no trailing period. Example: `feat: add idiom difficulty bucket`. Every task ends with a commit.

---

## Chunk 1: Difficulty buckets in the translation pipeline

### Task 1: Extend `normalizeAnalysis` to validate idiom buckets

**Files:**
- Modify: `lib/translate.js` (the `normalizeAnalysis` function near line 22)
- Test: `test/translate.test.js`

**Context:** `normalizeAnalysis` is called by `analyzeCommentary`, `splitAndAnalyze`, and `mergeAndAnalyze`. It currently copies `idioms` through as-is. We need it to coerce each idiom's `bucket` to a valid value (`common`, `intermediate`, `advanced`) or fall back to `intermediate`. Must never throw.

- [ ] **Step 1: Write the failing tests**

Append to `test/translate.test.js`:

```js
import { normalizeAnalysis } from '../lib/translate.js';

describe('normalizeAnalysis — idiom buckets', () => {
  it('preserves a valid bucket on each idiom', () => {
    const result = normalizeAnalysis({
      idioms: [
        { expression: 'a', meaning: 'A', bucket: 'advanced' },
        { expression: 'b', meaning: 'B', bucket: 'intermediate' },
        { expression: 'c', meaning: 'C', bucket: 'common' },
      ],
    }, 0);
    assert.deepEqual(result.idioms.map(i => i.bucket), ['advanced', 'intermediate', 'common']);
  });

  it('falls back to intermediate when bucket is missing', () => {
    const result = normalizeAnalysis({
      idioms: [{ expression: 'a', meaning: 'A' }],
    }, 0);
    assert.equal(result.idioms[0].bucket, 'intermediate');
  });

  it('falls back to intermediate when bucket is unrecognized', () => {
    const result = normalizeAnalysis({
      idioms: [{ expression: 'a', meaning: 'A', bucket: 'hard' }],
    }, 0);
    assert.equal(result.idioms[0].bucket, 'intermediate');
  });

  it('falls back to intermediate when bucket is null', () => {
    const result = normalizeAnalysis({
      idioms: [{ expression: 'a', meaning: 'A', bucket: null }],
    }, 0);
    assert.equal(result.idioms[0].bucket, 'intermediate');
  });

  it('does not throw on non-array idioms', () => {
    assert.doesNotThrow(() => normalizeAnalysis({ idioms: null }, 0));
  });

  it('preserves other idiom fields', () => {
    const result = normalizeAnalysis({
      idioms: [{ expression: 'chiudere la saracinesca', meaning: 'to shut up shop', bucket: 'advanced' }],
    }, 0);
    assert.equal(result.idioms[0].expression, 'chiudere la saracinesca');
    assert.equal(result.idioms[0].meaning, 'to shut up shop');
  });
});
```

This requires exporting `normalizeAnalysis` — currently it's internal. Export it on the same line as the other exports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/translate.test.js`
Expected: FAIL — `normalizeAnalysis is not exported` or bucket assertions fail.

- [ ] **Step 3: Implement bucket validation and export**

In `lib/translate.js`, replace the current `normalizeAnalysis` with:

```js
const VALID_BUCKETS = new Set(['common', 'intermediate', 'advanced']);

function normalizeIdiom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bucket = VALID_BUCKETS.has(raw.bucket) ? raw.bucket : 'intermediate';
  return {
    expression: raw.expression,
    meaning: raw.meaning,
    bucket,
  };
}

function normalizeAnalysis(result, costUsd) {
  const rawIdioms = Array.isArray(result.idioms) ? result.idioms : [];
  return {
    translation: result.translation || null,
    segments: Array.isArray(result.segments) ? result.segments : [],
    entities: Array.isArray(result.entities) ? result.entities : [],
    idioms: rawIdioms.map(normalizeIdiom).filter(Boolean),
    costUsd,
  };
}
```

Add `normalizeAnalysis` to the `export` statement at the bottom of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/translate.test.js`
Expected: PASS — all new tests green, existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/translate.js test/translate.test.js
git commit -m "feat: validate idiom difficulty buckets in normalizeAnalysis"
```

---

### Task 2: Update translation system prompts to request buckets

**Files:**
- Modify: `lib/translate.js` — `SYSTEM_PROMPT`, `SPLIT_SYSTEM_PROMPT`, `MERGE_SYSTEM_PROMPT`

**Context:** All three prompts describe idiom extraction. Each needs a sentence telling Claude to include a `bucket` field. Keep the instruction identical across all three prompts.

- [ ] **Step 1: Update `SYSTEM_PROMPT` (the `## 4. "idioms"` section around line 66)**

Replace the `## 4. "idioms"` section with:

```js
## 4. "idioms"
Array of Italian idioms/expressions [{expression, meaning, bucket}] where meaning explains the football context. For idioms: only tag genuine Italian football expressions or culturally significant phrases. Do NOT tag: common Italian verbs with player names (e.g. "fa Calhanoglu"), basic Italian phrases that aren't football-specific (e.g. "per non rischiare nulla"), or garbled/nonsensical transcription fragments.

For each idiom, set "bucket" to one of "common", "intermediate", or "advanced" reflecting how likely an intermediate Italian learner is to already know the phrase. Use "common" for basic football vocabulary (e.g. "di testa"), "intermediate" for phrases a motivated learner would recognize, and "advanced" for genuinely idiomatic or regional expressions.
```

- [ ] **Step 2: Update `SPLIT_SYSTEM_PROMPT` (around line 119)**

In the line that lists output fields, change:

```
- "idioms": [{expression, meaning}]
```

to:

```
- "idioms": [{expression, meaning, bucket}] — bucket is one of "common" | "intermediate" | "advanced" reflecting whether an intermediate Italian learner would already know the phrase
```

- [ ] **Step 3: Update `MERGE_SYSTEM_PROMPT` (around line 181)**

Change:

```
5. "idioms" — [{expression, meaning}] for genuine Italian football expressions
```

to:

```
5. "idioms" — [{expression, meaning, bucket}] for genuine Italian football expressions; bucket is "common" | "intermediate" | "advanced" reflecting whether an intermediate Italian learner would already know the phrase
```

- [ ] **Step 4: Verify no tests broke**

Run: `node --test test/translate.test.js`
Expected: PASS — `normalizeAnalysis` tests from Task 1 still pass; prompt changes don't affect unit tests (they don't hit the API).

- [ ] **Step 5: Commit**

```bash
git add lib/translate.js
git commit -m "feat: ask Claude to bucket idiom difficulty"
```

---

## Chunk 2: `lib/saved-vocab.js` module

### Task 3: Create the saved-vocab storage module with tests

**Files:**
- Create: `lib/saved-vocab.js`
- Create: `test/saved-vocab.test.js`

**Context:** This module mirrors `lib/sessions.js`. It owns the `sessions/saved-vocab.json` file, which is a single object: `{ entries: [] }`. Dedupe key is `expression.trim().toLowerCase()`. We'll write it with a debounced flush timer so rapid saves don't thrash the disk. Tests run against a temporary directory to avoid polluting real data — the module takes a path at init time.

Because tests need to override the file path, the module must accept the path as an `init` argument. Production code in `server.js` will pass `sessions/saved-vocab.json`.

- [ ] **Step 1: Write the failing test file**

Create `test/saved-vocab.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as savedVocab from '../lib/saved-vocab.js';

let tmp;
let filePath;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'saved-vocab-'));
  filePath = join(tmp, 'saved-vocab.json');
});

afterEach(async () => {
  await savedVocab.shutdown();
  await rm(tmp, { recursive: true, force: true });
});

function fixtureSource(overrides = {}) {
  return {
    sessionId: 'sess_1',
    sessionName: 'Test Session',
    lineId: 0,
    contextQuote: '...quote...',
    audioOffsetSec: 12.3,
    ...overrides,
  };
}

describe('saved-vocab init', () => {
  it('creates an empty file if missing', async () => {
    await savedVocab.init(filePath);
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.deepEqual(raw, { entries: [] });
  });

  it('loads existing entries from file', async () => {
    await writeFile(filePath, JSON.stringify({
      entries: [{ id: 'sv_1', expression: 'foo', meaning: 'bar', bucket: 'advanced', savedAt: '2026-04-09T00:00:00.000Z', sources: [] }],
    }));
    await savedVocab.init(filePath);
    const list = savedVocab.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].expression, 'foo');
  });

  it('renames malformed file to .bak and starts empty', async () => {
    await writeFile(filePath, 'not valid json{{');
    await savedVocab.init(filePath);
    assert.deepEqual(savedVocab.list(), []);
    const bakRaw = await readFile(filePath + '.bak', 'utf-8');
    assert.equal(bakRaw, 'not valid json{{');
  });
});

describe('saved-vocab add', () => {
  beforeEach(async () => { await savedVocab.init(filePath); });

  it('creates a new entry when expression is new', async () => {
    const { entry, created } = await savedVocab.add({
      expression: 'chiudere la saracinesca',
      meaning: 'to shut up shop defensively',
      bucket: 'advanced',
      source: fixtureSource(),
    });
    assert.equal(created, true);
    assert.equal(entry.expression, 'chiudere la saracinesca');
    assert.equal(entry.bucket, 'advanced');
    assert.equal(entry.sources.length, 1);
    assert.match(entry.id, /^sv_\d+$/);
    assert.ok(entry.savedAt);
  });

  it('appends a new source when the expression already exists', async () => {
    await savedVocab.add({
      expression: 'chiudere la saracinesca',
      meaning: 'to shut up shop',
      bucket: 'advanced',
      source: fixtureSource({ sessionId: 'sess_1', lineId: 0 }),
    });
    const { entry, created } = await savedVocab.add({
      expression: 'chiudere la saracinesca',
      meaning: 'to shut up shop',
      bucket: 'advanced',
      source: fixtureSource({ sessionId: 'sess_2', lineId: 5 }),
    });
    assert.equal(created, false);
    assert.equal(entry.sources.length, 2);
    assert.equal(savedVocab.list().length, 1);
  });

  it('normalizes expression for dedupe (case/whitespace)', async () => {
    await savedVocab.add({
      expression: 'Chiudere la Saracinesca',
      meaning: 'm1',
      bucket: 'advanced',
      source: fixtureSource({ sessionId: 'sess_1' }),
    });
    const { created } = await savedVocab.add({
      expression: '  chiudere la saracinesca  ',
      meaning: 'm2',
      bucket: 'advanced',
      source: fixtureSource({ sessionId: 'sess_2' }),
    });
    assert.equal(created, false);
    assert.equal(savedVocab.list().length, 1);
  });

  it('does not add a duplicate source (same sessionId+lineId)', async () => {
    await savedVocab.add({
      expression: 'foo',
      meaning: 'bar',
      bucket: 'common',
      source: fixtureSource({ sessionId: 'sess_1', lineId: 3 }),
    });
    const { entry } = await savedVocab.add({
      expression: 'foo',
      meaning: 'bar',
      bucket: 'common',
      source: fixtureSource({ sessionId: 'sess_1', lineId: 3 }),
    });
    assert.equal(entry.sources.length, 1);
  });
});

describe('saved-vocab has / remove', () => {
  beforeEach(async () => {
    await savedVocab.init(filePath);
    await savedVocab.add({
      expression: 'foo',
      meaning: 'bar',
      bucket: 'advanced',
      source: fixtureSource(),
    });
  });

  it('has() returns true for saved expression, false otherwise', () => {
    assert.equal(savedVocab.has('foo'), true);
    assert.equal(savedVocab.has('FOO'), true);
    assert.equal(savedVocab.has('bar'), false);
  });

  it('remove() deletes by expression and clears has()', async () => {
    const removed = await savedVocab.remove('Foo');
    assert.equal(removed, true);
    assert.equal(savedVocab.has('foo'), false);
    assert.equal(savedVocab.list().length, 0);
  });

  it('remove() returns false when expression not present', async () => {
    const removed = await savedVocab.remove('nonexistent');
    assert.equal(removed, false);
  });
});

describe('saved-vocab list ordering', () => {
  beforeEach(async () => { await savedVocab.init(filePath); });

  it('returns entries sorted by savedAt descending', async () => {
    await savedVocab.add({ expression: 'first', meaning: 'm', bucket: 'common', source: fixtureSource() });
    await new Promise(r => setTimeout(r, 5));
    await savedVocab.add({ expression: 'second', meaning: 'm', bucket: 'common', source: fixtureSource() });
    const list = savedVocab.list();
    assert.equal(list[0].expression, 'second');
    assert.equal(list[1].expression, 'first');
  });
});

describe('saved-vocab persistence', () => {
  it('writes to disk after flush', async () => {
    await savedVocab.init(filePath);
    await savedVocab.add({ expression: 'foo', meaning: 'bar', bucket: 'advanced', source: fixtureSource() });
    await savedVocab.flush();
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].expression, 'foo');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist)**

Run: `node --test test/saved-vocab.test.js`
Expected: FAIL with "Cannot find module '../lib/saved-vocab.js'".

- [ ] **Step 3: Implement `lib/saved-vocab.js`**

Create `lib/saved-vocab.js`:

```js
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
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `node --test test/saved-vocab.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/saved-vocab.js test/saved-vocab.test.js
git commit -m "feat: add saved-vocab storage module"
```

---

## Chunk 3: REST endpoints

### Task 4: Wire saved-vocab module into server startup

**Files:**
- Modify: `server.js`

**Context:** `server.js` calls `sessions.init()` near the end of startup and `sessions.shutdown()` on SIGINT/SIGTERM. We need the same for saved-vocab, using `sessions/saved-vocab.json`.

- [ ] **Step 1: Add the import at the top of `server.js`**

Near the other lib imports (around line 12), add:

```js
import * as savedVocab from './lib/saved-vocab.js';
```

- [ ] **Step 2: Initialize on server start**

Find the block near line 476 that reads `await sessions.init();` and add below it:

```js
await savedVocab.init(resolve('sessions', 'saved-vocab.json'));
```

- [ ] **Step 3: Shutdown on graceful exit**

Find `gracefulShutdown` (around line 483) and update:

```js
async function gracefulShutdown() {
  await sessions.shutdown();
  await savedVocab.shutdown();
  process.exit(0);
}
```

- [ ] **Step 4: Smoke-test boot**

Run: `npm start`
Expected: Server boots without errors. After a second, kill with Ctrl-C — should print the shutdown message without errors. Check `ls sessions/saved-vocab.json` — file should exist with `{"entries": []}`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: initialize saved-vocab store on server startup"
```

---

### Task 5: Add REST endpoints for saved vocab

**Files:**
- Modify: `server.js`
- Create: `test/saved-vocab-api.test.js`

**Context:** Three endpoints. The `POST /api/saved-vocab/remove` path must be matched **before** `POST /api/saved-vocab` so the more specific route wins. They also must be registered before the session ID regex routes.

- [ ] **Step 1: Write the failing integration test**

Create `test/saved-vocab-api.test.js`:

```js
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
```

> Note: integration tests rely on the server having started *after* the test file placed `saved-vocab.json` in a known state. Because saved-vocab loads once at startup, you must:
> 1. Stop any running server.
> 2. Ensure `sessions/saved-vocab.json` exists and is a valid JSON file.
> 3. Start the server fresh (`npm start` in a separate terminal).
> 4. Run the tests.
>
> All test expressions are prefixed with `TEST_` so the `after` cleanup is trivial.

- [ ] **Step 2: Run tests to verify they fail (endpoints not implemented)**

Start server: `npm start` (separate terminal)
Run: `node --test test/saved-vocab-api.test.js`
Expected: FAIL — `GET /api/saved-vocab` returns 404.

- [ ] **Step 3: Add the routes in `server.js`**

In the `/api/` routing block (starting around line 69), add these routes **before** the `audioMatch` check (which uses the RE_SESSION_AUDIO regex):

```js
if (urlPath === '/api/saved-vocab' && req.method === 'GET') {
  return sendJson(res, 200, { entries: savedVocab.list() });
}

if (urlPath === '/api/saved-vocab/remove' && req.method === 'POST') {
  const body = await readBody(req);
  if (!body.expression) return sendJson(res, 400, { error: 'expression is required' });
  const removed = await savedVocab.remove(body.expression);
  return sendJson(res, 200, { removed });
}

if (urlPath === '/api/saved-vocab' && req.method === 'POST') {
  const body = await readBody(req);
  if (!body.expression) return sendJson(res, 400, { error: 'expression is required' });
  if (!body.source || !body.source.sessionId) return sendJson(res, 400, { error: 'source with sessionId is required' });
  const { entry, created } = await savedVocab.add({
    expression: body.expression,
    meaning: body.meaning || '',
    bucket: body.bucket || 'intermediate',
    source: body.source,
  });
  return sendJson(res, created ? 201 : 200, { entry, created });
}
```

The order matters: the `/remove` POST must come before the generic `/api/saved-vocab` POST, otherwise pattern matching catches the wrong route.

- [ ] **Step 4: Restart the server and re-run tests**

Stop the server (Ctrl-C), start again: `npm start`
Run: `node --test test/saved-vocab-api.test.js`
Expected: PASS — all tests green. Check `sessions/saved-vocab.json` — should contain no `TEST_` entries after cleanup.

- [ ] **Step 5: Commit**

```bash
git add server.js test/saved-vocab-api.test.js
git commit -m "feat: add REST endpoints for saved vocab"
```

---

## Chunk 4: Current-session Vocab tab — buckets + star toggle

### Task 6: Add CSS for bucket dots, level labels, and star buttons

**Files:**
- Modify: `public/index.html` (inline `<style>` block)

**Context:** The existing vocab item style lives in the CSS block inside `index.html`. Add new classes next to it. Bucket colors should feel consistent with the existing entity palette (`--entity-player` etc.) but distinct enough to read as difficulty.

- [ ] **Step 1: Add bucket, level-label, and star styles**

Locate the existing `.vocab-item` rule inside `public/index.html` and add these rules nearby:

```css
.vocab-item {
  /* existing rules stay */
  position: relative;
}

.bucket-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: middle;
  flex-shrink: 0;
}
.bucket-dot.bucket-advanced { background: #B07D4B; }
.bucket-dot.bucket-intermediate { background: #C9A860; }
.bucket-dot.bucket-common { background: #b9b4a8; }
.bucket-dot.bucket-unbucketed { background: transparent; border: 1px dashed var(--border); }

.level-group-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
  padding: 14px 4px 6px 4px;
}
.level-group-label:first-child { padding-top: 4px; }

.vocab-star-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  margin-left: 8px;
  line-height: 1;
}
.vocab-star-btn:hover { color: var(--text); }
.vocab-star-btn.saved { color: var(--accent); }

.vocab-expression-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
```

- [ ] **Step 2: Visually check the empty state**

Reload the app in the browser. Existing vocab items should still render (they don't use the new classes yet).

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add CSS for vocab difficulty buckets and save toggle"
```

---

### Task 7: Update `renderVocab()` to group by bucket and add star toggle

**Files:**
- Modify: `public/app.js`

**Context:** `renderVocab()` currently renders a flat chronological list. We need to:
1. Bucket idioms into `advanced`, `intermediate`, `common`, `unbucketed`.
2. Render a group label before each non-empty group.
3. Add a bucket dot next to each expression.
4. Add a star button that calls the saved-vocab API.

We also need a client-side cache of saved expressions (a `Set<string>`) so the star reflects initial state correctly on load. Load it via `GET /api/saved-vocab` at app init.

- [ ] **Step 1: Add the saved-vocab client cache**

Near the top of `app.js` (around where `currentSession` is declared), add:

```js
// Saved vocab cache: lowercased expression -> true
const savedVocabSet = new Set();
let savedVocabCache = []; // full entries list, used by Saved Vocab view

function normalizeExpression(expression) {
  return String(expression || '').trim().toLowerCase();
}

async function loadSavedVocab() {
  try {
    const res = await fetch('/api/saved-vocab');
    const data = await res.json();
    savedVocabCache = data.entries || [];
    savedVocabSet.clear();
    for (const e of savedVocabCache) savedVocabSet.add(normalizeExpression(e.expression));
  } catch (err) {
    console.error('[capitaliano] Failed to load saved vocab:', err);
  }
}
```

- [ ] **Step 2: Call `loadSavedVocab` at app startup**

Find where `loadSessionsList()` is first called at app init (around line 86). Add:

```js
loadSavedVocab();
```

right next to it.

- [ ] **Step 3: Rewrite `collectVocab()` and `renderVocab()`**

Replace the existing `collectVocab` and `renderVocab` functions (around lines 907-951) with:

```js
const BUCKET_ORDER = ['advanced', 'intermediate', 'common', 'unbucketed'];
const BUCKET_LABEL = {
  advanced: 'Advanced',
  intermediate: 'Intermediate',
  common: 'Common',
  unbucketed: 'Unscored',
};

function collectVocab() {
  if (!currentSession) return [];
  const vocab = [];
  // Iterating lines in array order preserves chronological ordering within
  // each bucket after groupVocabByBucket() runs.
  for (const line of currentSession.lines) {
    if (!line.idioms || !line.idioms.length) continue;
    for (const idiom of line.idioms) {
      vocab.push({
        expression: idiom.expression,
        meaning: idiom.meaning,
        bucket: idiom.bucket || 'unbucketed',
        context: line.text,
        timestamp: line.timestamp,
        lineId: line.lineId,
        audioOffsetSec: line.audioOffsetSec ?? null,
        hasAudio: line.audioOffsetSec != null,
      });
    }
  }
  return vocab;
}

function groupVocabByBucket(vocab) {
  const groups = { advanced: [], intermediate: [], common: [], unbucketed: [] };
  for (const item of vocab) {
    (groups[item.bucket] || groups.unbucketed).push(item);
  }
  return groups;
}

function buildContextQuote(text) {
  const snippet = text.slice(0, 120);
  const ellipsis = text.length > 120 ? '…' : '';
  return `…${snippet}${ellipsis}`;
}

function renderVocab() {
  const vocab = collectVocab();
  if (!vocab.length) {
    vocabList.innerHTML = '<div class="vocab-empty">No vocabulary collected yet</div>';
    return;
  }

  const groups = groupVocabByBucket(vocab);
  vocabList.innerHTML = '';

  for (const bucket of BUCKET_ORDER) {
    const items = groups[bucket];
    if (!items.length) continue;

    const label = document.createElement('div');
    label.className = 'level-group-label';
    label.textContent = BUCKET_LABEL[bucket];
    vocabList.appendChild(label);

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'vocab-item';
      const isSaved = savedVocabSet.has(normalizeExpression(item.expression));
      el.innerHTML = `
        <div class="vocab-expression-row">
          <div class="vocab-expression">
            <span class="bucket-dot bucket-${bucket}"></span>
            ${item.hasAudio ? '<span class="vocab-play-btn" title="Play audio">\u25B6</span> ' : ''}
            ${escapeHtml(item.expression)}
          </div>
          <button class="vocab-star-btn ${isSaved ? 'saved' : ''}" title="${isSaved ? 'Remove from saved' : 'Save vocab'}">${isSaved ? '★' : '☆'}</button>
        </div>
        <div class="vocab-meaning">${escapeHtml(item.meaning)}</div>
        <div class="vocab-context">"${escapeHtml(buildContextQuote(item.context))}"</div>
        <div class="vocab-time">${formatElapsed(item.timestamp)}</div>
      `;
      if (item.hasAudio) {
        el.querySelector('.vocab-play-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          playLineAudio(item.lineId);
        });
      }
      el.querySelector('.vocab-star-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSavedVocab(item, el.querySelector('.vocab-star-btn'));
      });
      vocabList.appendChild(el);
    }
  }
}
```

- [ ] **Step 4: Implement `toggleSavedVocab`**

Add this function near the other vocab helpers:

```js
async function toggleSavedVocab(item, btn) {
  const key = normalizeExpression(item.expression);
  const wasSaved = savedVocabSet.has(key);

  // Optimistic update
  if (wasSaved) {
    savedVocabSet.delete(key);
  } else {
    savedVocabSet.add(key);
  }
  btn.classList.toggle('saved', !wasSaved);
  btn.textContent = wasSaved ? '☆' : '★';
  btn.title = wasSaved ? 'Save vocab' : 'Remove from saved';

  try {
    if (wasSaved) {
      const res = await fetch('/api/saved-vocab/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: item.expression }),
      });
      if (!res.ok) throw new Error('Remove failed');
      savedVocabCache = savedVocabCache.filter(e => normalizeExpression(e.expression) !== key);
    } else {
      const source = {
        sessionId: currentSession.id,
        sessionName: currentSession.name,
        lineId: item.lineId,
        contextQuote: buildContextQuote(item.context),
        audioOffsetSec: item.audioOffsetSec,
      };
      const res = await fetch('/api/saved-vocab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expression: item.expression,
          meaning: item.meaning,
          bucket: item.bucket === 'unbucketed' ? 'intermediate' : item.bucket,
          source,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      // Replace-or-insert in cache
      const existingIdx = savedVocabCache.findIndex(e => normalizeExpression(e.expression) === key);
      if (existingIdx >= 0) savedVocabCache[existingIdx] = data.entry;
      else savedVocabCache.unshift(data.entry);
    }
  } catch (err) {
    console.error('[capitaliano] toggleSavedVocab failed:', err);
    // Revert
    if (wasSaved) savedVocabSet.add(key);
    else savedVocabSet.delete(key);
    btn.classList.toggle('saved', wasSaved);
    btn.textContent = wasSaved ? '★' : '☆';
    btn.title = wasSaved ? 'Remove from saved' : 'Save vocab';
    alert('Failed to update saved vocab. Please try again.');
  }
}
```

- [ ] **Step 5: Manual browser smoke test**

Start the server if not running: `npm start`
Open the app, load a session with idioms. Verify:
- Vocab tab groups by bucket, Advanced first.
- Bucket dots appear in the correct color.
- Clicking ☆ saves and switches to ★.
- Clicking ★ removes and switches to ☆.
- Refreshing the page preserves the saved state.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: sort vocab tab by difficulty bucket with save toggle"
```

---

## Chunk 5: Saved Vocab top-level view

### Task 8: Add Saved Vocab panel HTML and CSS

**Files:**
- Modify: `public/index.html`

**Context:** The Saved Vocab view replaces the transcript/vocab panels when active. It needs its own container that's hidden by default and revealed via a class toggle.

- [ ] **Step 1: Add the HTML panel**

In `public/index.html`, immediately after the `<div id="vocab-panel">...</div>` block (around line 1107), add:

```html
<div id="saved-vocab-view" class="saved-vocab-view hidden">
  <header class="saved-vocab-header">
    <div>
      <h2 class="saved-vocab-title">Saved Vocab</h2>
      <div class="saved-vocab-count"></div>
    </div>
  </header>
  <div class="saved-vocab-controls">
    <input id="saved-vocab-search" class="saved-vocab-search" type="text" placeholder="Search phrases or meanings…" />
    <div class="saved-vocab-filters">
      <button data-bucket="all" class="filter-chip active">All</button>
      <button data-bucket="advanced" class="filter-chip">Advanced</button>
      <button data-bucket="intermediate" class="filter-chip">Intermediate</button>
      <button data-bucket="common" class="filter-chip">Common</button>
    </div>
  </div>
  <div id="saved-vocab-list" class="saved-vocab-list"></div>
</div>
```

- [ ] **Step 2: Add the CSS**

In the same `<style>` block, add:

```css
.saved-vocab-view {
  padding: 20px 24px 40px 24px;
  max-width: 760px;
  margin: 0 auto;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.saved-vocab-view.hidden { display: none; }

.saved-vocab-header {
  margin-bottom: 12px;
}
.saved-vocab-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: var(--text);
}
.saved-vocab-count {
  font-size: 12px;
  color: var(--text-muted);
}

.saved-vocab-controls {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.saved-vocab-search {
  flex: 1;
  min-width: 200px;
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
}
.saved-vocab-search:focus {
  outline: none;
  border-color: var(--border-strong);
}

.saved-vocab-filters {
  display: flex;
  gap: 6px;
}
.filter-chip {
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
}
.filter-chip:hover { background: var(--surface); }
.filter-chip.active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.saved-vocab-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.saved-vocab-empty {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}
.saved-vocab-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border);
}
.saved-vocab-row:last-child { border-bottom: none; }
.saved-vocab-expr {
  font-weight: 600;
  font-size: 15px;
  color: var(--text);
  margin-bottom: 4px;
}
.saved-vocab-expr .bucket-dot { margin-right: 8px; }
.saved-vocab-meaning {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
  margin-bottom: 5px;
}
.saved-vocab-ctx {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
  margin-bottom: 4px;
}
.saved-vocab-source {
  font-size: 11px;
  color: var(--text-secondary);
}
.saved-vocab-source strong { color: var(--text); font-weight: 600; }
.saved-vocab-row .vocab-star-btn { align-self: start; }
```

- [ ] **Step 3: Reload browser — view should be hidden**

Verify the app still works and the new saved-vocab view is not visible (it has `hidden` class).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add saved vocab view HTML and CSS"
```

---

### Task 9: Add Library section to sidebar with Saved Vocab nav item

**Files:**
- Modify: `public/index.html`

**Context:** The sidebar currently has a `.sessions-header` + `.sessions-list`. We insert a Library section above it.

- [ ] **Step 1: Add Library section markup**

Find the `<div id="sessions-panel">...</div>` block in `public/index.html`. Locate the `.sessions-header` div and insert a Library section **above** it (inside the sessions-panel but before the existing sessions header).

Look at the current structure (around lines 1042-1070) and insert between `.sessions-panel` opening and the existing header:

```html
<div class="sessions-library-section">
  <div class="sessions-header">Library</div>
  <div id="sidebar-saved-vocab" class="sidebar-nav-item">
    <div class="sidebar-nav-icon">★</div>
    <div class="sidebar-nav-label">Saved Vocab</div>
    <div class="sidebar-nav-count" id="sidebar-saved-vocab-count">0</div>
  </div>
</div>
```

- [ ] **Step 2: Add CSS for the sidebar nav item**

In the `<style>` block:

```css
.sessions-library-section {
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px;
  margin-bottom: 4px;
}
.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  border-left: 3px solid transparent;
}
.sidebar-nav-item:hover { background: var(--surface); }
.sidebar-nav-item.active {
  background: var(--surface);
  border-left-color: var(--accent);
}
.sidebar-nav-icon {
  color: var(--accent);
  font-size: 14px;
  width: 16px;
  text-align: center;
}
.sidebar-nav-label {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.sidebar-nav-count {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Reload browser — sidebar should show Library section**

Open the sidebar (hamburger menu). Verify the Library section with "Saved Vocab" appears above Sessions. Clicking does nothing yet (wire-up is Task 10).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add Library section with Saved Vocab nav item"
```

---

### Task 10: Wire view switching between session and saved-vocab

**Files:**
- Modify: `public/app.js`

**Context:** Introduce a `currentView` state (`"session"` or `"saved-vocab"`) and swap what's visible when the Saved Vocab nav item is clicked. Clicking a session in the sessions list resets to session view. Top-bar controls (mic, start/stop, translation toggle) hide in saved-vocab view.

- [ ] **Step 1: Declare state and element references**

Near the top of `app.js` (with other element references):

```js
let currentView = 'session'; // 'session' | 'saved-vocab'
const sidebarSavedVocabBtn = document.getElementById('sidebar-saved-vocab');
const sidebarSavedVocabCount = document.getElementById('sidebar-saved-vocab-count');
const savedVocabView = document.getElementById('saved-vocab-view');
const topBar = document.querySelector('.top-bar');
```

- [ ] **Step 2: Implement view switching**

Add these functions:

```js
function showSavedVocabView() {
  currentView = 'saved-vocab';
  sidebarSavedVocabBtn.classList.add('active');
  transcript.classList.remove('active');
  document.getElementById('vocab-panel').classList.remove('active');
  tabBar.classList.add('hidden');
  savedVocabView.classList.remove('hidden');
  topBar.classList.add('view-saved-vocab');
  closeSessions();
  renderSavedVocab();
}

function showSessionView() {
  currentView = 'session';
  sidebarSavedVocabBtn.classList.remove('active');
  tabBar.classList.remove('hidden');
  savedVocabView.classList.add('hidden');
  topBar.classList.remove('view-saved-vocab');

  // Restore whichever tab was active
  const activeTab = tabBar.querySelector('.tab-btn.active');
  const tabName = activeTab?.dataset.tab || 'transcript';
  document.getElementById(tabName === 'vocab' ? 'vocab-panel' : 'transcript').classList.add('active');
}

sidebarSavedVocabBtn.addEventListener('click', showSavedVocabView);
```

- [ ] **Step 3: Reset to session view when a session is loaded**

Find `loadSession` (around line 330). At the top of the function, add:

```js
if (currentView === 'saved-vocab') showSessionView();
```

- [ ] **Step 4: Update sidebar count whenever saved vocab changes**

Add a helper and call it in `loadSavedVocab` and `toggleSavedVocab`:

```js
function updateSavedVocabCount() {
  sidebarSavedVocabCount.textContent = savedVocabCache.length;
}
```

Call it at the end of `loadSavedVocab` and at the end of `toggleSavedVocab` (both success paths).

- [ ] **Step 5: Add CSS to hide top-bar recording controls in saved-vocab view**

In the `<style>` block:

```css
.top-bar.view-saved-vocab #mic-select,
.top-bar.view-saved-vocab #start-btn,
.top-bar.view-saved-vocab #stop-btn,
.top-bar.view-saved-vocab #translation-toggle,
.top-bar.view-saved-vocab #session-name,
.top-bar.view-saved-vocab #edit-session-btn,
.top-bar.view-saved-vocab #cost-indicator {
  display: none;
}
```

- [ ] **Step 6: Implement a stub `renderSavedVocab` so the click doesn't error**

Near the vocab functions, add a stub (Task 11 fills it in):

```js
function renderSavedVocab() {
  const listEl = document.getElementById('saved-vocab-list');
  listEl.innerHTML = '<div class="saved-vocab-empty">Saved vocab renders in the next step.</div>';
  document.querySelector('.saved-vocab-count').textContent = `${savedVocabCache.length} phrases`;
}
```

- [ ] **Step 7: Manual smoke test**

Reload the app. Open sidebar → click Saved Vocab. Verify:
- Sidebar closes.
- Transcript/Vocab panels hide.
- Saved Vocab view shows the stub text.
- Top bar recording controls hide.
- Clicking a session in the sidebar returns to the session view with the tab bar visible.

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat: wire top-level saved vocab view switching"
```

---

### Task 11: Implement `renderSavedVocab` with search and filters

**Files:**
- Modify: `public/app.js`

**Context:** The Saved Vocab view displays the `savedVocabCache` list filtered by search text and active bucket chip. Source line resolves session names from the sessions list already cached on disk — we read `sessionsList.children` or keep a sessions map.

We need a session id → name map. The existing `renderSessionsList` already iterates the sessions array; let's capture the full list in a module-level variable for easy lookup.

- [ ] **Step 1: Cache sessions map**

Find `loadSessionsList` and `renderSessionsList`. Change to populate a module-level map:

```js
let sessionsById = new Map();

async function loadSessionsList() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    sessionsById = new Map((data.sessions || []).map(s => [s.id, s]));
    renderSessionsList(data.sessions || []);
    if (currentView === 'saved-vocab') renderSavedVocab();
  } catch (err) {
    console.error('[capitaliano] Failed to load sessions:', err);
  }
}
```

- [ ] **Step 2: Implement the real `renderSavedVocab`**

Replace the stub with:

```js
let savedVocabSearch = '';
let savedVocabFilter = 'all';

function renderSavedVocab() {
  const listEl = document.getElementById('saved-vocab-list');
  const countEl = document.querySelector('.saved-vocab-count');

  const search = savedVocabSearch.trim().toLowerCase();
  const entries = savedVocabCache.filter(e => {
    if (savedVocabFilter !== 'all' && e.bucket !== savedVocabFilter) return false;
    if (!search) return true;
    return e.expression.toLowerCase().includes(search) ||
           (e.meaning || '').toLowerCase().includes(search);
  });

  // Count across all (unfiltered) entries for the header
  const totalEntries = savedVocabCache.length;
  const sessionIds = new Set();
  for (const e of savedVocabCache) {
    for (const s of e.sources || []) sessionIds.add(s.sessionId);
  }
  countEl.textContent = `${totalEntries} phrase${totalEntries === 1 ? '' : 's'} across ${sessionIds.size} session${sessionIds.size === 1 ? '' : 's'}`;

  if (!entries.length) {
    listEl.innerHTML = totalEntries === 0
      ? '<div class="saved-vocab-empty">No saved vocab yet — save phrases from the Vocab tab.</div>'
      : '<div class="saved-vocab-empty">No matches for the current filter.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'saved-vocab-row';

    const sources = entry.sources || [];
    const firstSource = sources[0];
    const contextQuote = firstSource?.contextQuote || '';
    const sourceLine = formatSavedVocabSource(sources);

    row.innerHTML = `
      <div>
        <div class="saved-vocab-expr">
          <span class="bucket-dot bucket-${entry.bucket || 'intermediate'}"></span>
          ${escapeHtml(entry.expression)}
        </div>
        <div class="saved-vocab-meaning">${escapeHtml(entry.meaning || '')}</div>
        ${contextQuote ? `<div class="saved-vocab-ctx">"${escapeHtml(contextQuote)}"</div>` : ''}
        <div class="saved-vocab-source">${sourceLine}</div>
      </div>
      <button class="vocab-star-btn saved" title="Remove from saved">★</button>
    `;

    row.querySelector('.vocab-star-btn').addEventListener('click', async () => {
      await removeSavedVocabEntry(entry);
    });

    listEl.appendChild(row);
  }
}

function formatSavedVocabSource(sources) {
  if (!sources.length) return '';
  if (sources.length === 1) {
    const s = sources[0];
    const name = sessionsById.has(s.sessionId) ? s.sessionName : `${s.sessionName || 'Unknown session'} (session removed)`;
    return `from <strong>${escapeHtml(name)}</strong>`;
  }
  const names = sources.map(s => s.sessionName || 'Unknown session');
  const title = escapeAttr(names.join(', '));
  return `from <strong title="${title}">${sources.length} sessions</strong>`;
}

async function removeSavedVocabEntry(entry) {
  const key = normalizeExpression(entry.expression);
  try {
    const res = await fetch('/api/saved-vocab/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: entry.expression }),
    });
    if (!res.ok) throw new Error('Remove failed');
    savedVocabCache = savedVocabCache.filter(e => normalizeExpression(e.expression) !== key);
    savedVocabSet.delete(key);
    updateSavedVocabCount();
    renderSavedVocab();
    // Also refresh the session-level Vocab tab so its star updates
    if (currentSession) renderVocab();
  } catch (err) {
    console.error('[capitaliano] removeSavedVocabEntry failed:', err);
    alert('Failed to remove saved vocab. Please try again.');
  }
}
```

- [ ] **Step 3: Wire search and filter event listeners**

Inside the existing app initialization area (or near the end of the script, after the DOM exists):

```js
document.getElementById('saved-vocab-search').addEventListener('input', (e) => {
  savedVocabSearch = e.target.value;
  renderSavedVocab();
});

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    savedVocabFilter = chip.dataset.bucket;
    renderSavedVocab();
  });
});
```

- [ ] **Step 4: Manual smoke test**

Reload the app. Save a couple of idioms from a session's Vocab tab. Click Saved Vocab in the sidebar. Verify:
- The header shows "N phrases across M sessions".
- The list renders with bucket dot, expression, meaning, context quote, source line.
- Typing in the search box filters live.
- Clicking a bucket chip filters by bucket.
- Clicking ★ on a row removes the entry from the list and from the session vocab tab.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: render saved vocab view with search and filters"
```

---

## Chunk 6: Backfill script

### Task 12: Write the backfill script

**Files:**
- Create: `scripts/backfill-buckets.js`

**Context:** A standalone Node script that loads every session, finds idioms without `bucket`, classifies them via Claude in one batch per session, and writes the buckets back. Idempotent — safe to re-run.

- [ ] **Step 1: Create the script**

Create `scripts/backfill-buckets.js`:

```js
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

async function classifyBatch(expressions) {
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
    max_tokens: 2048,
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
```

- [ ] **Step 2: Dry-run smoke test on a fresh session**

First, stop the running server (to avoid a concurrent session write). Then:

Run: `node scripts/backfill-buckets.js`
Expected: prints `[skip]` for sessions with no unbucketed idioms, `[classify]` + `[write]` for sessions with unbucketed idioms, and a total cost under $0.50. No errors.

- [ ] **Step 3: Verify a session file**

Spot-check one updated session file — every idiom should have a `bucket` field.

Run: `node -e "const s = JSON.parse(require('fs').readFileSync('sessions/sess_1775675460878.json', 'utf-8')); const all = s.lines.flatMap(l => l.idioms || []); console.log('bucketed:', all.filter(i => i.bucket).length, '/', all.length);"`
Expected: `bucketed: N / N` where N is the total idiom count.

- [ ] **Step 4: Re-run to confirm idempotency**

Run: `node scripts/backfill-buckets.js` again.
Expected: every session prints `[skip]` — no new classifications, no cost.

- [ ] **Step 5: Add `backfill:buckets` npm script for discoverability**

In `package.json`, add to `scripts`:

```json
"scripts": {
  "start": "node server.js",
  "backfill:buckets": "node scripts/backfill-buckets.js"
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-buckets.js package.json
git commit -m "feat: add one-shot idiom difficulty backfill script"
```

---

## Chunk 7: Final verification

### Task 13: Full manual smoke test

**No code changes** — just verification.

- [ ] **Step 1: Restart server fresh**

Stop any running instance. Run: `npm start`

- [ ] **Step 2: Verify backfilled sessions sort correctly**

Open the app. Load `PSG vs Liverpool` (or another backfilled session). Switch to Vocab tab. Verify:
- Group labels appear in order Advanced → Intermediate → Common.
- Colored bucket dots match the labels.
- Star buttons are present on every row.

- [ ] **Step 3: Save some idioms across two sessions**

From PSG vs Liverpool, save two Advanced idioms. Load Napoli vs AC Milan, save one Intermediate idiom and the same Advanced idiom you saved before (if it appears).

- [ ] **Step 4: Verify the Saved Vocab view**

Click Saved Vocab in the sidebar. Verify:
- Three unique entries (the repeated phrase is deduped).
- Multi-source entry shows "from 2 sessions" with a tooltip listing both names.
- Header reads "3 phrases across 2 sessions".
- Search box filters live.
- Bucket chips filter by level.
- Clicking ★ removes an entry and it also unstars in the session Vocab tab when you switch back.

- [ ] **Step 5: Run full test suite**

Run: `node --test test/translate.test.js test/saved-vocab.test.js`
Expected: all tests pass.

Then with the server running: `node --test test/saved-vocab-api.test.js`
Expected: all tests pass.

- [ ] **Step 6: Verify no lingering test artifacts**

Run: `node -e "const v = JSON.parse(require('fs').readFileSync('sessions/saved-vocab.json','utf-8')); console.log(v.entries.filter(e => e.expression.startsWith('TEST_')).length)"`
Expected: `0`

- [ ] **Step 7: Final commit if anything was fixed along the way, otherwise skip**

---

## Out of scope (not to build in this plan)

- Inline save button on transcript-underlined idioms.
- Click-through from Saved Vocab → original session line.
- Anki export.
- Tagging or editing saved entries.
- Auto-backfill on server start.
