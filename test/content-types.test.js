import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const CT_PATH = 'content-types.json';
let originalContent;

before(async () => {
  try { originalContent = await readFile(CT_PATH, 'utf-8'); } catch { originalContent = null; }
});

after(async () => {
  if (originalContent !== null) {
    await writeFile(CT_PATH, originalContent);
  }
});

describe('content-types', () => {
  let mod;
  before(async () => {
    mod = await import('../lib/content-types.js');
  });

  it('exports list, add, and generatePromptHint functions', () => {
    assert.equal(typeof mod.list, 'function');
    assert.equal(typeof mod.add, 'function');
    assert.equal(typeof mod.generatePromptHint, 'function');
    assert.equal(typeof mod.slugify, 'function');
  });

  it('list returns the preset types', async () => {
    const types = await mod.list();
    assert.ok(Array.isArray(types));
    assert.ok(types.length >= 3);
    assert.ok(types.find(t => t.id === 'football-match'));
    assert.ok(types.find(t => t.id === 'general'));
  });

  it('slugify converts labels to kebab-case IDs', () => {
    assert.equal(mod.slugify('Football Match'), 'football-match');
    assert.equal(mod.slugify('Italian Cooking Show'), 'italian-cooking-show');
    assert.equal(mod.slugify('  Spaces  Everywhere  '), 'spaces-everywhere');
  });

  it('add rejects duplicate IDs', async () => {
    await assert.rejects(
      () => mod.add('Football Match'),
      { message: /already exists/ }
    );
  });
});
