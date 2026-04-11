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

let currentView = 'session'; // 'session' | 'saved-vocab'
const sidebarSavedVocabBtn = document.getElementById('sidebar-saved-vocab');
const sidebarSavedVocabCount = document.getElementById('sidebar-saved-vocab-count');
const savedVocabView = document.getElementById('saved-vocab-view');
const topBar = document.querySelector('.top-bar');

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
let sessionsById = new Map();

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
    updateSavedVocabCount();
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
    sessionsById = new Map((data.sessions || []).map(s => [s.id, s]));
    renderSessionsList(data.sessions || []);
    if (currentView === 'saved-vocab') renderSavedVocab();
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
          sessionDataCache.delete(s.id);
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
  if (currentView === 'saved-vocab') showSessionView();
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

function formatTrimTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
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

    // Look up the line object to check for existing trim
    const lineObj = currentSession?.lines?.find(l => l.lineId === lineId);
    const trimBtn = document.createElement('span');
    trimBtn.className = 'line-trim-btn' + (lineObj?.trimStartSec != null ? ' trimmed' : '');
    trimBtn.dataset.lineId = lineId;
    trimBtn.textContent = '\u2702';
    trimBtn.title = 'Trim audio clip';
    trimBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentSession) return;
      openTrimModal({ type: 'line', sessionId: currentSession.id, lineId, session: currentSession });
    });
    ts.appendChild(trimBtn);
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

// --- View switching (session vs saved-vocab) ---

function showSavedVocabView() {
  currentView = 'saved-vocab';
  sidebarSavedVocabBtn.classList.add('active');
  transcript.classList.remove('active');
  document.getElementById('vocab-panel').classList.remove('active');
  tabBar.classList.add('hidden');
  savedVocabView.classList.remove('hidden');
  topBar.classList.add('view-saved-vocab');
  closeSessions();
  renderSavedVocab();
}

function showSessionView() {
  currentView = 'session';
  sidebarSavedVocabBtn.classList.remove('active');
  tabBar.classList.remove('hidden');
  savedVocabView.classList.add('hidden');
  topBar.classList.remove('view-saved-vocab');

  // Restore whichever tab was active
  const activeTab = tabBar.querySelector('.tab-btn.active');
  const tabName = activeTab?.dataset.tab || 'transcript';
  document.getElementById(tabName === 'vocab' ? 'vocab-panel' : 'transcript').classList.add('active');
}

sidebarSavedVocabBtn.addEventListener('click', showSavedVocabView);

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

let vocabSearch = '';
let vocabFilter = 'all';

function renderVocab() {
  const allVocab = collectVocab();
  if (!allVocab.length) {
    vocabList.innerHTML = '<div class="vocab-empty">No vocabulary collected yet</div>';
    return;
  }

  const search = vocabSearch.trim().toLowerCase();
  const vocab = allVocab.filter(item => {
    if (vocabFilter !== 'all' && item.bucket !== vocabFilter) return false;
    if (!search) return true;
    return item.expression.toLowerCase().includes(search) ||
           (item.meaning || '').toLowerCase().includes(search);
  });

  if (!vocab.length) {
    vocabList.innerHTML = '<div class="vocab-empty">No matches for the current filter</div>';
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
            ${item.hasAudio ? '<span class="vocab-play-btn" title="Play audio">\u25B6</span><span class="vocab-trim-btn" data-line-id="' + item.lineId + '" title="Trim audio">\u2702</span> ' : ''}
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
        const trimBtnEl = el.querySelector('.vocab-trim-btn');
        if (trimBtnEl) {
          trimBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!currentSession) return;
            openTrimModal({ type: 'line', sessionId: currentSession.id, lineId: item.lineId, session: currentSession });
          });
        }
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
      updateSavedVocabCount();
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
      updateSavedVocabCount();
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

function updateSavedVocabCount() {
  sidebarSavedVocabCount.textContent = savedVocabCache.length;
}

let savedVocabSearch = '';
let savedVocabFilter = 'all';

function renderSavedVocab() {
  const listEl = document.getElementById('saved-vocab-list');
  const countEl = document.querySelector('.saved-vocab-count');

  const search = savedVocabSearch.trim().toLowerCase();
  const entries = savedVocabCache.filter(e => {
    if (savedVocabFilter !== 'all' && e.bucket !== savedVocabFilter) return false;
    if (!search) return true;
    return e.expression.toLowerCase().includes(search) ||
           (e.meaning || '').toLowerCase().includes(search);
  });

  // Count across all (unfiltered) entries for the header
  const totalEntries = savedVocabCache.length;
  const sessionIds = new Set();
  for (const e of savedVocabCache) {
    for (const s of e.sources || []) sessionIds.add(s.sessionId);
  }
  countEl.textContent = `${totalEntries} phrase${totalEntries === 1 ? '' : 's'} across ${sessionIds.size} session${sessionIds.size === 1 ? '' : 's'}`;

  if (!entries.length) {
    listEl.innerHTML = totalEntries === 0
      ? '<div class="saved-vocab-empty">No saved vocab yet — save phrases from the Vocab tab.</div>'
      : '<div class="saved-vocab-empty">No matches for the current filter.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'saved-vocab-row';

    const sources = entry.sources || [];
    const firstSource = sources[0];
    const contextQuote = firstSource?.contextQuote || '';
    const sourceLine = formatSavedVocabSource(sources);
    const hasAudio = firstSource && firstSource.audioOffsetSec != null && sessionsById.has(firstSource.sessionId);

    row.innerHTML = `
      <div>
        <div class="saved-vocab-expr">
          <span class="bucket-dot bucket-${entry.bucket || 'intermediate'}"></span>
          ${escapeHtml(entry.expression)}
        </div>
        <div class="saved-vocab-meaning">${escapeHtml(entry.meaning || '')}</div>
        ${contextQuote ? `<div class="saved-vocab-ctx">"${escapeHtml(contextQuote)}"</div>` : ''}
        <div class="saved-vocab-source">${sourceLine}</div>
      </div>
      <div class="saved-vocab-actions">
        ${hasAudio ? '<button class="saved-vocab-play-btn" title="Play audio">\u25B6</button><button class="saved-vocab-trim-btn' + (firstSource.trimStartSec != null ? ' trimmed' : '') + '" data-vocab-id="' + entry.id + '" title="Trim audio">\u2702</button>' : ''}
        <button class="vocab-star-btn saved" title="Remove from saved">★</button>
      </div>
    `;

    row.querySelector('.vocab-star-btn').addEventListener('click', async () => {
      await removeSavedVocabEntry(entry);
    });

    if (hasAudio) {
      const playBtn = row.querySelector('.saved-vocab-play-btn');
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playSavedVocabAudio(firstSource, playBtn);
      });
      const trimBtnEl = row.querySelector('.saved-vocab-trim-btn');
      if (trimBtnEl) {
        trimBtnEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const session = await loadSessionCached(firstSource.sessionId);
            openTrimModal({
              type: 'vocab',
              sessionId: firstSource.sessionId,
              lineId: firstSource.lineId,
              session,
              vocabId: entry.id,
              source: firstSource,
            });
          } catch (err) {
            console.error('[capitaliano] Trim modal error:', err);
          }
        });
      }
    }

    listEl.appendChild(row);
  }
}

function formatSavedVocabSource(sources) {
  if (!sources.length) return '';
  if (sources.length === 1) {
    const s = sources[0];
    const name = sessionsById.has(s.sessionId) ? s.sessionName : `${s.sessionName || 'Unknown session'} (session removed)`;
    return `from <strong>${escapeHtml(name)}</strong>`;
  }
  const names = sources.map(s => {
    const base = s.sessionName || 'Unknown session';
    return sessionsById.has(s.sessionId) ? base : `${base} (removed)`;
  });
  const title = escapeAttr(names.join(', '));
  return `from <strong title="${title}">${sources.length} sessions</strong>`;
}

async function removeSavedVocabEntry(entry) {
  const key = normalizeExpression(entry.expression);
  try {
    const res = await fetch('/api/saved-vocab/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: entry.expression }),
    });
    if (!res.ok) throw new Error('Remove failed');
    savedVocabCache = savedVocabCache.filter(e => normalizeExpression(e.expression) !== key);
    savedVocabSet.delete(key);
    updateSavedVocabCount();
    renderSavedVocab();
    // Also refresh the session-level Vocab tab so its star updates
    if (currentSession) renderVocab();
  } catch (err) {
    console.error('[capitaliano] removeSavedVocabEntry failed:', err);
    alert('Failed to remove saved vocab. Please try again.');
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
let currentBlobUrl = null;
let playingKey = null; // unique identifier for the currently-playing line (e.g. "session:<lineId>" or "saved:<sessionId>:<lineId>")
let playingBtn = null; // DOM ref for the play button currently showing ■; reset by stopAudioPlayback

// --- Trim modal state ---
let trimModalOpen = false;
let trimAudioEl = null;
let trimBlobUrl = null;
let trimContext = null; // { type, sessionId, lineId, session, vocabId, source, defaultFrom, defaultTo, bufferStart, bufferEnd }
let trimStart = 0;
let trimEnd = 0;
let trimAnimFrame = null;

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
  if (playingBtn && playingBtn.isConnected) {
    playingBtn.textContent = '\u25B6';
    playingBtn.classList.remove('playing');
  }
  playingBtn = null;
  playingKey = null;
}

// Cache loaded sessions so repeat plays are instant
const sessionDataCache = new Map();
async function loadSessionCached(sessionId) {
  if (sessionDataCache.has(sessionId)) return sessionDataCache.get(sessionId);
  const res = await fetch(`/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Failed to load session ${sessionId}`);
  const session = await res.json();
  sessionDataCache.set(sessionId, session);
  return session;
}

function getEffectiveTrim(lineId, session, overrides = {}) {
  const lines = session.lines || [];
  const idx = lines.findIndex(l => l.lineId === lineId);
  if (idx === -1) return null;
  const line = lines[idx];
  const prevLine = idx > 0 ? lines[idx - 1] : null;

  const trimStart = overrides.trimStartSec ?? line.trimStartSec;
  const trimEnd = overrides.trimEndSec ?? line.trimEndSec;

  return {
    from: trimStart != null ? trimStart : (prevLine?.audioOffsetSec ?? 0),
    to:   trimEnd != null   ? trimEnd   : line.audioOffsetSec,
  };
}

// --- Trim modal ---

async function openTrimModal({ type, sessionId, lineId, session, vocabId, source }) {
  stopAudioPlayback(); // stop any current playback

  const defaultTrim = getEffectiveTrim(lineId, session, source || {});
  if (!defaultTrim || defaultTrim.to == null) return;

  const totalDuration = session.totalDurationSec || defaultTrim.to + 30;
  const bufferStart = Math.max(0, defaultTrim.from - 30);
  const bufferEnd = Math.min(totalDuration, defaultTrim.to + 30);

  // Determine current trim (saved values or defaults)
  const currentOverrides = source || session.lines.find(l => l.lineId === lineId) || {};
  const hasSavedTrim = currentOverrides.trimStartSec != null;
  trimStart = hasSavedTrim ? currentOverrides.trimStartSec : defaultTrim.from;
  trimEnd = hasSavedTrim ? currentOverrides.trimEndSec : defaultTrim.to;

  trimContext = {
    type, sessionId, lineId, session, vocabId: vocabId || null,
    source: source || null,
    defaultFrom: defaultTrim.from, defaultTo: defaultTrim.to,
    bufferStart, bufferEnd,
  };

  // Fetch audio for buffer range
  try {
    const res = await fetch(`/api/sessions/${sessionId}/audio?from=${bufferStart}&to=${bufferEnd}`);
    if (!res.ok) throw new Error('Audio fetch failed');
    const blob = await res.blob();
    trimBlobUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.error('[capitaliano] Trim audio fetch error:', err);
    return;
  }

  // Set up audio element
  if (!trimAudioEl) {
    trimAudioEl = new Audio();
    trimAudioEl.addEventListener('timeupdate', onTrimTimeUpdate);
  }
  trimAudioEl.src = trimBlobUrl;

  // Populate modal text
  const line = session.lines.find(l => l.lineId === lineId);
  const lineText = line?.text || '';
  const truncText = lineText.length > 40 ? lineText.slice(0, 40) + '...' : lineText;
  const quote = source?.contextQuote || '';

  if (type === 'vocab' && quote) {
    document.getElementById('trimTitle').textContent = `Trim: "${quote.length > 40 ? quote.slice(0, 40) + '...' : quote}"`;
  } else {
    document.getElementById('trimTitle').textContent = `Trim: Line ${lineId}${truncText ? ': "' + truncText + '"' : ''}`;
  }
  document.getElementById('trimSessionName').textContent = session.name || '';
  document.getElementById('trimContextLabel').textContent =
    type === 'vocab' && quote ? `Edit clip for "${quote.length > 50 ? quote.slice(0, 50) + '...' : quote}"` :
    type === 'vocab' ? 'Edit clip for this vocab item' :
    'Edit clip for this line';

  document.getElementById('trimRangeStart').textContent = formatTrimTime(bufferStart);
  document.getElementById('trimRangeEnd').textContent = formatTrimTime(bufferEnd);

  updateTrimUI();

  // Open modal
  document.getElementById('trimBackdrop').classList.add('open');
  document.getElementById('trimPanel').classList.add('open');
  trimModalOpen = true;
}

function closeTrimModal() {
  document.getElementById('trimBackdrop').classList.remove('open');
  document.getElementById('trimPanel').classList.remove('open');
  trimModalOpen = false;

  if (trimAudioEl) {
    trimAudioEl.pause();
    trimAudioEl.removeAttribute('src');
  }
  if (trimBlobUrl) {
    URL.revokeObjectURL(trimBlobUrl);
    trimBlobUrl = null;
  }
  if (trimAnimFrame) {
    cancelAnimationFrame(trimAnimFrame);
    trimAnimFrame = null;
  }
  trimContext = null;
}

function updateTrimUI() {
  if (!trimContext) return;
  const { bufferStart, bufferEnd, defaultFrom, defaultTo } = trimContext;
  const range = bufferEnd - bufferStart;
  if (range <= 0) return;

  const toPercent = (sec) => ((sec - bufferStart) / range) * 100;

  // Default region
  const defRegion = document.getElementById('trimDefaultRegion');
  defRegion.style.left = toPercent(defaultFrom) + '%';
  defRegion.style.width = (toPercent(defaultTo) - toPercent(defaultFrom)) + '%';

  // Selected region
  const selRegion = document.getElementById('trimSelectedRegion');
  selRegion.style.left = toPercent(trimStart) + '%';
  selRegion.style.width = (toPercent(trimEnd) - toPercent(trimStart)) + '%';

  // Handles
  document.getElementById('trimHandleStart').style.left = `calc(${toPercent(trimStart)}% - 3px)`;
  document.getElementById('trimHandleEnd').style.left = `calc(${toPercent(trimEnd)}% - 3px)`;

  // Time displays
  document.getElementById('trimTimeStart').textContent = formatTrimTime(trimStart);
  document.getElementById('trimTimeEnd').textContent = formatTrimTime(trimEnd);
}

function initTrimDrag(handleId, isStart) {
  const handle = document.getElementById(handleId);
  const scrubber = document.getElementById('trimScrubber');

  function onPointerMove(e) {
    const rect = scrubber.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const { bufferStart, bufferEnd } = trimContext;
    const sec = bufferStart + (x / rect.width) * (bufferEnd - bufferStart);

    if (isStart) {
      trimStart = Math.max(bufferStart, Math.min(sec, trimEnd - 0.5));
    } else {
      trimEnd = Math.max(trimStart + 0.5, Math.min(sec, bufferEnd));
    }
    updateTrimUI();
  }

  function onPointerUp() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}

function onTrimTimeUpdate() {
  if (!trimContext || !trimAudioEl) return;
  const { bufferStart, bufferEnd } = trimContext;
  const currentSec = bufferStart + trimAudioEl.currentTime;
  const range = bufferEnd - bufferStart;
  const percent = ((currentSec - bufferStart) / range) * 100;
  document.getElementById('trimPlayhead').style.left = percent + '%';
  document.getElementById('trimTimePlayhead').textContent = '\u25B6 ' + formatTrimTime(currentSec);

  // Pause at trim end
  if (currentSec >= trimEnd) {
    trimAudioEl.pause();
  }
}

function onTrimPlay() {
  if (!trimAudioEl || !trimContext) return;
  const { bufferStart } = trimContext;
  if (trimAudioEl.paused) {
    trimAudioEl.currentTime = trimStart - bufferStart;
    trimAudioEl.play();
  } else {
    trimAudioEl.pause();
  }
}

function onTrimReset() {
  if (!trimContext) return;
  trimStart = trimContext.defaultFrom;
  trimEnd = trimContext.defaultTo;
  updateTrimUI();
}

async function onTrimSave() {
  if (!trimContext) return;
  const { type, sessionId, lineId, vocabId, source, session } = trimContext;

  try {
    if (type === 'line') {
      const res = await fetch(`/api/sessions/${sessionId}/lines/${lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trimStartSec: trimStart, trimEndSec: trimEnd }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Update in-memory session data
      const line = session.lines.find(l => l.lineId === lineId);
      if (line) { line.trimStartSec = trimStart; line.trimEndSec = trimEnd; }
      // Invalidate cache so next load gets fresh data
      sessionDataCache.delete(sessionId);
    } else if (type === 'vocab') {
      const res = await fetch(`/api/saved-vocab/${vocabId}/trim`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, lineId, trimStartSec: trimStart, trimEndSec: trimEnd }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Update in-memory source
      if (source) { source.trimStartSec = trimStart; source.trimEndSec = trimEnd; }
    }
  } catch (err) {
    console.error('[capitaliano] Trim save error:', err);
    return; // Don't close on error
  }

  updateTrimIcons();
  closeTrimModal();
}

function updateTrimIcons() {
  // Transcript line trim icons
  document.querySelectorAll('.line-trim-btn').forEach(btn => {
    const lid = parseInt(btn.dataset.lineId, 10);
    const line = currentSession?.lines?.find(l => l.lineId === lid);
    btn.classList.toggle('trimmed', line?.trimStartSec != null);
  });
  // In-session vocab panel trim icons (these trim the parent line)
  document.querySelectorAll('.vocab-trim-btn').forEach(btn => {
    const lid = parseInt(btn.dataset.lineId, 10);
    if (isNaN(lid)) return;
    const line = currentSession?.lines?.find(l => l.lineId === lid);
    btn.classList.toggle('trimmed', line?.trimStartSec != null);
  });
  // Saved vocab trim icons
  document.querySelectorAll('.saved-vocab-trim-btn').forEach(btn => {
    const vid = btn.dataset.vocabId;
    if (!vid) return;
    const entry = savedVocabCache?.find(e => e.id === vid);
    const hasTrim = entry?.sources?.some(s => s.trimStartSec != null);
    btn.classList.toggle('trimmed', !!hasTrim);
  });
}

// Shared audio playback: plays the audio range for a single line within the
// given session, handling stop-toggle and button state. `key` uniquely
// identifies this playback context so repeated clicks toggle rather than restart.
async function playLineRange(session, lineId, btn, key, overrides = {}) {
  if (playingKey === key) {
    stopAudioPlayback();
    return;
  }
  stopAudioPlayback();

  const trim = getEffectiveTrim(lineId, session, overrides);
  if (!trim || trim.to == null) return;
  const { from, to } = trim;

  try {
    const res = await fetch(`/api/sessions/${session.id}/audio?from=${from}&to=${to}`);
    if (!res.ok) return;
    const blob = await res.blob();
    currentBlobUrl = URL.createObjectURL(blob);

    const audio = getAudioElement();
    audio.src = currentBlobUrl;
    playingKey = key;
    playingBtn = btn;
    if (btn) {
      btn.textContent = '\u25A0';
      btn.classList.add('playing');
    }

    await audio.play();
  } catch (err) {
    console.error('[capitaliano] Audio playback error:', err);
    stopAudioPlayback();
  }
}

async function playLineAudio(lineId) {
  if (!currentSession) return;
  const btn = lineElements.get(lineId)?.querySelector('.line-play-btn') ?? null;
  await playLineRange(currentSession, lineId, btn, `session:${lineId}`);
}

async function playSavedVocabAudio(source, btn) {
  try {
    const session = await loadSessionCached(source.sessionId);
    await playLineRange(session, source.lineId, btn, `saved:${source.sessionId}:${source.lineId}`, source);
  } catch (err) {
    console.error('[capitaliano] Saved vocab audio error:', err);
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
loadSessionsList();
loadSavedVocab();

// Debounce trailing-edge: avoid rebuilding a 300+ item vocab list on every keystroke
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const SEARCH_DEBOUNCE_MS = 120;

const savedVocabSearchInput = document.getElementById('saved-vocab-search');
savedVocabSearchInput.addEventListener('input', debounce(() => {
  savedVocabSearch = savedVocabSearchInput.value;
  renderSavedVocab();
}, SEARCH_DEBOUNCE_MS));

document.querySelectorAll('#saved-vocab-view .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#saved-vocab-view .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    savedVocabFilter = chip.dataset.bucket;
    renderSavedVocab();
  });
});

const vocabSearchInput = document.getElementById('vocab-search');
vocabSearchInput.addEventListener('input', debounce(() => {
  vocabSearch = vocabSearchInput.value;
  renderVocab();
}, SEARCH_DEBOUNCE_MS));

document.querySelectorAll('#vocab-panel .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#vocab-panel .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    vocabFilter = chip.dataset.bucket;
    renderVocab();
  });
});

// Trim modal event listeners
document.getElementById('trimBackdrop').addEventListener('click', closeTrimModal);
document.getElementById('trimCancelBtn').addEventListener('click', closeTrimModal);
document.getElementById('trimPlayBtn').addEventListener('click', onTrimPlay);
document.getElementById('trimResetBtn').addEventListener('click', onTrimReset);
document.getElementById('trimSaveBtn').addEventListener('click', onTrimSave);
initTrimDrag('trimHandleStart', true);
initTrimDrag('trimHandleEnd', false);

connectPersistentWs();
