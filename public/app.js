// --- DOM refs ---
const sessionsToggle = document.getElementById('sessions-toggle');
const sessionsPanel = document.getElementById('sessions-panel');
const sessionsBackdrop = document.getElementById('sessions-backdrop');
const sessionsList = document.getElementById('sessions-list');
const newSessionBtn = document.getElementById('new-session-btn');
const sessionNameEl = document.getElementById('session-name');
const micSelect = document.getElementById('mic-select');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const translationToggle = document.getElementById('translation-toggle');
const statusEl = document.getElementById('status');
const errorBanner = document.getElementById('error-banner');
const transcript = document.getElementById('transcript');
const emptyState = document.getElementById('empty-state');
const tabBar = document.getElementById('tab-bar');
const vocabList = document.getElementById('vocab-list');
const vocabPanel = document.getElementById('vocab-panel');
const costIndicator = document.getElementById('cost-indicator');
const newSessionForm = document.getElementById('new-session-form');
const sessionNameInput = document.getElementById('session-name-input');
const sessionContextInput = document.getElementById('session-context-input');
const createSessionBtn = document.getElementById('create-session-btn');
const cancelSessionBtn = document.getElementById('cancel-session-btn');
const editSessionBtn = document.getElementById('edit-session-btn');
const editContextBackdrop = document.getElementById('edit-context-backdrop');
const editContextPanel = document.getElementById('edit-context-panel');
const editContextName = document.getElementById('edit-context-name');
const editContextTextarea = document.getElementById('edit-context-textarea');
const saveContextBtn = document.getElementById('save-context-btn');
const cancelContextBtn = document.getElementById('cancel-context-btn');

// --- State ---
let currentSession = null;
let audioContext = null;
let source = null;
let pcmNode = null;
let activeLineEl = null;
let waitingEl = null;
let lineElements = new Map(); // lineId -> DOM element
let sessionCostUsd = 0;

// --- Sessions panel ---

function openSessions() {
  sessionsPanel.classList.add('open');
  sessionsBackdrop.classList.add('open');
  loadSessionsList();
}

function closeSessions() {
  sessionsPanel.classList.remove('open');
  sessionsBackdrop.classList.remove('open');
}

sessionsToggle.addEventListener('click', openSessions);
sessionsBackdrop.addEventListener('click', closeSessions);

async function loadSessionsList() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    renderSessionsList(data.sessions || []);
  } catch (err) {
    console.error('[capito] Failed to load sessions:', err);
  }
}

function renderSessionsList(sessions) {
  sessionsList.innerHTML = '';
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 13px;">No sessions yet</div>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (currentSession && currentSession.id === s.id ? ' active' : '');
    const isLive = !s.endedAt;
    item.innerHTML = `
      ${isLive ? '<div class="session-live-dot"></div>' : '<div class="session-dot-spacer"></div>'}
      <div style="flex:1;min-width:0">
        <div class="session-label">${escapeHtml(s.name)}</div>
        <div class="session-meta">${formatSessionTime(s.startedAt)} · ${s.lineCount} lines</div>
      </div>
      ${isLive
        ? '<button class="end-session-btn session-action-btn" data-id="' + s.id + '">End</button>'
        : '<button class="del-session-btn session-action-btn" data-id="' + s.id + '">Del</button>'}
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-action-btn')) return;
      loadSession(s.id);
      closeSessions();
    });
    const endBtn = item.querySelector('.end-session-btn');
    if (endBtn) {
      endBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch(`/api/sessions/${s.id}/end`, { method: 'POST' });
          if (currentSession && currentSession.id === s.id) {
            currentSession.endedAt = new Date().toISOString();
          }
          loadSessionsList();
        } catch (err) {
          console.error('[capito] Failed to end session:', err);
        }
      });
    }
    const delBtn = item.querySelector('.del-session-btn');
    if (delBtn) {
      let confirmPending = false;
      let confirmTimer = null;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirmPending) {
          confirmPending = true;
          delBtn.textContent = 'Sure?';
          delBtn.style.background = 'var(--accent)';
          delBtn.style.color = 'var(--bg)';
          delBtn.style.borderColor = 'var(--accent)';
          confirmTimer = setTimeout(() => {
            confirmPending = false;
            delBtn.textContent = 'Del';
            delBtn.style.background = '';
            delBtn.style.color = '';
            delBtn.style.borderColor = '';
          }, 3000);
          return;
        }
        clearTimeout(confirmTimer);
        try {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
          if (currentSession && currentSession.id === s.id) {
            currentSession = null;
            sessionNameEl.classList.add('hidden');
            editSessionBtn.classList.add('hidden');
            costIndicator.classList.add('hidden');
            tabBar.classList.add('disabled');
            clearTranscriptDisplay();
            emptyState.classList.remove('hidden');
            transcript.appendChild(emptyState);
          }
          loadSessionsList();
        } catch (err) {
          console.error('[capito] Failed to delete session:', err);
        }
      });
    }
    sessionsList.appendChild(item);
  }
}

function formatSessionTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ', ' + time;
}

newSessionBtn.addEventListener('click', () => {
  newSessionForm.classList.toggle('hidden');
  if (!newSessionForm.classList.contains('hidden')) {
    sessionNameInput.value = '';
    sessionContextInput.value = '';
    sessionNameInput.focus();
  }
});

createSessionBtn.addEventListener('click', async () => {
  const name = sessionNameInput.value.trim() || 'New Session';
  const context = sessionContextInput.value.trim();
  try {
    const body = { name };
    if (context) body.context = context;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      showError(err.error || 'Failed to create session');
      return;
    }
    const session = await res.json();
    currentSession = session;
    sessionNameEl.textContent = session.name;
    sessionNameEl.classList.remove('hidden');
    editSessionBtn.classList.remove('hidden');
    emptyState.classList.add('hidden');
    tabBar.classList.remove('disabled');
    clearTranscriptDisplay();
    newSessionForm.classList.add('hidden');
    closeSessions();
  } catch (err) {
    showError('Failed to create session');
  }
});

cancelSessionBtn.addEventListener('click', () => {
  newSessionForm.classList.add('hidden');
});

async function loadSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}`);
    const session = await res.json();
    currentSession = session;
    sessionNameEl.textContent = session.name;
    sessionNameEl.classList.remove('hidden');
    editSessionBtn.classList.remove('hidden');
    emptyState.classList.add('hidden');
    renderSession(session);
  } catch (err) {
    showError('Failed to load session');
  }
}

function renderSession(session) {
  clearTranscriptDisplay();
  for (const line of session.lines) {
    const el = createLineElement(line.lineId, line.text, line.timestamp);
    if (line.segments && line.segments.length) {
      applySegments(el, line.segments, line.entities, line.idioms);
    } else {
      if (line.translation) addTranslation(el, line.translation);
      if (line.entities && line.entities.length) {
        applyEntityHighlighting(el, line.text, line.entities);
      }
      if (line.idioms && line.idioms.length) {
        applyIdiomHighlighting(el, line.text, line.idioms);
      }
    }
    // Show phase comparison for lines that have phase 1 data stored
    if (line.phase1Text) {
      el.classList.add('has-upgrade');
      const phase1El = document.createElement('div');
      phase1El.className = 'line-phase1';
      phase1El.innerHTML = `<strong>Phase 1:</strong> ${escapeHtml(line.phase1Text)}${line.phase1Translation ? '<br><em>' + escapeHtml(line.phase1Translation) + '</em>' : ''}`;
      el.appendChild(phase1El);
      const toggle = document.createElement('div');
      toggle.className = 'line-phase-toggle';
      toggle.textContent = 'P1 \u2194 P2';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.toggle('show-phase1');
      });
      const ts = el.querySelector('.line-timestamp');
      if (ts) ts.after(toggle);
      else el.prepend(toggle);
    }
  }
  updateLineClasses();
  scrollToBottom();
  tabBar.classList.remove('disabled');
  renderVocab();
  sessionCostUsd = calculateSessionCost(session);
  updateCostDisplay();
}

// --- Device enumeration ---

async function loadDevices() {
  try {
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
    console.error('[capito] Device enumeration failed:', err);
    showError('Microphone access denied — check browser permissions');
  }
}

// --- Error display ---

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function clearError() {
  errorBanner.classList.add('hidden');
}

// --- Transcript rendering ---

function clearTranscriptDisplay() {
  transcript.innerHTML = '';
  activeLineEl = null;
  lineElements.clear();
}

function formatElapsed(timestamp) {
  if (!currentSession || !timestamp) return '';
  const start = new Date(currentSession.startedAt).getTime();
  const now = new Date(timestamp).getTime();
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function createLineElement(lineId, text, timestamp) {
  const el = document.createElement('div');
  el.className = 'transcript-line';
  el.dataset.lineId = lineId;

  const ts = document.createElement('div');
  ts.className = 'line-timestamp';
  ts.textContent = formatElapsed(timestamp);
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

function highlightEntitiesHtml(html, entities) {
  if (!entities || !entities.length) return html;
  const sorted = [...entities].sort((a, b) => b.text.length - a.text.length);
  for (const ent of sorted) {
    const escaped = escapeHtml(ent.text);
    if (html.includes(escaped)) {
      html = html.replaceAll(escaped, `<span data-entity="${escapeAttr(ent.type)}">${escaped}</span>`);
    }
  }
  return html;
}

function highlightIdiomsHtml(html, idioms) {
  if (!idioms || !idioms.length) return html;
  for (const idiom of idioms) {
    const expr = escapeHtml(idiom.expression);
    const meaning = escapeAttr(idiom.meaning);
    if (html.includes(expr)) {
      html = html.replace(expr, `<span data-idiom="${meaning}" tabindex="0">${expr}</span>`);
    }
  }
  return html;
}

function applySegments(lineEl, segments, entities, idioms) {
  // Preserve timestamp, replace Italian + translation with segmented pairs
  const ts = lineEl.querySelector('.line-timestamp');
  const tsText = ts ? ts.textContent : '';

  lineEl.innerHTML = '';

  if (tsText) {
    const tsEl = document.createElement('div');
    tsEl.className = 'line-timestamp';
    tsEl.textContent = tsText;
    lineEl.appendChild(tsEl);
  }

  const container = document.createElement('div');
  container.className = 'line-segments';

  for (const seg of segments) {
    const pair = document.createElement('div');
    pair.className = 'segment-pair';

    const itEl = document.createElement('div');
    itEl.className = 'segment-italian';

    let itHtml = escapeHtml(seg.it);
    itHtml = highlightEntitiesHtml(itHtml, entities);
    itHtml = highlightIdiomsHtml(itHtml, idioms);
    itEl.innerHTML = itHtml;
    pair.appendChild(itEl);

    const enEl = document.createElement('div');
    enEl.className = 'segment-translation';
    enEl.textContent = seg.en || '';
    pair.appendChild(enEl);

    container.appendChild(pair);
  }

  lineEl.appendChild(container);
}

function updateLineClasses() {
  const allLines = transcript.querySelectorAll('.transcript-line');
  const count = allLines.length;
  // Only update the last 4 lines (active + recent-1 + recent-2 + previously active)
  for (let i = Math.max(0, count - 4); i < count; i++) {
    const line = allLines[i];
    line.classList.remove('active', 'recent-1', 'recent-2');
    const distance = count - 1 - i;
    if (distance === 0) line.classList.add('active');
    else if (distance === 1) line.classList.add('recent-1');
    else if (distance === 2) line.classList.add('recent-2');
  }
}

let scrollRafPending = false;
function scrollToBottom() {
  if (transcript.classList.contains('scrolled-up')) return;
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
    scrollRafPending = false;
  });
}

// Preserve scroll position during DOM mutations when user has scrolled up.
// Without this, element height changes (from analysis/upgrades) shift the viewport.
function preserveScroll(fn) {
  if (!transcript.classList.contains('scrolled-up')) return fn();
  const scrollBefore = transcript.scrollTop;
  fn();
  transcript.scrollTop = scrollBefore;
}

function addTranslation(lineEl, text) {
  const translationEl = lineEl.querySelector('.line-translation');
  if (translationEl) translationEl.textContent = text;
}

function applyEntityHighlighting(lineEl, originalText, entities) {
  const italianEl = lineEl.querySelector('.line-italian');
  if (!italianEl || !entities.length) return;
  italianEl.innerHTML = highlightEntitiesHtml(escapeHtml(originalText), entities);
}

function applyIdiomHighlighting(lineEl, originalText, idioms) {
  const italianEl = lineEl.querySelector('.line-italian');
  if (!italianEl || !idioms.length) return;
  // Get current HTML (may have entity spans already)
  italianEl.innerHTML = highlightIdiomsHtml(italianEl.innerHTML, idioms);
}

// --- WebSocket message handling ---

function handleEvent(event) {
  switch (event.type) {
    case 'transcription.text.delta':
      if (waitingEl) { waitingEl.remove(); waitingEl = null; }
      if (!activeLineEl) {
        activeLineEl = createLineElement(undefined, '', new Date().toISOString());
        updateLineClasses();
      }
      activeLineEl.querySelector('.line-italian').textContent += event.text;
      scrollToBottom();
      if (!errorBanner.classList.contains('hidden')) clearError();
      break;

    case 'transcription.done': {
      if (activeLineEl && event.lineId !== undefined) {
        activeLineEl.dataset.lineId = event.lineId;
        lineElements.set(event.lineId, activeLineEl);
        activeLineEl.querySelector('.line-italian').textContent = event.text;
        activeLineEl.classList.add('pending-analysis');
      }
      // Keep client-side session in sync for vocab panel
      if (currentSession && event.lineId !== undefined) {
        if (!currentSession.lines) currentSession.lines = [];
        currentSession.lines.push({
          lineId: event.lineId,
          text: event.text,
          timestamp: new Date().toISOString(),
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

    case 'analysis': {
      const el = lineElements.get(event.lineId);
      if (!el) break;
      preserveScroll(() => {
        el.classList.remove('pending-analysis');

        if (event.segments && event.segments.length) {
          applySegments(el, event.segments, event.entities, event.idioms);
        } else {
          if (event.translation) addTranslation(el, event.translation);
          if (event.entities && event.entities.length) {
            applyEntityHighlighting(el, event.text || el.querySelector('.line-italian').textContent, event.entities);
          }
          if (event.idioms && event.idioms.length) {
            applyIdiomHighlighting(el, el.querySelector('.line-italian').textContent, event.idioms);
          }
        }
      });
      // Track cost
      if (event.costUsd) {
        sessionCostUsd += event.costUsd;
        updateCostDisplay();
      }
      // Update in-memory session for vocab panel
      if (currentSession && currentSession.lines) {
        const line = currentSession.lines[event.lineId];
        if (line) {
          if (event.translation) line.translation = event.translation;
          if (event.entities) line.entities = event.entities;
          if (event.idioms) line.idioms = event.idioms;
        }
        if (event.idioms && event.idioms.length) renderVocab();
      }
      break;
    }

    case 'analysis.upgrade': {
      const el = lineElements.get(event.lineId);
      if (!el) break;

      // Check if line is in viewport
      const rect = el.getBoundingClientRect();
      const inViewport = rect.top < window.innerHeight && rect.bottom > 0;

      if (inViewport) {
        el.classList.add('upgrading');
        el.addEventListener('animationend', () => el.classList.remove('upgrading'), { once: true });
      }

      preserveScroll(() => {
        // Store phase 1 data before overwriting (for comparison UI)
        const p1Line = currentSession?.lines?.[event.lineId];
        const p1Text = p1Line?.text || el.querySelector('.line-italian')?.textContent || el.querySelector('.segment-italian')?.textContent || '';
        const p1Translation = p1Line?.translation || '';

        // Apply phase 2 segments/entities/idioms
        if (event.segments && event.segments.length) {
          applySegments(el, event.segments, event.entities, event.idioms);
        } else {
          if (event.text) {
            const italianEl = el.querySelector('.line-italian');
            if (italianEl) italianEl.textContent = event.text;
          }
          if (event.translation) addTranslation(el, event.translation);
          if (event.entities && event.entities.length) {
            applyEntityHighlighting(el, event.text || el.querySelector('.line-italian')?.textContent, event.entities);
          }
          if (event.idioms && event.idioms.length) {
            applyIdiomHighlighting(el, el.querySelector('.line-italian')?.textContent, event.idioms);
          }
        }

        // Add phase comparison UI
        el.classList.add('has-upgrade');
        if (!el.querySelector('.line-phase1')) {
          const phase1El = document.createElement('div');
          phase1El.className = 'line-phase1';
          phase1El.innerHTML = `<strong>Phase 1:</strong> ${escapeHtml(p1Text)}${p1Translation ? '<br><em>' + escapeHtml(p1Translation) + '</em>' : ''}`;
          el.appendChild(phase1El);

          const toggle = document.createElement('div');
          toggle.className = 'line-phase-toggle';
          toggle.textContent = 'P1 \u2194 P2';
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            el.classList.toggle('show-phase1');
          });
          // Insert toggle after timestamp
          const ts = el.querySelector('.line-timestamp');
          if (ts) ts.after(toggle);
          else el.prepend(toggle);
        }
      });

      // Track cost
      if (event.costUsd) {
        sessionCostUsd += event.costUsd;
        updateCostDisplay();
      }

      // Update in-memory session
      if (currentSession && currentSession.lines) {
        const line = currentSession.lines[event.lineId];
        if (line) {
          // Store phase 1 data before overwriting
          if (!line.phase1Text) line.phase1Text = line.text;
          if (!line.phase1Translation) line.phase1Translation = line.translation;
          if (event.text) line.text = event.text;
          if (event.translation) line.translation = event.translation;
          if (event.segments) line.segments = event.segments;
          if (event.entities) line.entities = event.entities;
          if (event.idioms) line.idioms = event.idioms;
        }
        if (event.idioms && event.idioms.length) renderVocab();
      }
      break;
    }

    case 'session.active': {
      // Skip if already loaded (initActiveSession may have run first)
      if (currentSession && currentSession.id === event.session.id) break;
      currentSession = event.session;
      sessionNameEl.textContent = event.session.name;
      sessionNameEl.classList.remove('hidden');
      editSessionBtn.classList.remove('hidden');
      emptyState.classList.add('hidden');
      renderSession(event.session);
      break;
    }

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

// --- Audio capture ---

async function start() {
  if (!currentSession) {
    showError('Create a session first');
    return;
  }

  // Wait for persistent WS to be ready (may be reconnecting)
  if (!persistentWs || persistentWs.readyState !== WebSocket.OPEN) {
    startBtn.disabled = true;
    const waitForWs = setInterval(() => {
      if (persistentWs && persistentWs.readyState === WebSocket.OPEN) {
        clearInterval(waitForWs);
        startBtn.disabled = false;
        start();
      }
    }, 500);
    setTimeout(() => { clearInterval(waitForWs); startBtn.disabled = false; showError('Not connected — please refresh'); }, 10000);
    return;
  }

  startBtn.disabled = true;

  try {
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

    audioContext = new AudioContext({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') await audioContext.resume();

    await audioContext.audioWorklet.addModule('/pcm-processor.js');

    source = audioContext.createMediaStreamSource(stream);
    pcmNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    source.connect(pcmNode);

    // Send audio via the persistent WebSocket
    pcmNode.port.onmessage = (e) => {
      if (persistentWs && persistentWs.readyState === WebSocket.OPEN && persistentWs.bufferedAmount < 65536) {
        persistentWs.send(e.data);
      }
    };

    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    statusEl.classList.remove('hidden');
    micSelect.disabled = true;
    transcript.classList.add('live');

    // Show waiting indicator until first transcription arrives
    waitingEl = document.createElement('div');
    waitingEl.className = 'waiting-indicator';
    waitingEl.textContent = 'Waiting for speech…';
    transcript.appendChild(waitingEl);
  } catch (err) {
    if (source) { source.mediaStream.getTracks().forEach(t => t.stop()); source = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    showError(
      err.name === 'NotAllowedError'
        ? 'Microphone access denied — check browser permissions'
        : `Error: ${err.message}`
    );
    startBtn.disabled = false;
  }
}

async function stop() {
  teardown();
  stopBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');
  startBtn.disabled = false;
  statusEl.classList.add('hidden');
  micSelect.disabled = false;
  transcript.classList.remove('live', 'scrolled-up');
  if (activeLineEl) {
    activeLineEl.classList.remove('active');
    activeLineEl = null;
  }
  updateLineClasses();

  // Don't end the session — user can resume with Start.
  // Session is ended explicitly via the sessions panel.
}

function teardown() {
  if (pcmNode) { pcmNode.port.onmessage = null; pcmNode.disconnect(); }
  if (source) { source.mediaStream.getTracks().forEach(t => t.stop()); source.disconnect(); }
  if (audioContext) audioContext.close();
  audioContext = null;
  source = null;
  pcmNode = null;
}

// --- Translation toggle ---

translationToggle.addEventListener('click', () => {
  document.body.classList.toggle('show-translations');
  translationToggle.classList.toggle('active');
});

// --- Tab switching ---

tabBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  const tab = btn.dataset.tab;

  tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(tab === 'vocab' ? 'vocab-panel' : 'transcript').classList.add('active');
});

// --- Vocab panel ---

// Collect idioms from all lines in the current session view
function collectVocab() {
  if (!currentSession) return [];
  const vocab = [];
  for (const line of currentSession.lines) {
    if (!line.idioms || !line.idioms.length) continue;
    for (const idiom of line.idioms) {
      vocab.push({
        expression: idiom.expression,
        meaning: idiom.meaning,
        context: line.text,
        timestamp: line.timestamp,
      });
    }
  }
  return vocab;
}

function renderVocab() {
  const vocab = collectVocab();
  if (!vocab.length) {
    vocabList.innerHTML = '<div class="vocab-empty">No vocabulary collected yet</div>';
    return;
  }

  vocabList.innerHTML = '';
  for (const item of vocab) {
    const el = document.createElement('div');
    el.className = 'vocab-item';
    el.innerHTML = `
      <div class="vocab-expression">${escapeHtml(item.expression)}</div>
      <div class="vocab-meaning">${escapeHtml(item.meaning)}</div>
      <div class="vocab-context">"…${escapeHtml(item.context.slice(0, 120))}${item.context.length > 120 ? '…' : ''}"</div>
      <div class="vocab-time">${formatElapsed(item.timestamp)}</div>
    `;
    vocabList.appendChild(el);
  }
}

// --- Utilities ---

// --- Cost display ---

function updateCostDisplay() {
  if (sessionCostUsd > 0) {
    costIndicator.textContent = `$${sessionCostUsd.toFixed(4)}`;
    costIndicator.classList.remove('hidden');
  }
}

function calculateSessionCost(session) {
  return (session.lines || []).reduce((sum, l) => sum + (l.costUsd || 0), 0);
}

const _escDiv = document.createElement('div');
function escapeHtml(str) {
  _escDiv.textContent = str;
  return _escDiv.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Scroll detection (un-dim on scroll up during live) ---

transcript.addEventListener('scroll', () => {
  if (!transcript.classList.contains('live')) return;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
  transcript.classList.toggle('scrolled-up', !atBottom);
});

// --- Tooltip flip (show below when near top) ---

document.addEventListener('mouseenter', (e) => {
  const idiom = e.target.closest('[data-idiom]');
  if (!idiom) return;
  const rect = idiom.getBoundingClientRect();
  idiom.classList.toggle('tooltip-below', rect.top < 100);
}, true);

// --- Keyboard shortcuts ---

document.addEventListener('keydown', (e) => {
  // Don't trigger when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (stopBtn.classList.contains('hidden')) { start(); } else { stop(); }
  } else if (e.key === 't' || e.key === 'T') {
    translationToggle.click();
  } else if (e.key === 'Escape') {
    closeSessions();
    closeEditContext();
  }
});

// --- Edit context modal ---

function openEditContext() {
  if (!currentSession) return;
  editContextName.value = currentSession.name || '';
  editContextTextarea.value = currentSession.context || '';
  editContextBackdrop.classList.add('open');
  editContextPanel.classList.add('open');
  editContextName.focus();
}

function closeEditContext() {
  editContextBackdrop.classList.remove('open');
  editContextPanel.classList.remove('open');
}

editSessionBtn.addEventListener('click', openEditContext);
editContextBackdrop.addEventListener('click', closeEditContext);
cancelContextBtn.addEventListener('click', closeEditContext);

saveContextBtn.addEventListener('click', async () => {
  if (!currentSession) return;
  const name = editContextName.value.trim() || currentSession.name;
  const context = editContextTextarea.value.trim();
  try {
    const res = await fetch(`/api/sessions/${currentSession.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, context: context || null }),
    });
    if (!res.ok) {
      const err = await res.json();
      showError(err.error || 'Failed to update session');
      return;
    }
    const updated = await res.json();
    currentSession.name = updated.name;
    currentSession.context = updated.context;
    sessionNameEl.textContent = updated.name;
    closeEditContext();
  } catch (err) {
    showError('Failed to update session');
  }
});

// --- Init ---

async function initActiveSession() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    const active = (data.sessions || []).find(s => !s.endedAt);
    if (active) {
      await loadSession(active.id);
    }
  } catch (err) {
    console.error('[capito] Failed to check active session:', err);
  }
}

// Persistent WebSocket — always connected, used for both viewing and sending audio
let persistentWs = null;

function connectPersistentWs() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  persistentWs = new WebSocket(`${wsProtocol}//${location.host}`);
  persistentWs.binaryType = 'arraybuffer';
  persistentWs.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.warn('[capito] WS parse error:', err.message); }
  };
  persistentWs.onclose = () => {
    persistentWs = null;
    setTimeout(connectPersistentWs, 3000);
  };
  persistentWs.onerror = () => {};
}

window.addEventListener('beforeunload', teardown);
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
loadDevices();
initActiveSession();
connectPersistentWs();
