// test/batch.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextBias } from '../lib/batch.js';

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
    assert.ok(names.includes('Yann Sommer'));
    assert.ok(names.includes('Lautaro Martínez'));
    assert.ok(names.includes('Cristian Chivu'));
    assert.ok(names.includes('Inter Milan'));
    assert.ok(names.includes('AS Roma'));
    assert.ok(names.includes('Josep Martínez'));
  });

  it('filters out short tokens and lowercase words', () => {
    const context = 'Starters: Yann Sommer; the quick brown fox';
    const names = parseContextBias(context);
    assert.ok(names.includes('Yann Sommer'));
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
    assert.ok(names.includes('Lautaro Martínez'), 'should find Lautaro Martínez');
    assert.ok(names.includes('Lorenzo Pellegrini'), 'should find Pellegrini');
    assert.ok(names.includes('Gian Piero Gasperini'), 'should find Gasperini');
    assert.ok(names.length >= 20, `expected >=20 names, got ${names.length}`);
    assert.ok(names.length <= 100, `expected <=100 names, got ${names.length}`);
  });
});
