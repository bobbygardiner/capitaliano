#!/usr/bin/env node

// Sends an audio file to the Capito server via WebSocket,
// mimicking what the browser AudioWorklet does.
// Creates a session first so the full pipeline fires (translation, entities, idioms).
//
// Usage: node test/send-audio.js <audio-file> [--server ws://localhost:3000]
//
// Accepts any format ffmpeg can read (mp3, wav, m4a, etc).
// Converts to PCM16 16kHz mono and streams in 256ms chunks.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const audioFile = process.argv[2];
// Skip --flags when looking for serverBase positional arg
const serverArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const serverBase = serverArg || 'http://localhost:3000';
const wsUrl = serverBase.replace(/^http/, 'ws');

if (!audioFile) {
  console.error('Usage: node test/send-audio.js <audio-file> [http://localhost:3000]');
  process.exit(1);
}

// Parse --context flag
let contextText = null;
const contextIdx = process.argv.indexOf('--context');
if (contextIdx !== -1 && process.argv[contextIdx + 1]) {
  contextText = await readFile(resolve(process.argv[contextIdx + 1]), 'utf-8');
  console.log(`[test] Context loaded: ${contextText.split('\n').length} lines`);
}

const CHUNK_SIZE = 4096 * 2; // 4096 samples * 2 bytes per sample = 8192 bytes
const CHUNK_INTERVAL_MS = 256; // 256ms per chunk at 16kHz

// --- Create a session first ---

async function createSession() {
  const res = await fetch(`${serverBase}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Test: ${audioFile.split('/').pop()}`,
      ...(contextText && { context: contextText }),
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    // If session already active, that's fine
    if (res.status === 409) {
      console.log(`[test] Session already active, reusing it`);
      return;
    }
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const session = await res.json();
  console.log(`[test] Session created: ${session.name} (${session.id})`);
}

async function endSession() {
  const listRes = await fetch(`${serverBase}/api/sessions`);
  const { sessions } = await listRes.json();
  const active = sessions.find(s => !s.endedAt);
  if (active) {
    await fetch(`${serverBase}/api/sessions/${active.id}/end`, { method: 'POST' });
    console.log(`[test] Session ended: ${active.id} (${active.lineCount} lines)`);
  }
}

// --- Main ---

console.log(`[test] Audio file: ${resolve(audioFile)}`);
console.log(`[test] Server: ${serverBase}`);

await createSession();

console.log(`[test] Converting to PCM16 16kHz mono...`);

const ffmpeg = spawn('ffmpeg', [
  '-i', resolve(audioFile),
  '-f', 's16le', '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
  'pipe:1',
]);

const pcmChunks = [];
ffmpeg.stdout.on('data', (chunk) => pcmChunks.push(chunk));
ffmpeg.stderr.on('data', () => {});

ffmpeg.on('close', (code) => {
  if (code !== 0) {
    console.error(`[test] ffmpeg failed with code ${code}`);
    process.exit(1);
  }

  const pcmData = Buffer.concat(pcmChunks);
  const totalChunks = Math.ceil(pcmData.length / CHUNK_SIZE);
  const durationSecs = pcmData.length / (16000 * 2);
  console.log(`[test] PCM data: ${pcmData.length} bytes, ${durationSecs.toFixed(1)}s, ${totalChunks} chunks`);

  const ws = new WebSocket(wsUrl);
  let chunkIndex = 0;
  let eventCount = 0;
  let doneCount = 0;
  let analysisCount = 0;
  const pendingTranslations = new Map(); // lineId -> timestamp when done was received
  const doneTimestamps = new Map(); // lineId -> timestamp, never cleared
  let upgradeCount = 0;

  ws.on('open', () => {
    console.log(`[test] Connected. Streaming audio...\n`);

    const interval = setInterval(() => {
      if (chunkIndex >= totalChunks) {
        clearInterval(interval);
        console.log(`\n\n[test] All ${totalChunks} chunks sent. Waiting for translations...`);
        // Wait longer for claude -p translations to complete
        const waitTime = Math.max(30000, doneCount * 15000);
        console.log(`[test] Waiting up to ${(waitTime/1000).toFixed(0)}s for ${doneCount - analysisCount} pending translations...`);
        setTimeout(() => {
          console.log(`\n--- SUMMARY ---`);
          console.log(`Events: ${eventCount} total`);
          console.log(`Lines finalized: ${doneCount}`);
          console.log(`Translations received: ${analysisCount}`);
          console.log(`Upgrades received: ${upgradeCount}`);
          console.log(`Translations pending: ${doneCount - analysisCount}`);
          if (pendingTranslations.size) {
            console.log(`Still waiting for lineIds: ${[...pendingTranslations.keys()].join(', ')}`);
          }
          // Don't end session — let the user manage lifecycle
          ws.close(1000);
          process.exit(0);
        }, waitTime);
        return;
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, pcmData.length);
      ws.send(pcmData.subarray(start, end));
      chunkIndex++;

      if (chunkIndex % 20 === 0) {
        const elapsed = (chunkIndex * CHUNK_INTERVAL_MS / 1000).toFixed(1);
        process.stdout.write(`\r[test] Sent ${chunkIndex}/${totalChunks} chunks (${elapsed}s) | lines: ${doneCount} | translations: ${analysisCount}`);
      }
    }, CHUNK_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      eventCount++;

      switch (event.type) {
        case 'session.active':
          console.log(`[session] ${event.session.name} (${event.session.lines.length} existing lines)`);
          break;

        case 'transcription.text.delta':
          // silent during streaming — too noisy
          break;

        case 'transcription.done':
          doneCount++;
          pendingTranslations.set(event.lineId, Date.now());
          doneTimestamps.set(event.lineId, Date.now());
          console.log(`\n[${doneCount}] IT: "${event.text}"`);
          break;

        case 'analysis': {
          analysisCount++;
          const sentAt = pendingTranslations.get(event.lineId);
          const latency = sentAt ? ((Date.now() - sentAt) / 1000).toFixed(1) : '?';
          pendingTranslations.delete(event.lineId);
          console.log(`    EN: "${event.translation}" [${latency}s]`);
          if (event.segments?.length) console.log(`    Segments: ${event.segments.length}`);
          if (event.entities?.length) console.log(`    Entities: ${event.entities.map(e => `${e.text}(${e.type})`).join(', ')}`);
          if (event.idioms?.length) console.log(`    Idioms: ${event.idioms.map(i => `"${i.expression}"`).join(', ')}`);
          break;
        }

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

        case 'error':
          console.error(`\n[error] ${event.message || JSON.stringify(event.error)}`);
          break;
      }
    } catch (err) {
      console.error('[test] Parse error:', err.message);
    }
  });

  ws.on('close', (code) => console.log(`[test] WebSocket closed (code ${code})`));
  ws.on('error', (err) => { console.error(`[test] WebSocket error: ${err.message}`); process.exit(1); });
});
