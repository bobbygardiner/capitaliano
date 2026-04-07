// test/translate.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitAndAnalyze } from '../lib/translate.js';

describe('splitAndAnalyze', () => {
  it('is exported as a function', () => {
    assert.equal(typeof splitAndAnalyze, 'function');
  });
});
