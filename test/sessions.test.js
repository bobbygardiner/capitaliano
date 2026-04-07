// test/sessions.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as sessions from '../lib/sessions.js';

describe('addLine with audioOffsetSec', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    try { await sessions.end(); } catch {}
  });

  it('stores audioOffsetSec on the line object', async () => {
    await sessions.create('Test audio offset');
    const lineId = sessions.addLine('test text', 42.5);
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].audioOffsetSec, 42.5);
    await sessions.end();
  });

  it('defaults audioOffsetSec to null when not provided', async () => {
    await sessions.create('Test audio offset default');
    const lineId = sessions.addLine('test text');
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].audioOffsetSec, null);
    await sessions.end();
  });
});

describe('updateLine with text field', () => {
  let testSessionId = null;

  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    try { await sessions.end(); } catch {}
  });

  it('updates line text when text field is provided', async () => {
    const session = await sessions.create('Test updateLine text');
    testSessionId = session.id;
    const lineId = sessions.addLine('original text');
    const result = sessions.updateLine(lineId, { text: 'corrected text' });
    assert.equal(result, true);
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].text, 'corrected text');
    await sessions.end();
  });

  it('preserves existing text when text field is not provided', async () => {
    const session = await sessions.create('Test updateLine preserve');
    const lineId = sessions.addLine('original text');
    sessions.updateLine(lineId, { translation: 'english text' });
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].text, 'original text');
    assert.equal(active.lines[lineId].translation, 'english text');
    await sessions.end();
  });
});
