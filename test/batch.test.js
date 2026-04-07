// test/batch.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextBias, createBatchPipeline } from '../lib/batch.js';

describe('parseContextBias', () => {
  it('extracts player names from structured match context', () => {
    const context = `Inter Milan vs AS Roma — Serie A, 5 April 2026

---
Inter Milan (Coach: Cristian Chivu)

Starters: Yann Sommer; Denzel Dumfries, Manuel Akanji, Francesco Acerbi, Alessandro Bastoni,
Federico Dimarco; Hakan Calhanoglu, Nicolò Barella, Piotr Zielinski; Marcus Thuram, Lautaro Martínez

Substitutes: Josep Martínez, Raffaele Di Gennaro
`;
    const names = parseContextBias(context);
    // context_bias requires single tokens — names are split into words
    assert.ok(names.includes('Sommer'));
    assert.ok(names.includes('Martínez'));
    assert.ok(names.includes('Chivu'));
    assert.ok(names.includes('Inter'));
    assert.ok(names.includes('Roma'));
    assert.ok(names.includes('Thuram'));
    assert.ok(names.includes('Lautaro'));
    // Should not have multi-word entries
    assert.ok(!names.includes('Yann Sommer'));
    assert.ok(!names.includes('Inter Milan'));
  });

  it('filters out short tokens and lowercase words', () => {
    const context = 'Starters: Yann Sommer; the quick brown fox';
    const names = parseContextBias(context);
    assert.ok(names.includes('Yann'));
    assert.ok(names.includes('Sommer'));
    assert.ok(!names.includes('the'));
    assert.ok(!names.includes('quick'));
    assert.ok(!names.includes('brown'));
    assert.ok(!names.includes('fox'));
  });

  it('caps at 100 entries', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `Player${i} Name${i}`);
    const context = lines.join(', ');
    const names = parseContextBias(context);
    assert.ok(names.length <= 100);
  });

  it('returns empty array for null/empty context', () => {
    assert.deepEqual(parseContextBias(null), []);
    assert.deepEqual(parseContextBias(''), []);
  });

  it('handles the full Inter-Roma fixture format', async () => {
    const { readFile } = await import('node:fs/promises');
    const context = await readFile('test/fixtures/inter-roma-context.txt', 'utf-8');
    const names = parseContextBias(context);
    // Single-token entries after split
    assert.ok(names.includes('Lautaro'), 'should find Lautaro');
    assert.ok(names.includes('Martínez'), 'should find Martínez');
    assert.ok(names.includes('Pellegrini'), 'should find Pellegrini');
    assert.ok(names.includes('Gasperini'), 'should find Gasperini');
    assert.ok(names.includes('Thuram'), 'should find Thuram');
    // No multi-word entries
    assert.ok(!names.some(n => n.includes(' ')), 'no multi-word entries');
    assert.ok(names.length >= 20, `expected >=20 names, got ${names.length}`);
    assert.ok(names.length <= 100, `expected <=100 names, got ${names.length}`);
  });
});

describe('BatchPipeline', () => {
  it('accumulates chunks and extracts audio on markSentence', async () => {
    const upgrades = [];
    const pipeline = createBatchPipeline({
      contextBias: ['Thuram'],
      onUpgrade: (lineId, result) => upgrades.push({ lineId, result }),
      transcribeFn: async (wavBuffer, contextBias) => {
        return { text: `transcribed:${wavBuffer.length}bytes` };
      },
      analyzeFn: async (text, ctx) => ({
        translation: `translated:${text}`,
        segments: [],
        entities: [],
        idioms: [],
        costUsd: 0.001,
      }),
    });

    const chunkSize = 8192;
    const chunksFor5s = Math.ceil(160000 / chunkSize);
    for (let i = 0; i < chunksFor5s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }

    pipeline.markSentence(0);
    await pipeline.flush();

    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].lineId, 0);
    assert.ok(upgrades[0].result.translation.startsWith('translated:'));
  });

  it('coalesces short utterances (<3s) with the next one', async () => {
    const upgrades = [];
    const pipeline = createBatchPipeline({
      contextBias: [],
      onUpgrade: (lineId, result) => upgrades.push({ lineId, result }),
      transcribeFn: async (wavBuffer) => ({ text: 'coalesced text' }),
      analyzeFn: async (text) => ({
        translation: text, segments: [], entities: [], idioms: [], costUsd: 0.001,
      }),
      splitAnalyzeFn: async (batchText, originals, ctx) => {
        return originals.map((_, i) => ({
          translation: `split-${i}`, segments: [], entities: [], idioms: [], costUsd: 0.001,
        }));
      },
    });

    const chunkSize = 8192;
    const chunksFor2s = Math.ceil(64000 / chunkSize);
    for (let i = 0; i < chunksFor2s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }
    pipeline.markSentence(0, 'short line one');

    assert.equal(upgrades.length, 0);

    const chunksFor4s = Math.ceil(128000 / chunkSize);
    for (let i = 0; i < chunksFor4s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }
    pipeline.markSentence(1, 'second line');

    await pipeline.flush();

    assert.equal(upgrades.length, 2);
    assert.equal(upgrades[0].lineId, 0);
    assert.equal(upgrades[1].lineId, 1);
  });

  it('respects 1MB audio cap and discards excess', () => {
    const pipeline = createBatchPipeline({
      contextBias: [],
      onUpgrade: () => {},
      transcribeFn: async () => ({ text: '' }),
      analyzeFn: async () => null,
    });

    const chunkSize = 8192;
    const chunksFor1_5MB = Math.ceil(1572864 / chunkSize);
    for (let i = 0; i < chunksFor1_5MB; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }

    assert.ok(pipeline.pendingBytes() <= 1048576,
      `expected <=1MB, got ${pipeline.pendingBytes()}`);
  });
});
