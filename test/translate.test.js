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
