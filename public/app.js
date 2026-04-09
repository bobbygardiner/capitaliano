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
const contextSearchToggle = document.getElementById('context-search-toggle');
const contextSearchLabel = document.getElementById('context-search-label');
const contentTypeSelect = document.getElementById('content-type-select');
const addTypeRow = document.getElementById('add-type-row');
const addTypeInput = document.getElementById('add-type-input');
const addTypeBtn = document.getElementById('add-type-btn');
const cancelTypeBtn = document.getElementById('cancel-type-btn');

// --- State ---
let currentSession = null;
let audioContext = null;
let source = null;
let pcmNode = null;
let activeLineEl = null;
let waitingEl = null;
let lineElements = new Map(); // lineId -> DOM element
let sessionCostUsd = 0;
let contentTypes = [];

// Saved vocab cache: lowercased expression -> true
const savedVocabSet = new Set();
let savedVocabCache = []; // full entries list, used by Saved Vocab view

function normalizeExpression(expression) {
  return String(expression || '').trim().toLowerCase();
}

async function loadSavedVocab() {
  try {
    const res = await fetch('/api/saved-vocab');
    const data = await res.json();
    savedVocabCache = data.entries || [];
    savedVocabSet.clear();
    for (const e of savedVocabCache) savedVocabSet.add(normalizeExpression(e.expression));
  } catch (err) {
    console.error('[capitaliano] Failed to load saved vocab:', err);
  }
}

// --- Content types ---

async function loadContentTypes() {
  try {
    const res = await fetch('/api/content-types');
    const data = await res.json();
    contentTypes = data.types || [];
    renderContentTypeSelect();
  } catch (err) {
    console.error('[capitaliano] Failed to load content types:', err);
  }
}

function renderContentTypeSelect() {
  contentTypeSelect.innerHTML = '';
  for (const type of contentTypes) {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.label;
    option.dataset.promptHint = type.promptHint;
    contentTypeSelect.appendChild(option);
  }
  const addOption = document.createElement('option');
  addOption.value = '__add_new__';
  addOption.textContent = '+ Add new...';
  contentTypeSelect.appendChild(addOption);
}

loadContentTypes();

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
    console.error('[capitaliano] Failed to load sessions:', err);
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
          console.error('[capitaliano] Failed to end session:', err);
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
          console.error('[capitaliano] Failed to delete session:', err);
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
    contextSearchToggle.checked = false;
    contextSearchLabel.textContent = 'Search for context';
    addTypeRow.classList.add('hidden');
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

contextSearchToggle.addEventListener('change', async () => {
  if (!contextSearchToggle.checked) return;
  const query = sessionNameInput.value.trim();
  if (!query) {
    contextSearchToggle.checked = false;
    return;
  }

  contextSearchLabel.textContent = 'Searching...';
  contextSearchLabel.classList.add('searching');
  contextSearchToggle.disabled = true;

  try {
    const res = await fetch('/api/context-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, promptHint: contentTypeSelect.selectedOptions[0]?.dataset.promptHint }),
    });
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    sessionContextInput.value = data.context;
    contextSearchLabel.textContent = `Context found ($${data.costUsd.toFixed(2)})`;
  } catch (err) {
    console.error('[capitaliano] Context search failed:', err);
    contextSearchLabel.textContent = 'Search failed';
    contextSearchToggle.checked = false;
  } finally {
    contextSearchLabel.classList.remove('searching');
    contextSearchToggle.disabled = false;
  }
});

contentTypeSelect.addEventListener('change', () => {
  if (contentTypeSelect.value === '__add_new__') {
    addTypeRow.classList.remove('hidden');
    addTypeInput.value = '';
    addTypeInput.focus();
    if (contentTypes.length > 0) {
      contentTypeSelect.value = contentTypes[0].id;
    }
  }
});

async function addContentType() {
  const label = addTypeInput.value.trim();
  if (!label) return;

  addTypeBtn.disabled = true;
  addTypeBtn.textContent = 'Adding...';

  try {
    const res = await fetch('/api/content-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add type');
    }
    const newType = await res.json();
    contentTypes.push(newType);
    renderContentTypeSelect();
    contentTypeSelect.value = newType.id;
    addTypeRow.classList.add('hidden');
  } catch (err) {
    console.error('[capitaliano] Failed to add content type:', err);
    addTypeInput.style.borderColor = 'var(--accent)';
    setTimeout(() => { addTypeInput.style.borderColor = ''; }, 2000);
  } finally {
    addTypeBtn.disabled = false;
    addTypeBtn.textContent = 'Add';
  }
}

addTypeBtn.addEventListener('click', addContentType);
addTypeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addContentType();
});
cancelTypeBtn.addEventListener('click', () => {
  addTypeRow.classList.add('hidden');
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
    const el = createLineElement(line.lineId, line.text, line.timestamp, line.audioOffsetSec);
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
    if (line.phase1Text) attachPhaseComparison(el, line.phase1Text, line.phase1Translation);
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
    console.error('[capitaliano] Device enumeration failed:', err);
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
  // Preserve timestamp and play button before clearing
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

  const container = document.createElement('div');
  container.className = 'line-segments';

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    // Add space between adjacent segment pairs
    if (si > 0) container.appendChild(document.createTextNode(' '));

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

function attachPhaseComparison(el, p1Text, p1Translation) {
  if (el.querySelector('.line-phase1')) return;
  el.classList.add('has-upgrade');
  const phase1El = document.createElement('div');
  phase1El.className = 'line-phase1';
  phase1El.innerHTML = `<strong>Phase 1:</strong> ${escapeHtml(p1Text)}${p1Translation ? '<br><em>' + escapeHtml(p1Translation) + '</em>' : ''}`;
  el.appendChild(phase1El);
  const toggle = document.createElement('div');
  toggle.className = 'line-phase-toggle';
  toggle.textContent = 'P1 \u2194 P2';
  toggle.addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('show-phase1'); });
  const ts = el.querySelector('.line-timestamp');
  if (ts) ts.after(toggle);
  else el.prepend(toggle);
}

function applyAnalysisToElement(el, event) {
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

    case 'analysis': {
      const el = lineElements.get(event.lineId);
      if (!el) break;
      preserveScroll(() => {
        el.classList.remove('pending-analysis');
        applyAnalysisToElement(el, event);
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
        // Store phase 1 data before overwriting
        const p1Line = currentSession?.lines?.[event.lineId];
        const p1Text = p1Line?.text ?? '';
        const p1Translation = p1Line?.translation ?? '';

        applyAnalysisToElement(el, event);
        attachPhaseComparison(el, p1Text, p1Translation);
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
      console.log('[capitaliano] Detected language:', event.audioLanguage);
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

const BUCKET_ORDER = ['advanced', 'intermediate', 'common', 'unbucketed'];
const BUCKET_LABEL = {
  advanced: 'Advanced',
  intermediate: 'Intermediate',
  common: 'Common',
  unbucketed: 'Unscored',
};

// Collect idioms from all lines in the current session view
function collectVocab() {
  if (!currentSession) return [];
  const vocab = [];
  // Iterating lines in array order preserves chronological ordering within
  // each bucket after groupVocabByBucket() runs.
  for (const line of currentSession.lines) {
    if (!line.idioms || !line.idioms.length) continue;
    for (const idiom of line.idioms) {
      vocab.push({
        expression: idiom.expression,
        meaning: idiom.meaning,
        bucket: idiom.bucket || 'unbucketed',
        context: line.text,
        timestamp: line.timestamp,
        lineId: line.lineId,
        audioOffsetSec: line.audioOffsetSec ?? null,
        hasAudio: line.audioOffsetSec != null,
      });
    }
  }
  return vocab;
}

function groupVocabByBucket(vocab) {
  const groups = { advanced: [], intermediate: [], common: [], unbucketed: [] };
  for (const item of vocab) {
    (groups[item.bucket] || groups.unbucketed).push(item);
  }
  return groups;
}

function buildContextQuote(text) {
  const snippet = text.slice(0, 120);
  const ellipsis = text.length > 120 ? '…' : '';
  return `…${snippet}${ellipsis}`;
}

function renderVocab() {
  const vocab = collectVocab();
  if (!vocab.length) {
    vocabList.innerHTML = '<div class="vocab-empty">No vocabulary collected yet</div>';
    return;
  }

  const groups = groupVocabByBucket(vocab);
  vocabList.innerHTML = '';

  for (const bucket of BUCKET_ORDER) {
    const items = groups[bucket];
    if (!items.length) continue;

    const label = document.createElement('div');
    label.className = 'level-group-label';
    label.textContent = BUCKET_LABEL[bucket];
    vocabList.appendChild(label);

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'vocab-item';
      const isSaved = savedVocabSet.has(normalizeExpression(item.expression));
      el.innerHTML = `
        <div class="vocab-expression-row">
          <div class="vocab-expression">
            <span class="bucket-dot bucket-${bucket}"></span>
            ${item.hasAudio ? '<span class="vocab-play-btn" title="Play audio">\u25B6</span> ' : ''}
            ${escapeHtml(item.expression)}
          </div>
          <button class="vocab-star-btn ${isSaved ? 'saved' : ''}" title="${isSaved ? 'Remove from saved' : 'Save vocab'}">${isSaved ? '★' : '☆'}</button>
        </div>
        <div class="vocab-meaning">${escapeHtml(item.meaning)}</div>
        <div class="vocab-context">"${escapeHtml(buildContextQuote(item.context))}"</div>
        <div class="vocab-time">${formatElapsed(item.timestamp)}</div>
      `;
      if (item.hasAudio) {
        el.querySelector('.vocab-play-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          playLineAudio(item.lineId);
        });
      }
      el.querySelector('.vocab-star-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSavedVocab(item, el.querySelector('.vocab-star-btn'));
      });
      vocabList.appendChild(el);
    }
  }
}

async function toggleSavedVocab(item, btn) {
  if (btn.dataset.pending === '1') return;
  btn.dataset.pending = '1';

  const key = normalizeExpression(item.expression);
  const wasSaved = savedVocabSet.has(key);

  // Optimistic update
  if (wasSaved) {
    savedVocabSet.delete(key);
  } else {
    savedVocabSet.add(key);
  }
  btn.classList.toggle('saved', !wasSaved);
  btn.textContent = wasSaved ? '☆' : '★';
  btn.title = wasSaved ? 'Save vocab' : 'Remove from saved';

  try {
    if (wasSaved) {
      const res = await fetch('/api/saved-vocab/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: item.expression }),
      });
      if (!res.ok) throw new Error('Remove failed');
      savedVocabCache = savedVocabCache.filter(e => normalizeExpression(e.expression) !== key);
    } else {
      const source = {
        sessionId: currentSession.id,
        sessionName: currentSession.name,
        lineId: item.lineId,
        contextQuote: buildContextQuote(item.context),
        audioOffsetSec: item.audioOffsetSec,
      };
      const res = await fetch('/api/saved-vocab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expression: item.expression,
          meaning: item.meaning,
          bucket: item.bucket === 'unbucketed' ? 'intermediate' : item.bucket,
          source,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      const existingIdx = savedVocabCache.findIndex(e => normalizeExpression(e.expression) === key);
      if (existingIdx >= 0) savedVocabCache[existingIdx] = data.entry;
      else savedVocabCache.unshift(data.entry);
    }
  } catch (err) {
    console.error('[capitaliano] toggleSavedVocab failed:', err);
    // Revert set state, then re-render to reconcile UI (handles stale DOM refs)
    if (wasSaved) savedVocabSet.add(key);
    else savedVocabSet.delete(key);
    renderVocab();
    alert('Failed to update saved vocab. Please try again.');
  } finally {
    // Clear pending guard if btn is still in the DOM
    if (btn && btn.isConnected) btn.dataset.pending = '';
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
    console.error('[capitaliano] Audio playback error:', err);
    stopAudioPlayback();
  }
}

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
    console.error('[capitaliano] Failed to check active session:', err);
  }
}

// Persistent WebSocket — always connected, used for both viewing and sending audio
let persistentWs = null;

function connectPersistentWs() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  persistentWs = new WebSocket(`${wsProtocol}//${location.host}`);
  persistentWs.binaryType = 'arraybuffer';
  persistentWs.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.warn('[capitaliano] WS parse error:', err.message); }
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
loadSavedVocab();
connectPersistentWs();
