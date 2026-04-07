# Audio Preservation with Per-Line Playback — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save raw PCM audio to disk during sessions and enable per-line audio playback in the browser.

**Architecture:** Append raw PCM16 chunks to a single file per session. Each line stores an `audioOffsetSec` marking its position in the audio. A REST endpoint reads byte ranges and serves WAV clips. The frontend renders play buttons and uses a shared `<audio>` element.

**Tech Stack:** Node.js (fs streams, node:test), vanilla JS frontend, existing `pcmToWav()` from `lib/audio.js`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/sessions.js` | Modify | `addLine(text, audioOffsetSec)`, `remove()` deletes `.pcm`, `setAudioStartedAt()` persists timestamp |
| `server.js` | Modify | PCM file stream management, `audioOffsetSec` computation, `transcription.done` broadcast change, audio REST route |
| `public/app.js` | Modify | Play button in `createLineElement()`, playback logic, data flow for `audioOffsetSec` |
| `public/index.html` | Modify | CSS for play button and playing state |
| `test/sessions.test.js` | Modify | Tests for `addLine` with offset, `remove` with `.pcm` cleanup |
| `test/audio-endpoint.test.js` | Create | Tests for the audio clip REST endpoint |

---

## Chunk 1: Backend — Sessions and Audio Storage

### Task 1: Update `addLine()` to accept and store `audioOffsetSec`

**Files:**
- Modify: `lib/sessions.js:146-162`
- Modify: `test/sessions.test.js`

- [ ] **Step 1: Write failing test — addLine stores audioOffsetSec**

Add to `test/sessions.test.js`:

```js
describe('addLine with audioOffsetSec', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    try { await sessions.end(); } catch {}
  });

  it('stores audioOffsetSec on the line object', async () => {
    await sessions.create('Test audio offset');
    const lineId = sessions.addLine('test text', 42.5);
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].audioOffsetSec, 42.5);
    await sessions.end();
  });

  it('defaults audioOffsetSec to null when not provided', async () => {
    await sessions.create('Test audio offset default');
    const lineId = sessions.addLine('test text');
    const active = sessions.getActive();
    assert.equal(active.lines[lineId].audioOffsetSec, null);
    await sessions.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `audioOffsetSec` is `undefined`, not `42.5`

- [ ] **Step 3: Implement — modify addLine signature**

In `lib/sessions.js`, change `addLine`:

```js
function addLine(text, audioOffsetSec) {
  if (!activeSession) return null;
  const lineId = activeSession.data.lines.length;
  activeSession.data.lines.push({
    lineId,
    text,
    timestamp: new Date().toISOString(),
    audioOffsetSec: audioOffsetSec ?? null,
    final: true,
    translation: null,
    segments: [],
    entities: [],
    idioms: [],
    costUsd: 0,
  });
  activeSession.dirty = true;
  return lineId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sessions.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sessions.js test/sessions.test.js
git commit -m "feat: addLine accepts audioOffsetSec parameter"
```

---

### Task 2: Add `setAudioStartedAt()` to sessions module

**Files:**
- Modify: `lib/sessions.js`

This stores the audio start timestamp on the session JSON so it survives reconnection.

- [ ] **Step 1: Write failing test**

Add to `test/sessions.test.js`:

```js
describe('setAudioStartedAt', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  after(async () => {
    try { await sessions.end(); } catch {}
  });

  it('stores audioStartedAt on the active session', async () => {
    await sessions.create('Test audio start');
    const ts = new Date().toISOString();
    sessions.setAudioStartedAt(ts);
    const active = sessions.getActive();
    assert.equal(active.audioStartedAt, ts);
    await sessions.end();
  });

  it('does nothing when no active session', () => {
    sessions.setAudioStartedAt(new Date().toISOString());
    // should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `setAudioStartedAt is not a function`

- [ ] **Step 3: Implement**

Add to `lib/sessions.js`:

```js
function setAudioStartedAt(isoString) {
  if (!activeSession) return;
  if (!activeSession.data.audioStartedAt) {
    activeSession.data.audioStartedAt = isoString;
    activeSession.dirty = true;
  }
}
```

Add `setAudioStartedAt` to the export statement at the bottom of the file:

```js
export { init, list, create, get, update, end, remove, addLine, updateLine, getActive, flush, shutdown, setAudioStartedAt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sessions.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sessions.js test/sessions.test.js
git commit -m "feat: add setAudioStartedAt to sessions module"
```

---

### Task 3: `remove()` deletes `.pcm` file alongside `.json`

**Files:**
- Modify: `lib/sessions.js:134-143`
- Modify: `test/sessions.test.js`

- [ ] **Step 1: Write failing test**

```js
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('remove deletes pcm file', () => {
  before(async () => {
    await sessions.init();
    try { await sessions.end(); } catch {}
  });

  it('deletes .pcm file when removing a session', async () => {
    const session = await sessions.create('Test PCM cleanup');
    const id = session.id;
    await sessions.end();

    // Create a fake .pcm file
    const pcmPath = join('sessions', `${id}.pcm`);
    await writeFile(pcmPath, Buffer.alloc(100));
    assert.equal(existsSync(pcmPath), true);

    await sessions.remove(id);
    assert.equal(existsSync(pcmPath), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `.pcm` file still exists after remove

- [ ] **Step 3: Implement**

In `lib/sessions.js`, update `remove()`:

```js
async function remove(id) {
  if (activeSession && activeSession.data.id === id) {
    throw new Error('Cannot delete the active session');
  }
  const filePath = join(SESSIONS_DIR, `${id}.json`);
  const pcmPath = join(SESSIONS_DIR, `${id}.pcm`);
  try { await unlink(filePath); } catch {}
  try { await unlink(pcmPath); } catch {}
  const idx = indexCache.findIndex(s => s.id === id);
  if (idx !== -1) indexCache.splice(idx, 1);
  await saveIndex();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sessions.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sessions.js test/sessions.test.js
git commit -m "feat: remove() cleans up .pcm audio file"
```

---

### Task 4: PCM file writing in server.js

**Files:**
- Modify: `server.js:156-331` (WebSocket connection handler)

This task adds the file stream that saves audio chunks to disk. No tests for this task — it's I/O plumbing inside the WebSocket handler that will be validated by the end-to-end audio endpoint test in Task 5.

- [ ] **Step 1: Add imports and PCM stream management**

At the top of `server.js`, update imports. Change the existing `readFile` import:

```js
import { readFile, stat, open } from 'node:fs/promises';
```

And add new imports:

```js
import { createWriteStream, existsSync } from 'node:fs';
import { pcmToWav } from './lib/audio.js';
```

Inside the `wss.on('connection', ...)` handler, after the existing variable declarations, add:

```js
let pcmStream = null;
let sessionAudioStartTime = null;
```

- [ ] **Step 2: Open PCM stream on first audio chunk**

In the `ws.on('message', ...)` handler (currently at line 307), after `audioCount++` and before the Mistral connection logic, add audio file writing:

```js
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
    console.log(`[capito] PCM recording started: ${pcmPath} (${flags})`);
  }
  if (pcmStream) pcmStream.write(Buffer.from(data));

  if (pipeline) pipeline.pushChunk(data);
  // ... rest of existing handler
});
```

- [ ] **Step 3: Close PCM stream on disconnect**

In the `ws.on('close', ...)` handler, before the existing cleanup, add:

```js
if (pcmStream) {
  pcmStream.end();
  pcmStream = null;
  console.log('[capito] PCM recording stopped');
}
```

- [ ] **Step 4: Compute audioOffsetSec in finalizeSentence**

Update `finalizeSentence()` to pass the offset to `addLine()`:

```js
function finalizeSentence(raw) {
  const text = cleanText(raw.trim());
  if (!text) return;
  const audioOffsetSec = sessionAudioStartTime
    ? (Date.now() - sessionAudioStartTime) / 1000
    : null;
  const lineId = sessions.addLine(text, audioOffsetSec);
  broadcast({ type: 'transcription.done', lineId, text, audioOffsetSec });
  // ... rest unchanged
}
```

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `node --test test/sessions.test.js && node --test test/audio.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: write PCM audio to disk and compute line offsets"
```

---

### Task 5: Audio clip REST endpoint

**Files:**
- Modify: `server.js` (HTTP handler, lines 60-131)
- Create: `test/audio-endpoint.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/audio-endpoint.test.js`:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pcmToWav } from '../lib/audio.js';

// Helper: make a fake .pcm file with known content
async function writeFakePcm(sessionId, durationSec) {
  const bytesPerSec = 16000 * 2;
  const totalBytes = durationSec * bytesPerSec;
  const buf = Buffer.alloc(totalBytes);
  // Write ascending sample values for verification
  for (let i = 0; i < totalBytes; i += 2) {
    buf.writeInt16LE((i / 2) % 32767, i);
  }
  const path = join('sessions', `${sessionId}.pcm`);
  await writeFile(path, buf);
  return { path, buf };
}

describe('GET /api/sessions/:id/audio', () => {
  const fakeId = 'sess_test_audio';

  before(async () => {
    await writeFakePcm(fakeId, 10); // 10 seconds of audio
  });

  after(async () => {
    try { await unlink(join('sessions', `${fakeId}.pcm`)); } catch {}
  });

  it('returns 404 when .pcm file does not exist', async () => {
    const res = await fetch('http://localhost:3000/api/sessions/sess_nonexistent/audio?from=0&to=1');
    assert.equal(res.status, 404);
  });

  it('returns WAV audio for a valid range', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=1&to=2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    // 1 second of PCM16 16kHz mono = 32000 bytes + 44 byte WAV header
    assert.equal(buf.length, 32000 + 44);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  });

  it('clamps to file boundaries', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=9&to=20`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    // Only 1 second of data available (9-10), so 32000 + 44
    assert.equal(buf.length, 32000 + 44);
  });

  it('reads to end of file when to is omitted', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?from=8`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    // 2 seconds (8-10) = 64000 + 44
    assert.equal(buf.length, 64000 + 44);
  });

  it('defaults from to 0 when omitted', async () => {
    const res = await fetch(`http://localhost:3000/api/sessions/${fakeId}/audio?to=1`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    // 1 second (0-1) = 32000 + 44
    assert.equal(buf.length, 32000 + 44);
  });
});
```

**Note:** These tests require the server to be running on port 3000. Run them against a live server instance.

- [ ] **Step 2: Run tests to verify they fail**

Start the server in background: `node server.js &`
Run: `node --test test/audio-endpoint.test.js`
Expected: FAIL — 404 for all routes (endpoint doesn't exist yet)
Stop server after.

- [ ] **Step 3: Implement the audio endpoint**

In `server.js`, add the route pattern at the top alongside existing patterns:

```js
const RE_SESSION_AUDIO = /^\/api\/sessions\/(sess_\d+)\/audio$/;
```

In the HTTP handler, add the audio route **before** the `RE_SESSION_END` match
(to keep audio/end/id routes grouped together):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Start server: `node server.js &`
Run: `node --test test/audio-endpoint.test.js`
Expected: All PASS
Stop server.

- [ ] **Step 5: Commit**

```bash
git add server.js test/audio-endpoint.test.js
git commit -m "feat: add GET /api/sessions/:id/audio endpoint for WAV clips"
```

---

## Chunk 2: Frontend — Play Button and Playback

### Task 6: Play button CSS

**Files:**
- Modify: `public/index.html` (CSS section, around line 270)

- [ ] **Step 1: Add play button styles**

Add the following CSS before the closing `</style>` tag in `index.html`:

```css
/* --- Audio play button --- */
.line-play-btn {
  display: inline-block;
  cursor: pointer;
  font-size: 10px;
  color: var(--text-muted);
  margin-right: 4px;
  transition: color 0.15s ease;
  user-select: none;
  vertical-align: baseline;
}

.line-play-btn:hover {
  color: var(--accent);
}

.line-play-btn.playing {
  color: var(--accent);
}
```

- [ ] **Step 2: Verify visually**

Open `http://localhost:3000` in a browser. No visual changes yet (no play buttons rendered), but the CSS should load without errors.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add CSS for audio play button"
```

---

### Task 7: Play button rendering in `createLineElement()`

**Files:**
- Modify: `public/app.js:298-320` (`createLineElement`)
- Modify: `public/app.js:223-246` (`renderSession`)
- Modify: `public/app.js:488-513` (`handleEvent` `transcription.done` case)

- [ ] **Step 1: Update `createLineElement` to accept `audioOffsetSec`**

Change the function signature and add play button rendering:

```js
function createLineElement(lineId, text, timestamp, audioOffsetSec) {
  const el = document.createElement('div');
  el.className = 'transcript-line';
  el.dataset.lineId = lineId;
  if (audioOffsetSec !== undefined && audioOffsetSec !== null) {
    el.dataset.audioOffset = audioOffsetSec;
  }

  const ts = document.createElement('div');
  ts.className = 'line-timestamp';

  // Play button (only if audio offset exists)
  if (audioOffsetSec !== undefined && audioOffsetSec !== null) {
    const playBtn = document.createElement('span');
    playBtn.className = 'line-play-btn';
    playBtn.textContent = '\u25B6';
    playBtn.title = 'Play audio';
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playLineAudio(lineId);
    });
    ts.appendChild(playBtn);
  }

  const tsText = document.createTextNode(formatElapsed(timestamp));
  ts.appendChild(tsText);
  el.appendChild(ts);

  const italian = document.createElement('div');
  italian.className = 'line-italian';
  italian.textContent = text || '';
  el.appendChild(italian);

  const translation = document.createElement('div');
  translation.className = 'line-translation';
  el.appendChild(translation);

  transcript.appendChild(el);
  if (lineId !== undefined) lineElements.set(lineId, el);
  return el;
}
```

- [ ] **Step 2: Update `renderSession()` to pass `audioOffsetSec`**

In `renderSession()`, change the `createLineElement` call:

```js
const el = createLineElement(line.lineId, line.text, line.timestamp, line.audioOffsetSec);
```

- [ ] **Step 3: Update `handleEvent` `transcription.done` to store `audioOffsetSec`**

In the `transcription.done` case of `handleEvent`, update the client-side line object:

```js
case 'transcription.done': {
  if (activeLineEl && event.lineId !== undefined) {
    activeLineEl.dataset.lineId = event.lineId;
    lineElements.set(event.lineId, activeLineEl);
    activeLineEl.querySelector('.line-italian').textContent = event.text;
    activeLineEl.classList.add('pending-analysis');

    // Add play button retroactively if audio offset exists
    if (event.audioOffsetSec !== undefined && event.audioOffsetSec !== null) {
      activeLineEl.dataset.audioOffset = event.audioOffsetSec;
      const ts = activeLineEl.querySelector('.line-timestamp');
      if (ts && !ts.querySelector('.line-play-btn')) {
        const playBtn = document.createElement('span');
        playBtn.className = 'line-play-btn';
        playBtn.textContent = '\u25B6';
        playBtn.title = 'Play audio';
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          playLineAudio(event.lineId);
        });
        ts.prepend(playBtn);
      }
    }
  }
  // Keep client-side session in sync
  if (currentSession && event.lineId !== undefined) {
    if (!currentSession.lines) currentSession.lines = [];
    currentSession.lines.push({
      lineId: event.lineId,
      text: event.text,
      timestamp: new Date().toISOString(),
      audioOffsetSec: event.audioOffsetSec ?? null,
      final: true,
      translation: null,
      segments: [],
      entities: [],
      idioms: [],
      costUsd: 0,
    });
  }
  activeLineEl = null;
  updateLineClasses();
  break;
}
```

- [ ] **Step 4: Fix `applySegments()` to preserve play button**

The existing `applySegments()` function does `lineEl.innerHTML = ''` which
destroys all children, including the play button. Update it to preserve (or
re-create) the play button when rebuilding the timestamp:

In `applySegments()`, change the timestamp reconstruction to preserve the play
button:

```js
function applySegments(lineEl, segments, entities, idioms) {
  const ts = lineEl.querySelector('.line-timestamp');
  const tsText = ts ? ts.textContent.replace('\u25B6', '').replace('\u25A0', '').trim() : '';
  const playBtn = ts ? ts.querySelector('.line-play-btn') : null;

  lineEl.innerHTML = '';

  if (tsText || playBtn) {
    const tsEl = document.createElement('div');
    tsEl.className = 'line-timestamp';
    if (playBtn) tsEl.appendChild(playBtn);
    tsEl.appendChild(document.createTextNode(tsText));
    lineEl.appendChild(tsEl);
  }

  // ... rest of function unchanged (container, segments loop, etc.)
```

- [ ] **Step 5: Add stub `playLineAudio` function**

Add at the bottom of `app.js`, before the init section:

```js
// --- Audio playback ---

function playLineAudio(lineId) {
  console.log('[capito] playLineAudio:', lineId);
  // Implemented in next task
}
```

- [ ] **Step 6: Verify visually**

Load a past session that was recorded with audio offsets. Each line should show a `▶` before the timestamp. (For sessions without audio, no play buttons appear.) Verify that when analysis arrives (segments), the play button survives.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "feat: render play button on transcript lines with audio"
```

---

### Task 8: Playback logic

**Files:**
- Modify: `public/app.js` (replace `playLineAudio` stub)

- [ ] **Step 1: Implement `playLineAudio`**

Replace the stub with the full implementation:

```js
// --- Audio playback ---

let audioEl = null;
let playingLineId = null;
let currentBlobUrl = null;

function getAudioElement() {
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.addEventListener('ended', stopAudioPlayback);
    audioEl.addEventListener('error', stopAudioPlayback);
  }
  return audioEl;
}

function stopAudioPlayback() {
  const audio = getAudioElement();
  audio.pause();
  audio.removeAttribute('src');
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  // Reset play button icon
  if (playingLineId !== null) {
    const el = lineElements.get(playingLineId);
    if (el) {
      const btn = el.querySelector('.line-play-btn');
      if (btn) {
        btn.textContent = '\u25B6';
        btn.classList.remove('playing');
      }
    }
    playingLineId = null;
  }
}

async function playLineAudio(lineId) {
  // If already playing this line, stop
  if (playingLineId === lineId) {
    stopAudioPlayback();
    return;
  }

  // Stop any current playback
  stopAudioPlayback();

  if (!currentSession) return;

  // Compute from/to offsets
  const lines = currentSession.lines;
  const lineIndex = lines.findIndex(l => l.lineId === lineId);
  if (lineIndex === -1) return;

  const line = lines[lineIndex];
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : null;
  const from = prevLine?.audioOffsetSec ?? 0;
  const to = line.audioOffsetSec;

  if (to === null || to === undefined) return;

  // Build URL
  let url = `/api/sessions/${currentSession.id}/audio?from=${from}`;
  if (to !== null && to !== undefined) url += `&to=${to}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return;

    const blob = await res.blob();
    currentBlobUrl = URL.createObjectURL(blob);

    const audio = getAudioElement();
    audio.src = currentBlobUrl;
    playingLineId = lineId;

    // Update button to stop icon
    const el = lineElements.get(lineId);
    if (el) {
      const btn = el.querySelector('.line-play-btn');
      if (btn) {
        btn.textContent = '\u25A0';
        btn.classList.add('playing');
      }
    }

    await audio.play();
  } catch (err) {
    console.error('[capito] Audio playback error:', err);
    stopAudioPlayback();
  }
}
```

- [ ] **Step 2: Verify end-to-end**

1. Start server: `node server.js`
2. Create a session, start recording, speak for ~30 seconds, stop
3. Each finalized line should have a `▶` button
4. Click `▶` — should hear the audio clip for that line
5. While playing, icon shows `■` — click to stop
6. Click a different line while one is playing — switches playback
7. Load a past session — play buttons work from saved data

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: implement audio playback with shared audio element"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

```bash
node --test test/audio.test.js test/sessions.test.js
```

Expected: All PASS

- [ ] **Step 2: Run audio endpoint tests against live server**

Start server, then:
```bash
node --test test/audio-endpoint.test.js
```

Expected: All PASS

- [ ] **Step 3: Manual end-to-end test**

1. Create new session, record audio, verify `.pcm` file created in `sessions/`
2. Check session JSON — `audioStartedAt` present, each line has `audioOffsetSec`
3. Play buttons work during live session
4. Stop recording, play buttons still work
5. Reload page, load session from history — play buttons work
6. Delete session — `.pcm` file removed

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address any issues from end-to-end testing"
```
