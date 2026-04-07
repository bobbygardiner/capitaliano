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

describe('setAudioStartedAt', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    try { await sessions.end(); } catch {}
  });

  it('stores audioStartedAt on the active session', async () => {
    await sessions.create('Test audio start');
    const ts = new Date().toISOString();
    sessions.setAudioStartedAt(ts);
    const active = sessions.getActive();
    assert.equal(active.audioStartedAt, ts);
    await sessions.end();
  });

  it('does nothing when no active session', () => {
    sessions.setAudioStartedAt(new Date().toISOString());
    // should not throw
  });
});

describe('remove deletes pcm file', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  it('deletes .pcm file when removing a session', async () => {
    const session = await sessions.create('Test PCM cleanup');
    const id = session.id;
    await sessions.end();

    // Create a fake .pcm file
    const pcmPath = join('sessions', `${id}.pcm`);
    await writeFile(pcmPath, Buffer.alloc(100));
    assert.equal(existsSync(pcmPath), true);

    await sessions.remove(id);
    assert.equal(existsSync(pcmPath), false);
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
