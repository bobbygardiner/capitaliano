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
