# Two-Phase Transcription Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second batch transcription pass with context_bias that progressively upgrades realtime transcription with corrected player names and better entities.

**Architecture:** Audio chunks feed both Mistral Realtime (existing) and a new BatchPipeline. The pipeline uses realtime sentence boundaries as batch windows, POSTs WAV audio to the Mistral batch API with context_bias, re-translates via Haiku, and broadcasts `analysis.upgrade` events. The frontend applies upgrades with a 200ms cross-fade.

**Tech Stack:** Node.js, Mistral Voxtral Batch API (`POST /v1/audio/transcriptions`), Claude Haiku, `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-04-07-two-phase-transcription-design.md`

---

## Chunk 1: Foundation

### Task 1: Create `lib/audio.js` — PCM-to-WAV utility

**Files:**
- Create: `lib/audio.js`
- Create: `test/audio.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/audio.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../lib/audio.js';

describe('pcmToWav', () => {
  it('prepends a 44-byte WAV header to PCM data', () => {
    const pcm = Buffer.alloc(32000); // 1 second at 16kHz 16-bit
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
    // RIFF chunk size = file size - 8
    assert.equal(wav.readUInt32LE(4), 100 + 44 - 8);
    // data chunk size = PCM data length
    assert.equal(wav.readUInt32LE(40), 100);
  });

  it('encodes PCM16 mono format fields', () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.readUInt16LE(20), 1);     // PCM format
    assert.equal(wav.readUInt16LE(22), 1);     // mono
    assert.equal(wav.readUInt32LE(24), 16000); // sample rate
    assert.equal(wav.readUInt32LE(28), 32000); // byte rate (16000 * 2)
    assert.equal(wav.readUInt16LE(32), 2);     // block align
    assert.equal(wav.readUInt16LE(34), 16);    // bits per sample
  });

  it('preserves PCM data after header', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm, 16000);
    assert.deepEqual(wav.subarray(44), pcm);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audio.test.js`
Expected: FAIL — `pcmToWav` is not exported (module doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

```js
// lib/audio.js

/**
 * Wrap raw PCM16 mono data in a WAV header.
 * @param {Buffer} pcmData - Raw PCM16 little-endian audio
 * @param {number} sampleRate - e.g. 16000
 * @returns {Buffer} Complete WAV file buffer
 */
export function pcmToWav(pcmData, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);                       // ChunkID
  header.writeUInt32LE(dataSize + 36, 4);         // ChunkSize (file - 8)
  header.write('WAVE', 8);                        // Format
  header.write('fmt ', 12);                       // Subchunk1ID
  header.writeUInt32LE(16, 16);                   // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                    // AudioFormat (PCM = 1)
  header.writeUInt16LE(numChannels, 22);          // NumChannels
  header.writeUInt32LE(sampleRate, 24);           // SampleRate
  header.writeUInt32LE(byteRate, 28);             // ByteRate
  header.writeUInt16LE(blockAlign, 32);           // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);        // BitsPerSample
  header.write('data', 36);                       // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);             // Subchunk2Size

  return Buffer.concat([header, pcmData]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audio.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/audio.js test/audio.test.js
git commit -m "feat: add pcmToWav utility for WAV header construction"
```

---

### Task 2: Update `sessions.js` — persist phase-2 text

**Files:**
- Modify: `lib/sessions.js:165-176` (updateLine function)
- Create: `test/sessions.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/sessions.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../lib/sessions.js';

describe('updateLine with text field', () => {
  let testSessionId = null;

  before(async () => {
    await sessions.init();
    // End any leftover active session from a previous test run
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    // Clean up: end any active session we created
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: First test FAILS — `updateLine` does not update `text` field, so `active.lines[lineId].text` is still `'original text'`

- [ ] **Step 3: Add text field to updateLine**

In `lib/sessions.js`, inside the `updateLine` function, add one line after the existing field checks (around line 169):

```js
  if (updates.text !== undefined) line.text = updates.text;
```

This goes right before or after the existing `if (updates.translation !== undefined)` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sessions.test.js`
Expected: Both tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sessions.js test/sessions.test.js
git commit -m "feat: allow updateLine to persist corrected text from phase 2"
```

---

### Task 3: Simplify sentence accumulator in `server.js`

**Files:**
- Modify: `server.js:224-248` (sentence segmentation logic in the Mistral event loop)

This change removes the comma-split fallback and raises the safety ceiling from 300 to 500 characters. No unit test for this — it's wiring logic inside the WebSocket handler that will be validated by the integration test (Task 9).

- [ ] **Step 1: Read the current sentence segmentation code**

Read `server.js` lines 224-248 to confirm the exact code to replace.

- [ ] **Step 2: Replace the three-path logic with two-path logic**

Replace the sentence segmentation block inside the `transcription.text.delta` handler. The old code:

```js
if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
  sentenceCount++;
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
} else if (sentenceBuffer.length >= 300) {
  // Force break at last comma
  const breakIdx = sentenceBuffer.lastIndexOf(',');
  if (breakIdx > MIN_SENTENCE_LENGTH) {
    sentenceCount++;
    finalizeSentence(sentenceBuffer.slice(0, breakIdx + 1));
    sentenceBuffer = sentenceBuffer.slice(breakIdx + 1).trimStart();
  } else {
    sentenceCount++;
    finalizeSentence(sentenceBuffer);
    sentenceBuffer = '';
  }
}
```

Becomes:

```js
if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
  sentenceCount++;
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
} else if (sentenceBuffer.length >= 500) {
  sentenceCount++;
  finalizeSentence(sentenceBuffer);
  sentenceBuffer = '';
}
```

- [ ] **Step 3: Verify the server still starts**

Run: `node server.js` (briefly, then Ctrl+C)
Expected: `[capito] Running at http://localhost:3000` — no syntax errors

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "refactor: simplify sentence accumulator, remove comma-split, raise ceiling to 500"
```

---

## Chunk 2: Core Pipeline

### Task 4: Add context_bias parsing to `lib/batch.js`

**Files:**
- Create: `lib/batch.js` (will be expanded in Task 5)
- Create: `test/batch.test.js` (will be expanded in Task 5)

We start `batch.js` with just the context parsing function, tested independently.

- [ ] **Step 1: Write the failing test**

```js
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
    // Generate 120 fake names
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
    // Should find key players from both squads
    assert.ok(names.includes('Lautaro Martínez'), 'should find Lautaro Martínez');
    assert.ok(names.includes('Lorenzo Pellegrini'), 'should find Pellegrini');
    assert.ok(names.includes('Gian Piero Gasperini'), 'should find Gasperini');
    assert.ok(names.length >= 20, `expected >=20 names, got ${names.length}`);
    assert.ok(names.length <= 100, `expected <=100 names, got ${names.length}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/batch.test.js`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Write the parseContextBias function**

```js
// lib/batch.js

/**
 * Parse a free-text match context into a context_bias string array.
 * Extracts proper nouns (multi-word names starting with uppercase).
 */
export function parseContextBias(context) {
  if (!context || !context.trim()) return [];

  const names = new Set();

  // First pass: extract team names and coach names from structured lines
  const lines = context.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;

    // Match "Team Name (Coach: Coach Name)" pattern
    const teamCoachMatch = trimmed.match(/^(.+?)\s*\(Coach:\s*(.+?)\)/);
    if (teamCoachMatch) {
      names.add(teamCoachMatch[1].trim());
      names.add(teamCoachMatch[2].trim());
      continue;
    }

    // Match "Team A vs Team B" pattern
    const vsMatch = trimmed.match(/^(.+?)\s+vs\s+(.+?)\s*[—–-]/);
    if (vsMatch) {
      names.add(vsMatch[1].trim());
      names.add(vsMatch[2].trim());
      continue;
    }

    // Strip labels like "Starters:" or "Substitutes:"
    const afterLabel = trimmed.replace(/^(Starters|Substitutes)\s*:\s*/, '');
    if (afterLabel === trimmed && !trimmed.includes(',') && !trimmed.includes(';')) continue;

    // Split by comma and semicolon to get individual names
    const parts = afterLabel.split(/[,;]+/);
    for (const part of parts) {
      const name = part.trim();
      // Multi-word proper noun: at least 2 chars, first char uppercase
      if (name.length >= 2 && /^[A-ZÀ-Ž]/.test(name)) {
        // Filter out noise: pure lowercase words, single-char tokens after split
        const words = name.split(/\s+/).filter(w => w.length >= 2);
        if (words.length >= 1 && words.every(w => /^[A-ZÀ-Ž]/.test(w))) {
          names.add(words.join(' '));
        }
      }
    }
  }

  const result = [...names];
  return result.slice(0, 100);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/batch.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/batch.js test/batch.test.js
git commit -m "feat: add parseContextBias for extracting names from match context"
```

---

### Task 5: Build the BatchPipeline in `lib/batch.js`

**Files:**
- Modify: `lib/batch.js` (add createBatchPipeline, audio accumulation, coalescing, Mistral batch call)
- Modify: `test/batch.test.js` (add pipeline tests)

This is the largest task. We test the accumulation/coalescing logic with a mock transcription function, keeping the Mistral API call behind an injectable dependency.

- [ ] **Step 1: Write failing tests for the pipeline**

Append to `test/batch.test.js`:

```js
import { createBatchPipeline } from '../lib/batch.js';

describe('BatchPipeline', () => {
  it('accumulates chunks and extracts audio on markSentence', async () => {
    const upgrades = [];
    const pipeline = createBatchPipeline({
      contextBias: ['Thuram'],
      onUpgrade: (lineId, result) => upgrades.push({ lineId, result }),
      // Mock transcribe function — returns the audio length as "text"
      transcribeFn: async (wavBuffer, contextBias) => {
        return { text: `transcribed:${wavBuffer.length}bytes` };
      },
      // Mock analyze function
      analyzeFn: async (text, ctx) => ({
        translation: `translated:${text}`,
        segments: [],
        entities: [],
        idioms: [],
        costUsd: 0.001,
      }),
    });

    // Push 5 seconds of audio (160KB at 16kHz 16-bit mono)
    const chunkSize = 8192; // 256ms chunk
    const chunksFor5s = Math.ceil(160000 / chunkSize);
    for (let i = 0; i < chunksFor5s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }

    // Mark a sentence — should trigger batch
    pipeline.markSentence(0);
    // Wait for async batch to complete
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

    // Push 2 seconds of audio (short utterance)
    const chunkSize = 8192;
    const chunksFor2s = Math.ceil(64000 / chunkSize);
    for (let i = 0; i < chunksFor2s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }
    pipeline.markSentence(0, 'short line one');

    // Should NOT have triggered yet (coalescing)
    assert.equal(upgrades.length, 0);

    // Push 4 more seconds and mark again
    const chunksFor4s = Math.ceil(128000 / chunkSize);
    for (let i = 0; i < chunksFor4s; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }
    pipeline.markSentence(1, 'second line');

    await pipeline.flush();

    // Should have triggered with coalesced result using splitAnalyzeFn
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

    // Push 1.5MB of audio without any markSentence
    const chunkSize = 8192;
    const chunksFor1_5MB = Math.ceil(1572864 / chunkSize);
    for (let i = 0; i < chunksFor1_5MB; i++) {
      pipeline.pushChunk(Buffer.alloc(chunkSize));
    }

    // Internal bytes should be capped at or below 1MB
    assert.ok(pipeline.pendingBytes() <= 1048576,
      `expected <=1MB, got ${pipeline.pendingBytes()}`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/batch.test.js`
Expected: FAIL — `createBatchPipeline` not exported

- [ ] **Step 3: Implement createBatchPipeline**

Add to `lib/batch.js` (after the existing `parseContextBias`):

```js
import { pcmToWav } from './audio.js';

const COALESCE_THRESHOLD = 96000; // 3s at 16kHz 16-bit mono
const MAX_AUDIO_BYTES = 1048576;  // 1MB ~30s

/**
 * Create a batch transcription pipeline.
 * @param {Object} options
 * @param {string[]} options.contextBias - Names for context_bias
 * @param {Function} options.onUpgrade - Called with (lineId, analysisResult) per upgraded line
 * @param {Function} [options.transcribeFn] - Override for testing; default calls Mistral batch API
 * @param {Function} [options.analyzeFn] - Override for testing; default calls analyzeCommentary
 * @param {Function} [options.splitAnalyzeFn] - Override for testing; default calls splitAndAnalyze
 */
export function createBatchPipeline(options) {
  const { contextBias, onUpgrade, transcribeFn, analyzeFn, splitAnalyzeFn } = options;

  let chunks = [];
  let totalBytes = 0;
  let lastMarkOffset = 0;

  // Coalescing state
  let pending = null; // { audioChunks, lineIds, originalTexts, bytes }

  // In-flight tracking
  const inflight = new Set();

  function pushChunk(chunk) {
    chunks.push(chunk);
    totalBytes += chunk.length;

    // Max audio cap
    if (totalBytes - lastMarkOffset > MAX_AUDIO_BYTES) {
      console.warn('[capito] Audio buffer exceeded 1MB without markSentence, discarding');
      chunks = [];
      totalBytes = 0;
      lastMarkOffset = 0;
      pending = null;
    }
  }

  function extractAudioSinceMark() {
    // All chunks accumulated since last mark belong to this utterance.
    // After each extraction we clear the array, so chunks always starts
    // from the last mark boundary — no offset arithmetic needed.
    const audioBytes = totalBytes;
    const buffer = audioBytes > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    chunks = [];
    totalBytes = 0;
    lastMarkOffset = 0;
    return { buffer, bytes: audioBytes };
  }

  function markSentence(lineId, originalText) {
    const { buffer: audioBuffer, bytes } = extractAudioSinceMark();

    if (bytes < COALESCE_THRESHOLD) {
      // Short utterance — coalesce
      if (pending) {
        // Merge with pending and submit
        pending.audioChunks.push(audioBuffer);
        pending.lineIds.push(lineId);
        pending.originalTexts.push(originalText || '');
        pending.bytes += bytes;
        const merged = pending;
        pending = null;
        submitBatch(
          Buffer.concat(merged.audioChunks),
          merged.lineIds,
          merged.originalTexts,
        );
      } else {
        // Start a new pending
        pending = {
          audioChunks: [audioBuffer],
          lineIds: [lineId],
          originalTexts: [originalText || ''],
          bytes,
        };
      }
    } else {
      // Normal utterance — submit directly
      submitBatch(audioBuffer, [lineId], [originalText || '']);
    }
  }

  async function submitBatch(audioBuffer, lineIds, originalTexts) {
    const wavBuffer = pcmToWav(audioBuffer, 16000);
    const promise = (async () => {
      try {
        const batchResult = await transcribeFn(wavBuffer, contextBias);
        if (!batchResult || !batchResult.text) return;

        if (lineIds.length === 1) {
          // Simple case: 1:1 mapping
          const analysis = await analyzeFn(batchResult.text, null);
          if (analysis) {
            analysis.text = batchResult.text;
            onUpgrade(lineIds[0], analysis);
          }
        } else {
          // Coalesced case: split back to original lines
          if (splitAnalyzeFn) {
            const results = await splitAnalyzeFn(batchResult.text, originalTexts, null);
            if (results && results.length === lineIds.length) {
              const costEach = results.reduce((s, r) => s + (r.costUsd || 0), 0) / lineIds.length;
              for (let i = 0; i < lineIds.length; i++) {
                results[i].costUsd = costEach;
                onUpgrade(lineIds[i], results[i]);
              }
            } else {
              // Fallback: apply to first line only
              console.warn('[capito] splitAndAnalyze returned wrong count, falling back');
              const analysis = await analyzeFn(batchResult.text, null);
              if (analysis) {
                analysis.text = batchResult.text;
                onUpgrade(lineIds[0], analysis);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[capito] Batch upgrade failed for lines ${lineIds.join(',')}: ${err.message}`);
      }
    })();

    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }

  async function flush() {
    // Submit any pending coalesced audio
    if (pending) {
      submitBatch(
        Buffer.concat(pending.audioChunks),
        pending.lineIds,
        pending.originalTexts,
      );
      pending = null;
    }

    // Wait for all in-flight with 10s timeout
    if (inflight.size > 0) {
      const timeout = new Promise(resolve => setTimeout(resolve, 10000));
      await Promise.race([
        Promise.allSettled([...inflight]),
        timeout,
      ]);
      if (inflight.size > 0) {
        console.warn(`[capito] Flush timeout: ${inflight.size} batch requests still in-flight`);
      }
    }
  }

  function pendingBytes() {
    return totalBytes - lastMarkOffset;
  }

  return { pushChunk, markSentence, flush, pendingBytes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/batch.test.js`
Expected: All 8 tests PASS (5 from Task 4 + 3 new)

- [ ] **Step 5: Commit**

```bash
git add lib/batch.js test/batch.test.js
git commit -m "feat: add BatchPipeline with audio accumulation, coalescing, and cap"
```

---

### Task 6: Add `splitAndAnalyze` to `lib/translate.js`

**Files:**
- Modify: `lib/translate.js` (add splitAndAnalyze function)
- Create: `test/translate.test.js`

- [ ] **Step 1: Write the failing test**

We can't call the real Haiku API in tests, so test the prompt construction and response parsing with a mock. The test verifies the function constructs the right prompt and correctly parses/validates the response.

```js
// test/translate.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitAndAnalyze } from '../lib/translate.js';

describe('splitAndAnalyze', () => {
  it('is exported as a function', () => {
    assert.equal(typeof splitAndAnalyze, 'function');
  });
});
```

This is a thin test since the real behavior requires the Anthropic API. The integration test (Task 9) will validate the full path.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/translate.test.js`
Expected: FAIL — `splitAndAnalyze` not exported

- [ ] **Step 3: Implement splitAndAnalyze**

Add to `lib/translate.js` after the existing `analyzeCommentary` function:

```js
const SPLIT_SYSTEM_PROMPT = `You are an expert Italian-to-English football commentary translator.

You will receive an improved Italian transcription and the original line splits it corresponds to. Your job is to:
1. Distribute the improved text across the original line boundaries (same number of lines)
2. For each line, produce the same analysis as a standard commentary translation

Return a JSON array where each element has: {segments, translation, entities, idioms}.
- "segments": array of {it, en} pairs (Italian chunk + English translation)
- "translation": full English translation of that line
- "entities": [{text, type}] where type is "player"|"team"|"stadium"|"coach"
- "idioms": [{expression, meaning}]

Use the match context (if provided) to correct player name spellings.
Return ONLY valid JSON (a JSON array, not wrapped in an object).`;

async function trySplitAnalyze(batchText, originalTexts, matchContext) {
  const systemPrompt = matchContext
    ? `${SPLIT_SYSTEM_PROMPT}\n\nMatch context:\n${matchContext}`
    : SPLIT_SYSTEM_PROMPT;

  const userMessage = `Improved transcription:
"${batchText}"

Original line splits (preserve this exact number of lines):
${originalTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    const result = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(result) || result.length !== originalTexts.length) {
      throw new Error(`Expected ${originalTexts.length} results, got ${Array.isArray(result) ? result.length : 'non-array'}`);
    }

    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalCost = (inputTokens * INPUT_COST_PER_MTOK + outputTokens * OUTPUT_COST_PER_MTOK) / 1_000_000;

    return result.map(r => ({
      translation: r.translation || null,
      segments: Array.isArray(r.segments) ? r.segments : [],
      entities: Array.isArray(r.entities) ? r.entities : [],
      idioms: Array.isArray(r.idioms) ? r.idioms : [],
      costUsd: totalCost / originalTexts.length,
    }));
  } catch (err) {
    console.error(`[capito] splitAndAnalyze failed: ${err.message}`);
    return null;
  }
}

async function splitAndAnalyze(batchText, originalTexts, matchContext) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await trySplitAnalyze(batchText, originalTexts, matchContext);
    if (result) return result;
    if (attempt === 0) console.log('[capito] splitAndAnalyze retry...');
  }
  return null;
}

export { analyzeCommentary, splitAndAnalyze };
```

Note: update the existing `export` line at the bottom to include `splitAndAnalyze`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/translate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/translate.js test/translate.test.js
git commit -m "feat: add splitAndAnalyze for coalesced line re-translation"
```

---

### Task 7: Add Mistral batch transcription function to `lib/batch.js`

**Files:**
- Modify: `lib/batch.js` (add `transcribeBatch` that calls the real Mistral API)

This is the HTTP call to `POST /v1/audio/transcriptions`. It uses the `@mistralai/mistralai` SDK if it supports the endpoint, otherwise falls back to raw `fetch`.

- [ ] **Step 1: Check if the Mistral SDK supports the batch transcription endpoint**

Read `node_modules/@mistralai/mistralai` to check for an audio transcription method. Look for methods like `audio.transcriptions.create` or similar.

```bash
grep -r "transcription" node_modules/@mistralai/mistralai/src/ --include="*.js" -l 2>/dev/null || \
grep -r "transcription" node_modules/@mistralai/mistralai/ --include="*.d.ts" -l 2>/dev/null | head -5
```

- [ ] **Step 2: Implement transcribeBatch**

Add to `lib/batch.js`. Use raw `fetch` to call the Mistral REST API directly — this avoids SDK version coupling:

```js
/**
 * Call the Mistral batch transcription API.
 * @param {Buffer} wavBuffer - Complete WAV file buffer
 * @param {string[]} contextBias - Names for context_bias
 * @returns {Promise<{text: string}>} Transcription result
 */
export async function transcribeBatch(wavBuffer, contextBias) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

  const formData = new FormData();
  formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'voxtral-mini-latest');
  if (contextBias.length > 0) {
    for (const name of contextBias) {
      formData.append('context_bias', name);
    }
  }

  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mistral batch API ${response.status}: ${body.slice(0, 200)}`);
  }

  const result = await response.json();
  return { text: result.text || '' };
}
```

Note: The `context_bias` parameter format needs to be verified at implementation time. It may be a JSON array in a single field or repeated form fields. Check the Mistral docs and adjust accordingly. An alternative approach:

```js
// If context_bias needs to be a JSON string:
formData.append('context_bias', JSON.stringify(contextBias));
```

- [ ] **Step 3: Verify the module still loads**

Run: `node -e "import('./lib/batch.js').then(m => console.log(Object.keys(m)))"`
Expected: prints `['parseContextBias', 'createBatchPipeline', 'transcribeBatch']`

- [ ] **Step 4: Commit**

```bash
git add lib/batch.js
git commit -m "feat: add transcribeBatch for Mistral batch API calls"
```

---

## Chunk 3: Integration

### Task 8: Wire batch pipeline into `server.js`

**Files:**
- Modify: `server.js` (import batch module, create pipeline per connection, feed chunks, wire upgrade broadcast)

- [ ] **Step 1: Update imports**

**Replace** the existing line 11 in `server.js`:
```js
import { analyzeCommentary } from './lib/translate.js';
```
with these two lines (do NOT add a second translate import — replace the existing one):
```js
import { createBatchPipeline, parseContextBias, transcribeBatch } from './lib/batch.js';
import { analyzeCommentary, splitAndAnalyze } from './lib/translate.js';
```

- [ ] **Step 2: Create the batch pipeline inside the WS connection handler**

Inside `wss.on('connection', async (ws) => { ... })`, after the `let connection = null;` / `let mistralReady = false;` block, add:

```js
  // Batch pipeline for phase 2 transcription.
  // contextBias is computed lazily via transcribeFn so it picks up the
  // current session's context even if the session was created after WS connect.
  let cachedBias = null;
  let cachedBiasContext = undefined; // sentinel: undefined = never computed
  function getContextBias() {
    const ctx = sessions.getActive()?.context;
    if (ctx !== cachedBiasContext) {
      cachedBiasContext = ctx;
      cachedBias = parseContextBias(ctx);
    }
    return cachedBias;
  }

  const pipeline = createBatchPipeline({
    contextBias: [], // not used directly — transcribeFn reads live bias
    onUpgrade: (lineId, result) => {
      sessions.updateLine(lineId, result);
      broadcast({ type: 'analysis.upgrade', lineId, ...result });
    },
    transcribeFn: (wavBuffer) => transcribeBatch(wavBuffer, getContextBias()),
    analyzeFn: (text, _ctx) => analyzeCommentary(text, sessions.getActive()?.context),
    splitAnalyzeFn: (batchText, originals, _ctx) =>
      splitAndAnalyze(batchText, originals, sessions.getActive()?.context),
  });
```

- [ ] **Step 3: Feed audio chunks to the pipeline**

In the `ws.on('message', ...)` handler, add `pipeline.pushChunk(data)` **unconditionally**
for every binary message — at the same level as `audioCount++`, NOT inside the
`if (mistralReady && connection)` guard. The batch pipeline must receive all audio
chunks including those that arrive before Mistral Realtime connects:

```js
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    audioCount++;
    pipeline.pushChunk(data);  // <-- unconditional, before Mistral guard
    if (!connection && !mistralReady && !mistralConnecting) {
      // ... existing Mistral connect logic
```

- [ ] **Step 4: Call markSentence in finalizeSentence**

In the `finalizeSentence` function, inside the existing `if (lineId !== null)` guard
(which already wraps the `analyzeCommentary` call), add:

```js
    if (lineId !== null) {
      const ctx = sessions.getActive()?.context;
      analyzeCommentary(text, ctx).then(analysis => { ... }); // existing
      pipeline.markSentence(lineId, text);  // <-- add this line
    }
```

- [ ] **Step 5: Add pipeline flush to WS close handler**

In the `ws.on('close', ...)` handler, add `await pipeline.flush();` before the Mistral connection cleanup:

```js
  ws.on('close', async () => {
    const elapsed = (audioCount * 0.256).toFixed(0);
    console.log(`[capito] Client disconnected after ${elapsed}s audio, ${eventCount} events, ${sentenceCount} sentences`);
    clearInterval(statusTimer);
    sentenceBuffer = '';
    await pipeline.flush();
    if (connection && !connection.isClosed) {
      try { await connection.endAudio(); await connection.close(); } catch {}
    }
  });
```

- [ ] **Step 6: Verify server starts**

Run: `node server.js` (briefly, then Ctrl+C)
Expected: `[capito] Running at http://localhost:3000` — no errors

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: wire batch pipeline into server for two-phase transcription"
```

---

### Task 9: Handle `analysis.upgrade` in the frontend

**Files:**
- Modify: `public/app.js` (add upgrade event handler, cross-fade animation)
- Modify: `public/index.html` (add CSS for upgrade animation)

- [ ] **Step 1: Add upgrade CSS to `index.html`**

Find the `</style>` closing tag in `index.html` and add before it:

```css
.transcript-line.upgrading {
  animation: upgrade-fade 200ms ease-out;
}
@keyframes upgrade-fade {
  from { opacity: 0.4; }
  to { opacity: 1; }
}
```

- [ ] **Step 2: Add the `analysis.upgrade` handler to `app.js`**

In the `handleEvent` function's `switch` statement, add a new case before the `case 'session.active':` block:

```js
    case 'analysis.upgrade': {
      const el = lineElements.get(event.lineId);
      if (!el) break;

      // Check if line is in viewport
      const rect = el.getBoundingClientRect();
      const inViewport = rect.top < window.innerHeight && rect.bottom > 0;

      if (inViewport) {
        el.classList.add('upgrading');
        el.addEventListener('animationend', () => el.classList.remove('upgrading'), { once: true });
      }

      // Apply segments/entities/idioms (same as analysis handler).
      // When segments are present, applySegments rebuilds the element contents
      // (including Italian text), so we skip the separate text update.
      if (event.segments && event.segments.length) {
        applySegments(el, event.segments, event.entities, event.idioms);
      } else {
        // No segments — update Italian text directly if changed
        if (event.text) {
          const italianEl = el.querySelector('.line-italian');
          if (italianEl) italianEl.textContent = event.text;
        }
        if (event.translation) addTranslation(el, event.translation);
        if (event.entities && event.entities.length) {
          applyEntityHighlighting(el, event.text || el.querySelector('.line-italian')?.textContent, event.entities);
        }
        if (event.idioms && event.idioms.length) {
          applyIdiomHighlighting(el, el.querySelector('.line-italian')?.textContent, event.idioms);
        }
      }

      // Track cost
      if (event.costUsd) {
        sessionCostUsd += event.costUsd;
        updateCostDisplay();
      }

      // Update in-memory session
      if (currentSession && currentSession.lines) {
        const line = currentSession.lines[event.lineId];
        if (line) {
          if (event.text) line.text = event.text;
          if (event.translation) line.translation = event.translation;
          if (event.segments) line.segments = event.segments;
          if (event.entities) line.entities = event.entities;
          if (event.idioms) line.idioms = event.idioms;
        }
        if (event.idioms && event.idioms.length) renderVocab();
      }
      break;
    }
```

- [ ] **Step 3: Verify no syntax errors**

Open `http://localhost:3000` in a browser (with server running) and check the console for JS errors.

- [ ] **Step 4: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat: handle analysis.upgrade events with cross-fade animation"
```

---

### Task 10: Update test script with `--context` flag and upgrade logging

**Files:**
- Modify: `test/send-audio.js`

- [ ] **Step 1: Add `--context` flag parsing**

Near the top of `test/send-audio.js`, after the existing argument parsing, add support for `--context`:

```js
import { readFile } from 'node:fs/promises';

// Parse --context flag
let contextText = null;
const contextIdx = process.argv.indexOf('--context');
if (contextIdx !== -1 && process.argv[contextIdx + 1]) {
  contextText = await readFile(resolve(process.argv[contextIdx + 1]), 'utf-8');
  console.log(`[test] Context loaded: ${contextText.split('\n').length} lines`);
}
```

- [ ] **Step 2: Pass context when creating session**

In the `createSession` function, update the body to include context:

```js
body: JSON.stringify({
  name: `Test: ${audioFile.split('/').pop()}`,
  ...(contextText && { context: contextText }),
}),
```

- [ ] **Step 3: Add `analysis.upgrade` event handling and upgrade latency tracking**

Add a separate `doneTimestamps` map (alongside the existing `pendingTranslations`) that
is never deleted — used for latency calculations on both `analysis` and `analysis.upgrade`:

```js
  const doneTimestamps = new Map(); // lineId -> timestamp, never cleared
  let upgradeCount = 0;
```

In the `transcription.done` handler, add: `doneTimestamps.set(event.lineId, Date.now());`

In the `ws.on('message', ...)` handler, add a new case in the switch:

```js
        case 'analysis.upgrade': {
          upgradeCount++;
          const sentAt = doneTimestamps.get(event.lineId);
          const latency = sentAt ? ((Date.now() - sentAt) / 1000).toFixed(1) : '?';
          console.log(`    UPGRADE EN: "${event.translation}" [${latency}s from done]`);
          if (event.text) console.log(`    UPGRADE IT: "${event.text}"`);
          if (event.segments?.length) console.log(`    Segments: ${event.segments.length}`);
          if (event.entities?.length) console.log(`    Entities: ${event.entities.map(e => `${e.text}(${e.type})`).join(', ')}`);
          break;
        }
```

Update the summary output to include upgrade count:
```js
          console.log(`Upgrades received: ${upgradeCount}`);
```

- [ ] **Step 4: Commit**

```bash
git add test/send-audio.js
git commit -m "feat: add --context flag and analysis.upgrade logging to test script"
```

---

### Task 11: Integration test with Inter-Roma fixture

**Files:**
- No new files — runs existing test script with fixtures

This task validates the full pipeline end-to-end.

- [ ] **Step 1: Start the server**

In one terminal:
```bash
node server.js
```

- [ ] **Step 2: Run the test with context**

In another terminal:
```bash
node test/send-audio.js test/fixtures/italian-commentary.mp3 --context test/fixtures/inter-roma-context.txt
```

- [ ] **Step 3: Verify output**

Check for:
- `[N] IT: "..."` lines (phase 1 realtime transcription) — should appear within ~2s of audio
- `    EN: "..."` lines (phase 1 Haiku translation) — should appear within ~5s
- `    UPGRADE EN: "..."` lines (phase 2 batch upgrade) — should appear ~5-10s after the `IT` line
- `    UPGRADE IT: "..."` lines showing corrected Italian text with proper player names
- Entity corrections: phase 2 should have more accurate player name entities than phase 1
- No crashes or unhandled promise rejections
- **CRITICAL**: `Upgrades received` in summary must be >0. If zero upgrades appear, the
  batch pipeline is not working — do not proceed. Debug by checking server logs for
  Mistral batch API errors.

- [ ] **Step 4: Compare phase 1 vs phase 2 entity accuracy**

Manually review the output for lines where player names changed between phase 1 and phase 2. Look for corrections like:
- "Turam" → "Thuram"
- "Lauraro" → "Lautaro"
- "Calianoglu" → "Calhanoglu"

- [ ] **Step 5: End session and verify persisted data**

```bash
# Find and end the active session
curl -s http://localhost:3000/api/sessions | jq -r '.sessions[] | select(.endedAt == null) | .id' | xargs -I{} curl -X POST http://localhost:3000/api/sessions/{}/end
```

Check the session JSON file in `sessions/` to verify:
- Lines have both phase 1 text and phase 2 corrected text
- Translations, segments, entities, idioms are present
- Cost tracking includes both phases

- [ ] **Step 6: Commit any fixes needed**

If any issues were found during integration testing, fix them and commit:

```bash
git add -A
git commit -m "fix: integration test fixes for two-phase transcription"
```
