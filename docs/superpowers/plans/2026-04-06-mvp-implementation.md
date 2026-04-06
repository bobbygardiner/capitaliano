# Capito MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live Italian speech-to-text tool that streams mic audio to Voxtral Realtime and displays a karaoke-style rolling transcript.

**Architecture:** Browser captures mic audio via AudioWorklet, streams PCM16 binary frames over WebSocket to a Node.js server, which proxies to the Mistral SDK. Mistral events are forwarded back to the browser for rendering.

**Tech Stack:** Node.js, `ws`, `@mistralai/mistralai`, vanilla JS, Web Audio API (AudioWorklet)

---

## Chunk 1: Foundation — Project Setup, AudioWorklet, Server

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Verify: `.env` (user creates manually from `.env.example`)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "capito",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@mistralai/mistralai": "^2.1.2",
    "dotenv": "^16.4.7",
    "ws": "^8.18.2"
  }
}
```

Write to `package.json`.

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 3: Verify .env exists**

Run: `test -f .env && echo "OK" || echo "MISSING"`

If MISSING, copy from `.env.example` and remind user to add their Mistral API key:
```bash
cp .env.example .env
```

- [ ] **Step 4: Create public directory**

Run: `mkdir -p public`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add package.json with ws, dotenv, and mistral SDK"
```

---

### Task 2: AudioWorklet Processor

**Files:**
- Create: `public/pcm-processor.js`

- [ ] **Step 1: Write pcm-processor.js**

```javascript
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._bufferSize = 4096; // 256ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0]; // mono, 128 samples per render quantum

    // Accumulate samples
    const newBuffer = new Float32Array(this._buffer.length + channel.length);
    newBuffer.set(this._buffer);
    newBuffer.set(channel, this._buffer.length);
    this._buffer = newBuffer;

    // Cap at 4x target to prevent memory leaks in long sessions
    if (this._buffer.length > this._bufferSize * 4) {
      this._buffer = this._buffer.slice(this._buffer.length - this._bufferSize);
    }

    // When we have enough, convert Float32 → Int16 and send
    while (this._buffer.length >= this._bufferSize) {
      const chunk = this._buffer.slice(0, this._bufferSize);
      this._buffer = this._buffer.slice(this._bufferSize);

      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
```

Write to `public/pcm-processor.js`.

- [ ] **Step 2: Verify file serves correctly**

We'll verify this works once the server is built (Task 3). For now, confirm the file exists:

Run: `cat public/pcm-processor.js | head -3`
Expected: `class PCMProcessor extends AudioWorkletProcessor {`

- [ ] **Step 3: Commit**

```bash
git add public/pcm-processor.js
git commit -m "Add AudioWorklet processor for PCM16 conversion"
```

---

### Task 3: Server — Static Files and WebSocket Proxy

**Files:**
- Create: `server.js`

- [ ] **Step 1: Write server.js**

```javascript
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
```

Write to `server.js`.

- [ ] **Step 2: Create a minimal index.html for testing static serving**

```html
<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><title>Capito</title></head>
<body><p>Capito is running.</p></body>
</html>
```

Write to `public/index.html`.

- [ ] **Step 3: Verify static file serving**

Run: `node server.js &`
Run: `curl -s http://localhost:3000/`
Expected: HTML containing "Capito is running."

Run: `curl -s http://localhost:3000/pcm-processor.js | head -1`
Expected: `class PCMProcessor extends AudioWorkletProcessor {`

Kill the background server after verification.

- [ ] **Step 4: Commit**

```bash
git add server.js public/index.html
git commit -m "Add server with static files and Mistral WebSocket proxy"
```

---

## Chunk 2: Frontend and Integration

### Task 4: Frontend — HTML Structure and CSS

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Write the full index.html with structure and styling**

Replace `public/index.html` with:

```html
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Capito</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Sora', -apple-system, 'Helvetica Neue', sans-serif;
      background: #FAF8F5;
      color: #3D3529;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Top bar */
    .top-bar {
      background: #F0EDE8;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid #E5E0D9;
      flex-shrink: 0;
    }

    .top-bar select {
      font-family: inherit;
      font-size: 13px;
      padding: 6px 10px;
      border: 1px solid #D5CFC7;
      border-radius: 6px;
      background: #FAF8F5;
      color: #3D3529;
      cursor: pointer;
    }

    .top-bar button {
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      background: #3D3529;
      color: #FAF8F5;
      cursor: pointer;
    }

    .top-bar button:hover { background: #2A241B; }

    .top-bar button:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #8A8780;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #D0171B;
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .hidden { display: none; }

    /* Error banner */
    .error-banner {
      background: #FDF0F0;
      color: #9B1C1C;
      padding: 10px 20px;
      font-size: 13px;
      border-bottom: 1px solid #F5D0D0;
    }

    /* Transcript area */
    .transcript {
      flex: 1;
      overflow-y: auto;
      padding: 24px 20px;
    }

    .transcript-line {
      font-size: 19px;
      line-height: 1.6;
      margin-bottom: 8px;
      color: #C4B5A5;
      transition: color 0.3s ease;
    }

    .transcript-line.active {
      color: #3D3529;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <select id="mic-select">
      <option value="">Loading devices…</option>
    </select>
    <button id="start-btn">Start</button>
    <div id="status" class="status hidden">
      <div class="status-dot"></div>
      <span>Capturing</span>
    </div>
  </div>
  <div id="error-banner" class="error-banner hidden"></div>
  <div id="transcript" class="transcript"></div>

  <script>
    // JS will be added in Task 5
  </script>
</body>
</html>
```

Write to `public/index.html`.

- [ ] **Step 2: Verify the page renders**

Run: `node server.js &`
Open `http://localhost:3000` in a browser. Confirm:
- Cream background (#FAF8F5)
- Top bar with mic dropdown and Start button
- Empty transcript area below
- Sora font loaded

Kill background server after verification.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "Add frontend HTML structure and warm muted styling"
```

---

### Task 5: Frontend — JavaScript (Audio Capture, WebSocket, Transcript)

**Files:**
- Modify: `public/index.html` (replace the `<script>` block)

- [ ] **Step 1: Write the complete frontend JavaScript**

Replace the `<script>` block in `public/index.html` with:

```html
  <script>
    const micSelect = document.getElementById('mic-select');
    const startBtn = document.getElementById('start-btn');
    const status = document.getElementById('status');
    const errorBanner = document.getElementById('error-banner');
    const transcript = document.getElementById('transcript');

    // In-memory transcript data (structured for future persistence)
    const lines = [];

    let audioContext = null;
    let source = null;
    let pcmNode = null;
    let ws = null;
    let activeLine = null;

    // --- Device enumeration ---

    async function loadDevices() {
      try {
        // Request permission first (needed to get device labels)
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        micSelect.innerHTML = '';
        for (const device of audioInputs) {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Microphone ${micSelect.length + 1}`;
          micSelect.appendChild(option);
        }
      } catch (err) {
        showError('Microphone access denied — check browser permissions');
      }
    }

    // --- Error display ---

    function showError(message) {
      errorBanner.textContent = message;
      errorBanner.classList.remove('hidden');
    }

    // --- Transcript rendering ---

    function createNewLine() {
      // Dim the previous active line
      if (activeLine) {
        activeLine.classList.remove('active');
      }

      activeLine = document.createElement('div');
      activeLine.className = 'transcript-line active';
      transcript.appendChild(activeLine);

      lines.push({ text: '', timestamp: Date.now(), final: false });
    }

    function appendDelta(text) {
      if (!activeLine) createNewLine();
      activeLine.textContent += text;
      lines[lines.length - 1].text += text;
      transcript.scrollTop = transcript.scrollHeight;
    }

    function finaliseLine(text) {
      if (activeLine) {
        if (text) activeLine.textContent = text;
        lines[lines.length - 1].text = activeLine.textContent;
        lines[lines.length - 1].final = true;
      }
      activeLine = null;
    }

    // --- WebSocket message handling ---

    function handleEvent(event) {
      switch (event.type) {
        case 'transcription.text.delta':
          appendDelta(event.text);
          break;

        case 'transcription.done':
          finaliseLine(event.text);
          break;

        case 'transcription.language':
          console.log('[capito] Detected language:', event.audioLanguage);
          break;

        case 'error': {
          const msg = event.error
            ? typeof event.error.message === 'string'
              ? event.error.message
              : JSON.stringify(event.error.message)
            : event.message || 'Unknown error';
          showError(msg);
          break;
        }
      }
    }

    // --- Start transcription ---

    async function start() {
      startBtn.disabled = true;

      try {
        // 1. Get mic stream with selected device
        const constraints = {
          audio: {
            deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        // 2. AudioContext at 16kHz (browser auto-resamples)
        audioContext = new AudioContext({ sampleRate: 16000 });
        if (audioContext.state === 'suspended') await audioContext.resume();

        // 3. Load AudioWorklet
        await audioContext.audioWorklet.addModule('/pcm-processor.js');

        // 4. Connect pipeline: mic → worklet
        source = audioContext.createMediaStreamSource(stream);
        pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        source.connect(pcmNode);
        // Do NOT connect to destination — we don't want playback

        // 5. Open WebSocket
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${location.host}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          // 6. Wire AudioWorklet output → WebSocket
          pcmNode.port.onmessage = (e) => {
            if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) {
              ws.send(e.data);
            }
          };

          // Update UI
          startBtn.classList.add('hidden');
          status.classList.remove('hidden');
          micSelect.disabled = true;

          // Create first transcript line
          createNewLine();
        };

        ws.onmessage = (e) => {
          try {
            handleEvent(JSON.parse(e.data));
          } catch (err) {
            console.error('[capito] Failed to parse event:', err);
          }
        };

        ws.onclose = () => {
          showError('Connection lost — refresh the page');
        };

        ws.onerror = () => {
          showError('Connection lost — refresh the page');
        };
      } catch (err) {
        showError(
          err.name === 'NotAllowedError'
            ? 'Microphone access denied — check browser permissions'
            : `Error: ${err.message}`
        );
        startBtn.disabled = false;
      }
    }

    // --- Teardown (on page unload) ---

    function teardown() {
      if (pcmNode) {
        pcmNode.port.onmessage = null;
        pcmNode.disconnect();
      }
      if (source) {
        source.mediaStream.getTracks().forEach(t => t.stop());
        source.disconnect();
      }
      if (audioContext) audioContext.close();
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'Page unload');
    }

    window.addEventListener('beforeunload', teardown);

    // --- Init ---

    startBtn.addEventListener('click', start);
    loadDevices();
  </script>
```

Replace the `<script>` block in `public/index.html`.

- [ ] **Step 2: Verify the page loads without JS errors**

Run: `node server.js &`
Open `http://localhost:3000` in a browser. Open the DevTools console. Confirm:
- No JavaScript errors in the console
- Mic dropdown is populated with available audio devices
- Start button is clickable
- Clicking Start triggers mic permission prompt (if not already granted)

Kill background server after verification.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "Add frontend JS: audio capture, WebSocket, transcript rendering"
```

---

### Task 6: End-to-End Verification

**Files:** None (manual testing only)

- [ ] **Step 1: Ensure .env has a valid MISTRAL_API_KEY**

Run: `grep MISTRAL_API_KEY .env`
Expected: `MISTRAL_API_KEY=<actual key, not placeholder>`

If placeholder, remind user to add their real key.

- [ ] **Step 2: Start the server**

Run: `npm start`
Expected: `[capito] Running at http://localhost:3000`

- [ ] **Step 3: Test in browser**

Open `http://localhost:3000`. Verify:
1. Mic dropdown shows available devices (select the iPhone / Continuity Camera if available, or any mic)
2. Click Start
3. Confirm mic permission if prompted
4. Start button disappears, "Capturing" indicator with pulsing red dot appears
5. Speak into the mic (or play Italian audio near it)
6. Italian text appears in the transcript area within ~1 second
7. Text deltas flow smoothly, new lines appear on utterance boundaries
8. Current line is dark (#3D3529), completed lines are dimmed (#C4B5A5)
9. Transcript auto-scrolls as new lines are added

- [ ] **Step 4: Test error handling**

1. Stop the server (Ctrl+C) while browser is connected → "Connection lost" banner should appear
2. Restart server, refresh page, try starting without a mic available → appropriate error message

- [ ] **Step 5: Final commit with updated CLAUDE.md**

Update the `## Project structure` section in `CLAUDE.md`:

    ## Project structure

    capito/
    ├── server.js              # HTTP + WebSocket server, Mistral SDK proxy
    ├── public/
    │   ├── index.html         # Single-page app (HTML, CSS, JS inline)
    │   └── pcm-processor.js   # AudioWorklet for PCM16 conversion
    ├── package.json           # Three deps: ws, dotenv, @mistralai/mistralai
    ├── .env                   # MISTRAL_API_KEY (gitignored)
    ├── .env.example           # Template for .env
    ├── context.md             # Project context and roadmap
    ├── CLAUDE.md              # This file
    └── docs/
        └── superpowers/
            ├── specs/          # Design specs
            └── plans/          # Implementation plans

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md with project structure"
```

- [ ] **Step 6: Push all commits**

```bash
git push origin main
```
