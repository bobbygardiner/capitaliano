import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import {
  RealtimeTranscription,
  AudioEncoding,
} from '@mistralai/mistralai/extra/realtime';

config();

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
};
const PORT = 3000;

// Static file server
const server = createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = join('public', urlPath === '/' ? 'index.html' : urlPath);
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

// WebSocket proxy to Mistral
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  console.log('[capito] Browser connected');

  const client = new RealtimeTranscription({
    apiKey: process.env.MISTRAL_API_KEY,
  });

  let connection;
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
    console.log('[capito] Mistral connected');
  } catch (err) {
    console.error('[capito] Mistral connection failed:', err.message);
    ws.send(
      JSON.stringify({ type: 'error', message: 'Failed to connect to Mistral' })
    );
    ws.close();
    return;
  }

  // Forward browser audio → Mistral
  ws.on('message', (data, isBinary) => {
    if (isBinary && connection && !connection.isClosed) {
      connection.sendAudio(data);
    }
  });

  // Forward Mistral events → browser
  (async () => {
    try {
      for await (const event of connection) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      }
    } catch (err) {
      console.error('[capito] Mistral stream error:', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: String(err.message || err),
          })
        );
      }
    }
  })();

  // Cleanup on browser disconnect
  ws.on('close', async () => {
    console.log('[capito] Browser disconnected');
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

server.listen(PORT, () => {
  console.log(`[capito] Running at http://localhost:${PORT}`);
});
