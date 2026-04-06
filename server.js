import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import {
  RealtimeTranscription,
  AudioEncoding,
} from '@mistralai/mistralai/extra/realtime';
import * as sessions from './lib/sessions.js';
import { analyzeCommentary } from './lib/translate.js';

config();

if (!process.env.MISTRAL_API_KEY) {
  console.error('[capito] MISTRAL_API_KEY is not set. Copy .env.example to .env and add your key.');
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
        const session = await sessions.create(body.name);
        return sendJson(res, 201, session);
      }

      const getMatch = urlPath.match(RE_SESSION_ID);
      if (getMatch && req.method === 'GET') {
        const session = await sessions.get(getMatch[1]);
        return sendJson(res, 200, session);
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

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[capito] API error:', err.message);
      const status = err.message.includes('already active') ? 409 : 500;
      sendJson(res, status, { error: err.message });
    }
    return;
  }

  // Static files
  const filePath = resolve(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
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

wss.on('connection', async (ws) => {
  console.log('[capito] Browser connected');

  // Send active session info if one exists
  const active = sessions.getActive();
  if (active) {
    ws.send(JSON.stringify({ type: 'session.active', session: active }));
  }

  const client = new RealtimeTranscription({
    apiKey: process.env.MISTRAL_API_KEY,
  });

  let connection;
  let mistralReady = false;

  // Forward browser audio → Mistral (only after Mistral connection is ready)
  ws.on('message', (data, isBinary) => {
    if (isBinary && mistralReady && connection && !connection.isClosed) {
      connection.sendAudio(data);
    }
  });

  try {
    connection = await client.connect(
      'voxtral-mini-transcribe-realtime-2602',
      {
        audioFormat: {
          encoding: AudioEncoding.PcmS16le,
          sampleRate: 16000,
        },
        targetStreamingDelayMs: 480,
      }
    );
    mistralReady = true;
    console.log('[capito] Mistral connected');
  } catch (err) {
    console.error('[capito] Mistral connection failed:', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect to Mistral' }));
    }
    ws.close();
    return;
  }

  // Sentence accumulator — Mistral doesn't send transcription.done at utterance
  // boundaries, only at stream end. We detect sentence breaks ourselves.
  let sentenceBuffer = '';
  const SENTENCE_END = /[.!?]\s*$/;

  function finalizeSentence(raw) {
    const text = raw.trim();
    if (!text) return;
    const lineId = sessions.addLine(text);
    ws.send(JSON.stringify({ type: 'transcription.done', lineId, text }));

    // Fire-and-forget translation
    if (lineId !== null) {
      analyzeCommentary(text).then(analysis => {
        if (analysis && ws.readyState === ws.OPEN) {
          sessions.updateLine(lineId, analysis);
          ws.send(JSON.stringify({
            type: 'analysis', lineId, text,
            translation: analysis.translation,
            segments: analysis.segments,
            entities: analysis.entities,
            idioms: analysis.idioms,
          }));
        }
      });
    }
  }

  // Forward Mistral events → browser (with sentence segmentation)
  (async () => {
    try {
      for await (const event of connection) {
        if (ws.readyState !== ws.OPEN) break;

        if (event.type === 'transcription.text.delta') {
          ws.send(JSON.stringify(event));
          sentenceBuffer += event.text;
          if (SENTENCE_END.test(sentenceBuffer)) {
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        } else if (event.type === 'transcription.done') {
          if (sentenceBuffer.trim()) {
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        } else {
          ws.send(JSON.stringify(event));
        }
      }
    } catch (err) {
      console.error('[capito] Mistral stream error:', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: String(err.message || err) }));
      }
    }
  })();

  // Cleanup on browser disconnect
  ws.on('close', async () => {
    console.log('[capito] Browser disconnected');
    mistralReady = false;
    sentenceBuffer = '';
    if (connection && !connection.isClosed) {
      try {
        await connection.endAudio();
        await connection.close();
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

// --- Initialize and start ---

await sessions.init();

server.listen(PORT, () => {
  console.log(`[capito] Running at http://localhost:${PORT}`);
});

// Graceful shutdown
async function gracefulShutdown() {
  await sessions.shutdown();
  process.exit(0);
}

process.on('SIGINT', async () => { console.log('\n[capito] Shutting down...'); await gracefulShutdown(); });
process.on('SIGTERM', gracefulShutdown);
