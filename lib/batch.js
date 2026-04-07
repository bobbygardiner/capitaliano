// lib/batch.js
import { Mistral } from '@mistralai/mistralai';
import { pcmToWav } from './audio.js';

const COALESCE_THRESHOLD = 320000; // 10s at 16kHz 16-bit mono
const MAX_AUDIO_BYTES = 1048576;  // 1MB ~30s

export function createBatchPipeline(options) {
  const { contextBias, onUpgrade, transcribeFn, mergeFn, splitAnalyzeFn, getBiasTokens } = options;

  let chunks = [];
  let totalBytes = 0;
  let lastMarkOffset = 0;
  let pending = null; // { audioChunks, lineIds, originalTexts, bytes }
  const inflight = new Set();

  function pushChunk(chunk) {
    chunks.push(chunk);
    totalBytes += chunk.length;
    if (totalBytes - lastMarkOffset > MAX_AUDIO_BYTES) {
      console.warn('[capito] Audio buffer exceeded 1MB without markSentence, discarding');
      chunks = [];
      totalBytes = 0;
      lastMarkOffset = 0;
      pending = null;
    }
  }

  function extractAudioSinceMark() {
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
      if (pending) {
        pending.audioChunks.push(audioBuffer);
        pending.lineIds.push(lineId);
        pending.originalTexts.push(originalText || '');
        pending.bytes += bytes;
        const merged = pending;
        pending = null;
        submitBatch(Buffer.concat(merged.audioChunks), merged.lineIds, merged.originalTexts);
      } else {
        pending = {
          audioChunks: [audioBuffer],
          lineIds: [lineId],
          originalTexts: [originalText || ''],
          bytes,
        };
      }
    } else {
      if (pending) {
        pending.audioChunks.push(audioBuffer);
        pending.lineIds.push(lineId);
        pending.originalTexts.push(originalText || '');
        pending.bytes += bytes;
        const merged = pending;
        pending = null;
        submitBatch(Buffer.concat(merged.audioChunks), merged.lineIds, merged.originalTexts);
      } else {
        submitBatch(audioBuffer, [lineId], [originalText || '']);
      }
    }
  }

  async function submitBatch(audioBuffer, lineIds, originalTexts) {
    const wavBuffer = pcmToWav(audioBuffer, 16000);
    const promise = (async () => {
      try {
        const batchResult = await transcribeFn(wavBuffer, contextBias);
        if (!batchResult || !batchResult.text) return;

        if (lineIds.length === 1) {
          // Merge realtime + batch via Haiku for best-of-both result
          const analysis = await mergeFn(originalTexts[0], batchResult.text, null);
          if (analysis) {
            onUpgrade(lineIds[0], analysis);
          }
        } else {
          if (splitAnalyzeFn) {
            const results = await splitAnalyzeFn(batchResult.text, originalTexts, null);
            if (results && results.length === lineIds.length) {
              const costEach = results.reduce((s, r) => s + (r.costUsd || 0), 0) / lineIds.length;
              for (let i = 0; i < lineIds.length; i++) {
                results[i].costUsd = costEach;
                onUpgrade(lineIds[i], results[i]);
              }
            } else {
              console.warn('[capito] splitAndAnalyze returned wrong count, falling back');
              const analysis = await mergeFn(originalTexts[0], batchResult.text, null);
              if (analysis) {
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
    if (pending) {
      submitBatch(Buffer.concat(pending.audioChunks), pending.lineIds, pending.originalTexts);
      pending = null;
    }
    if (inflight.size > 0) {
      const timeout = new Promise(resolve => setTimeout(resolve, 10000));
      await Promise.race([Promise.allSettled([...inflight]), timeout]);
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

/**
 * Parse a free-text match context into a context_bias string array.
 * Extracts proper nouns (multi-word names starting with uppercase).
 */
export function parseContextBias(context) {
  if (!context || !context.trim()) return [];

  const names = new Set();
  const lines = context.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;

    const teamCoachMatch = trimmed.match(/^(.+?)\s*\(Coach:\s*(.+?)\)/);
    if (teamCoachMatch) {
      names.add(teamCoachMatch[1].trim());
      names.add(teamCoachMatch[2].trim());
      continue;
    }

    const vsMatch = trimmed.match(/^(.+?)\s+vs\s+(.+?)\s*[—–-]/);
    if (vsMatch) {
      names.add(vsMatch[1].trim());
      names.add(vsMatch[2].trim());
      continue;
    }

    const afterLabel = trimmed.replace(/^(Starters|Substitutes)\s*:\s*/, '');
    if (afterLabel === trimmed && !trimmed.includes(',') && !trimmed.includes(';')) continue;

    const parts = afterLabel.split(/[,;]+/);
    for (const part of parts) {
      const name = part.trim();
      if (name.length >= 2 && /^[A-ZÀ-Ž]/.test(name)) {
        const words = name.split(/\s+/).filter(w => w.length >= 2);
        if (words.length >= 1 && words.every(w => /^[A-ZÀ-Ž]/.test(w))) {
          names.add(words.join(' '));
        }
      }
    }
  }

  // Mistral context_bias requires single tokens (no spaces: pattern ^[^,\s]+$).
  // Split multi-word names into individual words.
  const tokens = new Set();
  for (const name of names) {
    for (const word of name.split(/\s+/)) {
      if (word.length >= 2) tokens.add(word);
    }
  }
  return [...tokens].slice(0, 100);
}

/**
 * Call the Mistral batch transcription API.
 * Uses the official SDK: mistral.audio.transcriptions.complete()
 * The SDK serialises contextBias as the `context_bias` multipart field array.
 * @param {Buffer} wavBuffer - Complete WAV file buffer
 * @param {string[]} contextBias - Names for context_bias
 * @returns {Promise<{text: string}>} Transcription result
 */
export async function transcribeBatch(wavBuffer, contextBias) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

  const mistral = new Mistral({ apiKey });

  const result = await mistral.audio.transcriptions.complete({
    model: 'voxtral-mini-latest',
    file: new Blob([wavBuffer], { type: 'audio/wav' }),
    language: 'it',
    ...(contextBias.length > 0 ? { contextBias } : {}),
  });

  return { text: result.text || '' };
}
