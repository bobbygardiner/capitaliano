// test/translate.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitAndAnalyze, mergeAndAnalyze } from '../lib/translate.js';

describe('splitAndAnalyze', () => {
  it('is exported as a function', () => {
    assert.equal(typeof splitAndAnalyze, 'function');
  });
});

describe('mergeAndAnalyze', () => {
  it('is exported as a function', () => {
    assert.equal(typeof mergeAndAnalyze, 'function');
  });
});

// Step 1: Import normalizeAnalysis for testing
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
