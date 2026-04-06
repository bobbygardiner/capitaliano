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
        const session = await sessions.create(body.name, body.context);
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

      // DELETE /api/sessions/:id
      const delMatch = urlPath.match(RE_SESSION_ID);
      if (delMatch && req.method === 'DELETE') {
        await sessions.remove(delMatch[1]);
        return sendJson(res, 200, { deleted: true });
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
      client.send(msg);
    }
  }
}

wss.on('connection', async (ws) => {
  console.log('[capito] Client connected');

  // Send active session info if one exists
  const active = sessions.getActive();
  if (active) {
    ws.send(JSON.stringify({ type: 'session.active', session: active }));
  }

  // Mistral connection is lazy — only created when first binary audio arrives
  let connection = null;
  let mistralReady = false;

  // Sentence accumulator
  let sentenceBuffer = '';
  const MIN_SENTENCE_LENGTH = 40;
  const SENTENCE_END = /[.!?]\s*$/;

  function finalizeSentence(raw) {
    const text = raw.trim();
    if (!text) return;
    const lineId = sessions.addLine(text);
    broadcast({ type: 'transcription.done', lineId, text });

    if (lineId !== null) {
      const ctx = sessions.getActive()?.context;
      analyzeCommentary(text, ctx).then(analysis => {
        if (analysis) {
          sessions.updateLine(lineId, analysis);
          broadcast({
            type: 'analysis', lineId, text,
            translation: analysis.translation,
            segments: analysis.segments,
            entities: analysis.entities,
            idioms: analysis.idioms,
            costUsd: analysis.costUsd,
          });
        }
      });
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
      console.log('[capito] Mistral connected');

      // Forward Mistral events with sentence segmentation
      for await (const event of connection) {
        if (ws.readyState !== ws.OPEN) break;
        if (event.type === 'transcription.text.delta') {
          broadcast(event);
          sentenceBuffer += event.text;
          if (sentenceBuffer.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(sentenceBuffer)) {
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        } else if (event.type === 'transcription.done') {
          if (sentenceBuffer.trim()) {
            finalizeSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        }
      }
    } catch (err) {
      console.error('[capito] Mistral error:', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: String(err.message || err) }));
      }
    }
  }

  // Only connect to Mistral when binary audio arrives
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (!connection && !mistralReady) {
      startMistral(); // fire-and-forget, buffers audio until ready
    }
    if (mistralReady && connection && !connection.isClosed) {
      connection.sendAudio(data);
    }
  });

  // Cleanup on disconnect
  ws.on('close', async () => {
    console.log('[capito] Client disconnected');
    sentenceBuffer = '';
    if (connection && !connection.isClosed) {
      try { await connection.endAudio(); await connection.close(); } catch {}
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
