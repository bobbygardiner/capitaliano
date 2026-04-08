import { createServer } from 'node:http';
import { readFile, stat, open } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pcmToWav } from './lib/audio.js';
import { extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import {
  RealtimeTranscription,
  AudioEncoding,
} from '@mistralai/mistralai/extra/realtime';
import * as sessions from './lib/sessions.js';
import { createBatchPipeline, parseContextBias, transcribeBatch } from './lib/batch.js';
import { analyzeCommentary, splitAndAnalyze, mergeAndAnalyze } from './lib/translate.js';
import { searchContext, buildContextString } from './lib/context-search.js';

config();

if (!process.env.MISTRAL_API_KEY) {
  console.error('[capitaliano] MISTRAL_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const PUBLIC_DIR = resolve('public');
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};
const PORT = 3000;

// Route patterns (hoisted to avoid per-request regex compilation)
const RE_SESSION_ID = /^\/api\/sessions\/(sess_\d+)$/;
const RE_SESSION_END = /^\/api\/sessions\/(sess_\d+)\/end$/;
const RE_SESSION_AUDIO = /^\/api\/sessions\/(sess_\d+)\/audio$/;

// cleanText regexes (hoisted to avoid per-call compilation)
const RE_MISSING_SPACE_CAMEL = /([a-zà-ž])([A-ZÀ-Ž])/g;
const RE_MISSING_SPACE_PUNCT = /([.!?,;:])([A-ZÀ-Ža-zà-ž])/g;
const RE_REPEATED_WORD = /\b(\w+)\s+\1\b/gi;
const RE_REPEATED_PAIR = /\b(\w+\s+\w+)\s+\1\b/gi;
const RE_STUTTERED = /\b(\w{2,4})\s+\1\w+\b/gi;

// --- REST API helpers ---

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new Error('Invalid JSON body');
  }
}

// --- HTTP server: static files + REST API ---

const server = createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // REST API routes
  if (urlPath.startsWith('/api/')) {
    try {
      if (urlPath === '/api/sessions' && req.method === 'GET') {
        return sendJson(res, 200, { sessions: sessions.list() });
      }

      if (urlPath === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const session = await sessions.create(body.name, body.context);
        return sendJson(res, 201, session);
      }

      if (urlPath === '/api/context-search' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.query) return sendJson(res, 400, { error: 'query is required' });
        try {
          const { data, costUsd } = await searchContext(body.query);
          const contextString = buildContextString(data);
          return sendJson(res, 200, { context: contextString, structured: data, costUsd });
        } catch (err) {
          console.error('[capitaliano] Context search failed:', err.message);
          return sendJson(res, 502, { error: 'Context search failed: ' + err.message });
        }
      }

      const audioMatch = urlPath.match(RE_SESSION_AUDIO);
      if (audioMatch && req.method === 'GET') {
        const id = audioMatch[1];
        const pcmPath = resolve('sessions', `${id}.pcm`);

        let fileSize;
        try {
          const s = await stat(pcmPath);
          fileSize = s.size;
        } catch {
          return sendJson(res, 404, { error: 'No audio for this session' });
        }

        const params = new URL(req.url, 'http://localhost').searchParams;
        const fromSec = parseFloat(params.get('from')) || 0;
        const toSec = params.get('to') !== null ? parseFloat(params.get('to')) : null;

        let startByte = Math.floor(fromSec * 16000) * 2;
        let endByte = toSec !== null
          ? Math.floor(toSec * 16000) * 2
          : fileSize;

        // Clamp
        startByte = Math.max(0, Math.min(startByte, fileSize));
        endByte = Math.max(startByte, Math.min(endByte, fileSize));

        const length = endByte - startByte;
        const fd = await open(pcmPath, 'r');
        const pcmData = Buffer.alloc(length);
        await fd.read(pcmData, 0, length, startByte);
        await fd.close();

        const wav = pcmToWav(pcmData, 16000);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wav.length,
        });
        res.end(wav);
        return;
      }

      const endMatch = urlPath.match(RE_SESSION_END);
      if (endMatch && req.method === 'POST') {
        const active = sessions.getActive();
        if (!active || active.id !== endMatch[1]) {
          return sendJson(res, 409, { error: 'Session is not the active session' });
        }
        const result = await sessions.end();
        return sendJson(res, 200, result);
      }

      const idMatch = urlPath.match(RE_SESSION_ID);
      if (idMatch) {
        const id = idMatch[1];
        if (req.method === 'GET') {
          const session = await sessions.get(id);
          return sendJson(res, 200, session);
        } else if (req.method === 'DELETE') {
          await sessions.remove(id);
          return sendJson(res, 200, { deleted: true });
        } else if (req.method === 'PATCH') {
          const body = await readBody(req);
          const updated = await sessions.update(id, body);
          return sendJson(res, 200, updated);
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[capitaliano] API error:', err.message);
      const status = err.message.includes('already active') ? 409 : 500;
      sendJson(res, status, { error: err.message });
    }
    return;
  }

  // Static files
  const safePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = resolve(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ct = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket: audio proxy + event interception ---

const wss = new WebSocketServer({ server });

// Broadcast an event to all connected WebSocket clients
function broadcast(data) {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try { client.send(msg); } catch {}
    }
  }
}

// Prevent EPIPE / unhandled rejection crashes
process.on('unhandledRejection', (err) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
    console.error('[capitaliano] Suppressed write error:', err.code);
    return;
  }
  console.error('[capitaliano] Unhandled rejection:', err);
});

wss.on('connection', async (ws) => {
  console.log('[capitaliano] Client connected');

  // Send active session info if one exists
  const active = sessions.getActive();
  if (active) {
    ws.send(JSON.stringify({ type: 'session.active', session: active }));
  }

  // Mistral connection is lazy — only created when first binary audio arrives
  let connection = null;
  let mistralReady = false;
  let pcmStream = null;
  let pcmBytesWritten = 0;
  let sessionAudioStartTime = null;
  // Delta capture for segmentation evaluation (enabled via CAPITO_CAPTURE_DELTAS=1)
  const captureDeltas = process.env.CAPITO_CAPTURE_DELTAS === '1';
  const capturedDeltas = [];

  // Phase 2 batch transcription — disabled by default.
  // Set CAPITO_PHASE2=1 env var to enable.
  const phase2Enabled = process.env.CAPITO_PHASE2 === '1';

  let cachedBias = null;
  let cachedBiasContext = undefined;
  function getContextBias() {
    const ctx = sessions.getActive()?.context;
    if (ctx !== cachedBiasContext) {
      cachedBiasContext = ctx;
      cachedBias = parseContextBias(ctx);
    }
    return cachedBias;
  }

  const pipeline = phase2Enabled ? createBatchPipeline({
    contextBias: [], // not used directly — transcribeFn reads live bias
    onUpgrade: (lineId, result) => {
      const active = sessions.getActive();
      const line = active?.lines?.[lineId];
      const phase1 = (line && !line.phase1Text)
        ? { phase1Text: line.text, phase1Translation: line.translation }
        : {};
      sessions.updateLine(lineId, { ...phase1, ...result });
      broadcast({ type: 'analysis.upgrade', lineId, ...result });
    },
    transcribeFn: (wavBuffer) => transcribeBatch(wavBuffer, getContextBias()),
    mergeFn: (realtimeText, batchText, _ctx) =>
      mergeAndAnalyze(realtimeText, batchText, sessions.getActive()?.context),
    splitAnalyzeFn: (batchText, originals, _ctx) =>
      splitAndAnalyze(batchText, originals, sessions.getActive()?.context),
  }) : null;

  // Sentence accumulator
  let sentenceBuffer = '';
  const MIN_SENTENCE_LENGTH = 100;
  const SENTENCE_END = /[.!?]\s*$/;

  // Clean up Mistral transcription artifacts
  function cleanText(text) {
    return text
      // Fix missing spaces: "quandoGiroud" → "quando Giroud" (lowercase followed by uppercase)
      .replace(RE_MISSING_SPACE_CAMEL, '$1 $2')
      // Fix missing space after punctuation: "mostrando.Christian" → "mostrando. Christian"
      .replace(RE_MISSING_SPACE_PUNCT, '$1 $2')
      // Remove repeated words: "che che" → "che", "Juan Juan" → "Juan"
      .replace(RE_REPEATED_WORD, '$1')
      // Remove repeated word pairs: "con con un un" → "con un"
      .replace(RE_REPEATED_PAIR, '$1')
      // Remove stuttered beginnings: "bra bravovo" → "bravovo"
      .replace(RE_STUTTERED, (match) => match.split(/\s+/).pop())
      // Clean up double commas/spaces
      .replace(/,,/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function finalizeSentence(raw) {
    const text = cleanText(raw.trim());
    if (!text) return;
    const audioOffsetSec = pcmBytesWritten > 0
      ? pcmBytesWritten / 32000
      : null;
    const lineId = sessions.addLine(text, audioOffsetSec);
    broadcast({ type: 'transcription.done', lineId, text, audioOffsetSec });

    if (lineId !== null) {
      const ctx = sessions.getActive()?.context;
      analyzeCommentary(text, ctx).then(analysis => {
        if (analysis) {
          sessions.updateLine(lineId, analysis);
          broadcast({ type: 'analysis', lineId, text, ...analysis });
        }
      });
      if (pipeline) pipeline.markSentence(lineId, text);
    }
  }

  async function startMistral() {
    const client = new RealtimeTranscription({ apiKey: process.env.MISTRAL_API_KEY });
    try {
      connection = await client.connect('voxtral-mini-transcribe-realtime-2602', {
        audioFormat: { encoding: AudioEncoding.PcmS16le, sampleRate: 16000 },
        targetStreamingDelayMs: 480,
      });
      mistralReady = true;
      mistralConnecting = false;
      console.log('[capitaliano] Mistral connected');

      // Forward Mistral events with sentence segmentation
      for await (const event of connection) {
        if (ws.readyState !== ws.OPEN) { console.log('[capitaliano] WS closed, stopping Mistral event loop'); break; }
        eventCount++;
        lastEventTime = Date.now();
        if (event.type === 'transcription.text.delta') {
          broadcast(event);
          if (captureDeltas) {
            capturedDeltas.push({
              text: event.text,
              pcmBytes: pcmBytesWritten,
              audioSec: pcmBytesWritten / 32000,
              wallMs: Date.now(),
            });
          }
          sentenceBuffer += event.text;
          if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
            sentenceCount++;
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          } else if (sentenceBuffer.length >= 500) {
            sentenceCount++;
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        } else if (event.type === 'transcription.done') {
          console.log('[capitaliano] Mistral stream ended (transcription.done)');
          if (sentenceBuffer.trim()) {
            sentenceCount++;
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        } else {
          console.log('[capitaliano] Mistral event:', event.type);
        }
      }
      console.log('[capitaliano] Mistral event loop ended — total events:', eventCount, 'sentences:', sentenceCount);
    } catch (err) {
      console.error('[capitaliano] Mistral error:', err.message, err.code || '');
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: String(err.message || err) }));
      }
    } finally {
      // Reset state so next audio chunk triggers reconnection
      connection = null;
      mistralReady = false;
      mistralConnecting = false;
      if (ws.readyState === ws.OPEN) {
        console.log('[capitaliano] Mistral disconnected — will reconnect on next audio chunk');
      }
    }
  }

  // Only connect to Mistral when binary audio arrives
  let mistralConnecting = false;
  let audioCount = 0;
  let lastEventTime = null;
  let eventCount = 0;
  let sentenceCount = 0;

  // Periodic status log (every 60 seconds of audio)
  const statusTimer = setInterval(() => {
    if (audioCount > 0) {
      const elapsed = (audioCount * 0.256).toFixed(0);
      const silenceSecs = lastEventTime ? ((Date.now() - lastEventTime) / 1000).toFixed(0) : 'n/a';
      console.log(`[capitaliano] Status: ${elapsed}s audio, ${eventCount} events, ${sentenceCount} sentences, ${silenceSecs}s since last event, mistral: ${mistralReady ? 'ready' : 'connecting'}`);
    }
  }, 60000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    audioCount++;

    // Write audio to PCM file
    const active = sessions.getActive();
    if (active && !pcmStream) {
      const pcmPath = resolve('sessions', `${active.id}.pcm`);
      const flags = existsSync(pcmPath) ? 'a' : 'w';
      pcmStream = createWriteStream(pcmPath, { flags });

      // Restore or set audio start time
      if (active.audioStartedAt) {
        sessionAudioStartTime = new Date(active.audioStartedAt).getTime();
      } else {
        sessionAudioStartTime = Date.now();
        sessions.setAudioStartedAt(new Date(sessionAudioStartTime).toISOString());
      }
      console.log(`[capitaliano] PCM recording started: ${pcmPath} (${flags})`);
    }
    if (pcmStream) {
      const buf = Buffer.from(data);
      pcmStream.write(buf);
      pcmBytesWritten += buf.length;
    }

    if (pipeline) pipeline.pushChunk(data);
    if (!connection && !mistralReady && !mistralConnecting) {
      mistralConnecting = true;
      console.log('[capitaliano] First audio chunk received, connecting to Mistral...');
      startMistral();
    }
    if (mistralReady && connection && !connection.isClosed) {
      try { connection.sendAudio(data); } catch {}
    }
  });

  // Cleanup on disconnect
  ws.on('close', async () => {
    const elapsed = (audioCount * 0.256).toFixed(0);
    console.log(`[capitaliano] Client disconnected after ${elapsed}s audio, ${eventCount} events, ${sentenceCount} sentences`);
    clearInterval(statusTimer);
    if (pcmStream) {
      pcmStream.end();
      pcmStream = null;
      console.log('[capitaliano] PCM recording stopped');
    }
    if (captureDeltas && capturedDeltas.length > 0) {
      const activeSession = sessions.getActive();
      const capturePath = resolve('test/fixtures', `deltas-${activeSession?.id || 'unknown'}.json`);
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(capturePath, JSON.stringify({ deltas: capturedDeltas, totalPcmBytes: pcmBytesWritten }, null, 2));
      console.log(`[capitaliano] Captured ${capturedDeltas.length} deltas to ${capturePath}`);
    }
    sentenceBuffer = '';
    if (pipeline) await pipeline.flush();
    if (connection && !connection.isClosed) {
      try { await connection.endAudio(); await connection.close(); } catch {}
    }
  });
});

// --- Initialize and start ---

await sessions.init();

server.listen(PORT, () => {
  console.log(`[capitaliano] Running at http://localhost:${PORT}`);
});

// Graceful shutdown
async function gracefulShutdown() {
  await sessions.shutdown();
  process.exit(0);
}

process.on('SIGINT', async () => { console.log('\n[capitaliano] Shutting down...'); await gracefulShutdown(); });
process.on('SIGTERM', gracefulShutdown);
