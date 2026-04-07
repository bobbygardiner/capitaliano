// test/audio.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../lib/audio.js';

describe('pcmToWav', () => {
  it('prepends a 44-byte WAV header to PCM data', () => {
    const pcm = Buffer.alloc(32000);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.length, 32000 + 44);
  });

  it('writes correct RIFF header', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
    assert.equal(wav.toString('ascii', 36, 40), 'data');
  });

  it('encodes correct file size in header', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.readUInt32LE(4), 100 + 44 - 8);
    assert.equal(wav.readUInt32LE(40), 100);
  });

  it('encodes PCM16 mono format fields', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt32LE(28), 32000);
    assert.equal(wav.readUInt16LE(32), 2);
    assert.equal(wav.readUInt16LE(34), 16);
  });

  it('preserves PCM data after header', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm, 16000);
    assert.deepEqual(wav.subarray(44), pcm);
  });
});
