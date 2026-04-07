import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Helper: make a fake .pcm file with known content
async function writeFakePcm(sessionId, durationSec) {
  const bytesPerSec = 16000 * 2;
  const totalBytes = durationSec * bytesPerSec;
  const buf = Buffer.alloc(totalBytes);
  for (let i = 0; i < totalBytes; i += 2) {
    buf.writeInt16LE((i / 2) % 32767, i);
  }
  const path = join('sessions', `${sessionId}.pcm`);
  await writeFile(path, buf);
  return { path, buf };
}

describe('GET /api/sessions/:id/audio', () => {
  const fakeId = 'sess_test_audio';

  before(async () => {
    await writeFakePcm(fakeId, 10);
  });

  after(async () => {
    try { await unlink(join('sessions', `${fakeId}.pcm`)); } catch {}
  });

  it('returns 404 when .pcm file does not exist', async () => {
    const res = await fetch('http://localhost:3000/api/sessions/sess_nonexistent/audio?from=0&to=1');
    assert.equal(res.status, 404);
  });

  it('returns WAV audio for a valid range', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=1&to=2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 32000 + 44);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  });

  it('clamps to file boundaries', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=9&to=20`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 32000 + 44);
  });

  it('reads to end of file when to is omitted', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=8`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 64000 + 44);
  });

  it('defaults from to 0 when omitted', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?to=1`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 32000 + 44);
  });
});
