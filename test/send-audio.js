#!/usr/bin/env node

// Sends an audio file to the Capito server via WebSocket,
// mimicking what the browser AudioWorklet does.
//
// Usage: node test/send-audio.js <audio-file> [--server ws://localhost:3000]
//
// Accepts any format ffmpeg can read (mp3, wav, m4a, etc).
// Converts to PCM16 16kHz mono and streams in 256ms chunks.

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const audioFile = process.argv[2];
const serverUrl = process.argv[3] || 'ws://localhost:3000';

if (!audioFile) {
  console.error('Usage: node test/send-audio.js <audio-file> [ws://localhost:3000]');
  process.exit(1);
}

const CHUNK_SIZE = 4096 * 2; // 4096 samples * 2 bytes per sample = 8192 bytes
const CHUNK_INTERVAL_MS = 256; // 256ms per chunk at 16kHz

console.log(`[test] Audio file: ${resolve(audioFile)}`);
console.log(`[test] Server: ${serverUrl}`);
console.log(`[test] Converting to PCM16 16kHz mono...`);

// Convert audio to raw PCM16 16kHz mono using ffmpeg
const ffmpeg = spawn('ffmpeg', [
  '-i', resolve(audioFile),
  '-f', 's16le',
  '-ar', '16000',
  '-ac', '1',
  '-acodec', 'pcm_s16le',
  'pipe:1',
]);

const pcmChunks = [];
ffmpeg.stdout.on('data', (chunk) => pcmChunks.push(chunk));
ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg progress output

ffmpeg.on('close', (code) => {
  if (code !== 0) {
    console.error(`[test] ffmpeg failed with code ${code}`);
    process.exit(1);
  }

  const pcmData = Buffer.concat(pcmChunks);
  const totalChunks = Math.ceil(pcmData.length / CHUNK_SIZE);
  const durationSecs = pcmData.length / (16000 * 2);
  console.log(`[test] PCM data: ${pcmData.length} bytes, ${durationSecs.toFixed(1)}s, ${totalChunks} chunks`);
  console.log(`[test] Connecting to ${serverUrl}...`);

  const ws = new WebSocket(serverUrl);
  let chunkIndex = 0;
  let eventCount = 0;

  ws.on('open', () => {
    console.log(`[test] Connected. Streaming audio...`);
    console.log('');

    const interval = setInterval(() => {
      if (chunkIndex >= totalChunks) {
        clearInterval(interval);
        console.log('');
        console.log(`[test] All ${totalChunks} chunks sent. Waiting for remaining events...`);
        // Wait a bit for final events, then close
        setTimeout(() => {
          console.log(`[test] Done. Received ${eventCount} events.`);
          ws.close(1000);
          process.exit(0);
        }, 5000);
        return;
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, pcmData.length);
      const chunk = pcmData.subarray(start, end);
      ws.send(chunk);
      chunkIndex++;

      // Progress every 20 chunks (~5 seconds)
      if (chunkIndex % 20 === 0) {
        const elapsed = (chunkIndex * CHUNK_INTERVAL_MS / 1000).toFixed(1);
        process.stdout.write(`\r[test] Sent ${chunkIndex}/${totalChunks} chunks (${elapsed}s)`);
      }
    }, CHUNK_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      eventCount++;

      switch (event.type) {
        case 'session.active':
          console.log(`[event] Session: ${event.session.name} (${event.session.lines.length} lines)`);
          break;
        case 'transcription.text.delta':
          process.stdout.write(event.text);
          break;
        case 'transcription.done':
          console.log(`\n[done] lineId=${event.lineId}: "${event.text}"`);
          break;
        case 'analysis':
          console.log(`[analysis] lineId=${event.lineId}:`);
          if (event.translation) console.log(`  EN: ${event.translation}`);
          if (event.entities?.length) console.log(`  Entities: ${event.entities.map(e => `${e.text}(${e.type})`).join(', ')}`);
          if (event.idioms?.length) console.log(`  Idioms: ${event.idioms.map(i => `"${i.expression}"`).join(', ')}`);
          break;
        case 'transcription.language':
          console.log(`[event] Language detected: ${event.audioLanguage}`);
          break;
        case 'error':
          console.error(`[error] ${event.message || JSON.stringify(event.error)}`);
          break;
        default:
          console.log(`[event] ${event.type}`);
      }
    } catch (err) {
      console.error('[test] Failed to parse event:', err.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[test] WebSocket closed (code ${code})`);
  });

  ws.on('error', (err) => {
    console.error(`[test] WebSocket error: ${err.message}`);
    process.exit(1);
  });
});
