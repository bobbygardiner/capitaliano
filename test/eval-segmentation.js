#!/usr/bin/env node

// Replays captured Mistral deltas through different segmentation strategies
// and compares the results.
//
// Usage: node test/eval-segmentation.js <deltas-file.json> [--audio <session-id>]
//
// If --audio is provided, extracts WAV clips for each strategy to /tmp/eval-clips/

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const deltasFile = process.argv[2];
const audioSessionIdx = process.argv.indexOf('--audio');
const audioSessionId = audioSessionIdx !== -1 ? process.argv[audioSessionIdx + 1] : null;

if (!deltasFile) {
  console.error('Usage: node test/eval-segmentation.js <deltas-file.json> [--audio <session-id>]');
  process.exit(1);
}

const { deltas, totalPcmBytes } = JSON.parse(await readFile(resolve(deltasFile), 'utf-8'));
const totalDurationSec = totalPcmBytes / 32000;

console.log(`Loaded ${deltas.length} deltas, ${totalDurationSec.toFixed(1)}s audio\n`);

// --- Segmentation strategies ---

const SENTENCE_END = /[.!?]\s*$/;

function strategyCurrentPunct40(deltas) {
  // Current strategy: split on punctuation when buffer >= 40 chars
  const segments = [];
  let buffer = '';
  let firstDeltaIdx = 0;

  for (let i = 0; i < deltas.length; i++) {
    if (!buffer) firstDeltaIdx = i;
    buffer += deltas[i].text;

    if ((buffer.length >= 40 && SENTENCE_END.test(buffer)) || buffer.length >= 500) {
      segments.push({
        text: buffer.trim(),
        audioStart: deltas[firstDeltaIdx].audioSec,
        audioEnd: deltas[i].audioSec,
        charLen: buffer.trim().length,
      });
      buffer = '';
    }
  }
  if (buffer.trim()) {
    segments.push({
      text: buffer.trim(),
      audioStart: deltas[firstDeltaIdx].audioSec,
      audioEnd: deltas[deltas.length - 1].audioSec,
      charLen: buffer.trim().length,
    });
  }
  return segments;
}

function strategyPunct100(deltas) {
  // Higher minimum: split on punctuation when buffer >= 100 chars
  const segments = [];
  let buffer = '';
  let firstDeltaIdx = 0;

  for (let i = 0; i < deltas.length; i++) {
    if (!buffer) firstDeltaIdx = i;
    buffer += deltas[i].text;

    if ((buffer.length >= 100 && SENTENCE_END.test(buffer)) || buffer.length >= 500) {
      segments.push({
        text: buffer.trim(),
        audioStart: deltas[firstDeltaIdx].audioSec,
        audioEnd: deltas[i].audioSec,
        charLen: buffer.trim().length,
      });
      buffer = '';
    }
  }
  if (buffer.trim()) {
    segments.push({
      text: buffer.trim(),
      audioStart: deltas[firstDeltaIdx].audioSec,
      audioEnd: deltas[deltas.length - 1].audioSec,
      charLen: buffer.trim().length,
    });
  }
  return segments;
}

function strategyTimeGap(deltas, gapMs = 800) {
  // Split when there's a gap in delta arrival time (speech pause)
  // Plus punctuation as a secondary signal
  const segments = [];
  let buffer = '';
  let firstDeltaIdx = 0;

  for (let i = 0; i < deltas.length; i++) {
    if (!buffer) firstDeltaIdx = i;
    buffer += deltas[i].text;

    // Check for time gap between this delta and the next
    const nextDelta = deltas[i + 1];
    const gap = nextDelta ? nextDelta.wallMs - deltas[i].wallMs : Infinity;

    // Split if: gap detected AND buffer has some content AND ends with punctuation
    const hasGap = gap > gapMs;
    const hasPunct = SENTENCE_END.test(buffer);
    const hasMinLength = buffer.length >= 30;

    if ((hasGap && hasMinLength) || buffer.length >= 500) {
      segments.push({
        text: buffer.trim(),
        audioStart: deltas[firstDeltaIdx].audioSec,
        audioEnd: deltas[i].audioSec,
        charLen: buffer.trim().length,
      });
      buffer = '';
    }
  }
  if (buffer.trim()) {
    segments.push({
      text: buffer.trim(),
      audioStart: deltas[firstDeltaIdx].audioSec,
      audioEnd: deltas[deltas.length - 1].audioSec,
      charLen: buffer.trim().length,
    });
  }
  return segments;
}

function strategyTimeGapPunct(deltas, gapMs = 600) {
  // Split on time gap OR on punctuation with higher minimum (hybrid)
  const segments = [];
  let buffer = '';
  let firstDeltaIdx = 0;

  for (let i = 0; i < deltas.length; i++) {
    if (!buffer) firstDeltaIdx = i;
    buffer += deltas[i].text;

    const nextDelta = deltas[i + 1];
    const gap = nextDelta ? nextDelta.wallMs - deltas[i].wallMs : Infinity;
    const hasGap = gap > gapMs;
    const hasPunct = SENTENCE_END.test(buffer);

    // Split if: (gap + any content) OR (punct + 80+ chars) OR maxlen
    if ((hasGap && buffer.length >= 30) || (hasPunct && buffer.length >= 80) || buffer.length >= 500) {
      segments.push({
        text: buffer.trim(),
        audioStart: deltas[firstDeltaIdx].audioSec,
        audioEnd: deltas[i].audioSec,
        charLen: buffer.trim().length,
      });
      buffer = '';
    }
  }
  if (buffer.trim()) {
    segments.push({
      text: buffer.trim(),
      audioStart: deltas[firstDeltaIdx].audioSec,
      audioEnd: deltas[deltas.length - 1].audioSec,
      charLen: buffer.trim().length,
    });
  }
  return segments;
}

// --- Run all strategies ---

const strategies = {
  'A: current (punct≥40)': strategyCurrentPunct40,
  'B: punct≥100': strategyPunct100,
  'C: time-gap (800ms)': (d) => strategyTimeGap(d, 800),
  'D: hybrid (gap600+punct80)': (d) => strategyTimeGapPunct(d, 600),
};

const results = {};

for (const [name, fn] of Object.entries(strategies)) {
  const segments = fn(deltas);
  results[name] = segments;

  const durations = segments.map(s => s.audioEnd - s.audioStart);
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  const minDur = Math.min(...durations);
  const maxDur = Math.max(...durations);
  const charLens = segments.map(s => s.charLen);
  const avgChars = charLens.reduce((a, b) => a + b, 0) / charLens.length;

  console.log(`\n=== ${name} ===`);
  console.log(`  Segments: ${segments.length}`);
  console.log(`  Duration: avg=${avgDur.toFixed(1)}s, min=${minDur.toFixed(1)}s, max=${maxDur.toFixed(1)}s`);
  console.log(`  Chars: avg=${avgChars.toFixed(0)}, min=${Math.min(...charLens)}, max=${Math.max(...charLens)}`);
  console.log(`  ---`);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = (s.audioEnd - s.audioStart).toFixed(1);
    console.log(`  [${i}] ${s.audioStart.toFixed(1)}→${s.audioEnd.toFixed(1)}s (${dur}s) "${s.text.slice(0, 70)}${s.text.length > 70 ? '...' : ''}"`);
  }
}

// --- Extract audio clips if requested ---

if (audioSessionId) {
  const clipDir = '/tmp/eval-clips';
  await mkdir(clipDir, { recursive: true });

  for (const [name, segments] of Object.entries(results)) {
    const stratKey = name.split(':')[0].trim().toLowerCase();
    const stratDir = `${clipDir}/${stratKey}`;
    await mkdir(stratDir, { recursive: true });

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const url = `http://localhost:3000/api/sessions/${audioSessionId}/audio?from=${s.audioStart}&to=${s.audioEnd}`;
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(`${stratDir}/seg${String(i).padStart(2, '0')}.wav`, buf);
      }
    }
    console.log(`\n[${name}] Clips written to ${stratDir}/`);
  }
}
