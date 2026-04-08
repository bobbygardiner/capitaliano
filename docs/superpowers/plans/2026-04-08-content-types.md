# Content Type Selector — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a content type dropdown to the session creation form that customises the web search context prompt per content type, with an "Add new" flow for custom types.

**Architecture:** A `content-types.json` file stores preset and custom types. A new `lib/content-types.js` module handles CRUD + Haiku prompt hint generation. The frontend adds a `<select>` dropdown alongside the existing search toggle, and sends the selected type's `promptHint` with the search request. `lib/context-search.js` is updated to accept and use the prompt hint, with a generic `buildContextString` that handles arbitrary JSON shapes.

**Tech Stack:** `@anthropic-ai/sdk` (already installed), Claude Haiku 4.5, Node.js ESM, vanilla JS frontend

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `content-types.json` | Create | Preset content types data file |
| `lib/content-types.js` | Create | Load, list, add content types; Haiku prompt hint generation |
| `lib/context-search.js` | Modify | Accept `promptHint` param, update prompt template, make `buildContextString` generic |
| `server.js` | Modify | Add `GET/POST /api/content-types` routes, pass `promptHint` to `searchContext` |
| `public/index.html` | Modify | Add `<select>` dropdown, add-new inline form, CSS |
| `public/app.js` | Modify | Load types, wire dropdown, send `promptHint` with search |
| `test/content-types.test.js` | Create | Unit tests for content types module |

---

## Chunk 1: Backend

### Task 1: Create `content-types.json` and `lib/content-types.js`

**Files:**
- Create: `content-types.json`
- Create: `lib/content-types.js`
- Create: `test/content-types.test.js`

- [ ] **Step 1: Write test file**

```js
// test/content-types.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';

// Save and restore content-types.json around tests
const CT_PATH = 'content-types.json';
let originalContent;

before(async () => {
  try { originalContent = await readFile(CT_PATH, 'utf-8'); } catch { originalContent = null; }
});

after(async () => {
  if (originalContent !== null) {
    await writeFile(CT_PATH, originalContent);
  }
});

describe('content-types', () => {
  // Dynamic import so module reads the file fresh
  let mod;
  before(async () => {
    mod = await import('../lib/content-types.js');
  });

  it('exports list, add, and generatePromptHint functions', () => {
    assert.equal(typeof mod.list, 'function');
    assert.equal(typeof mod.add, 'function');
    assert.equal(typeof mod.generatePromptHint, 'function');
    assert.equal(typeof mod.slugify, 'function');
  });

  it('list returns the preset types', async () => {
    const types = await mod.list();
    assert.ok(Array.isArray(types));
    assert.ok(types.length >= 3);
    assert.ok(types.find(t => t.id === 'football-match'));
    assert.ok(types.find(t => t.id === 'general'));
  });

  it('slugify converts labels to kebab-case IDs', () => {
    assert.equal(mod.slugify('Football Match'), 'football-match');
    assert.equal(mod.slugify('Italian Cooking Show'), 'italian-cooking-show');
    assert.equal(mod.slugify('  Spaces  Everywhere  '), 'spaces-everywhere');
  });

  it('add rejects duplicate IDs', async () => {
    await assert.rejects(
      () => mod.add('Football Match'),
      { message: /already exists/ }
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/content-types.test.js`
Expected: FAIL — module does not exist

- [ ] **Step 3: Create `content-types.json`**

```json
[
  {
    "id": "football-match",
    "label": "Football Match",
    "promptHint": "full matchday squads (starting XI + bench), managers, competition, venue"
  },
  {
    "id": "football-podcast",
    "label": "Football Podcast",
    "promptHint": "host names, guest names, topics discussed, teams/players likely mentioned"
  },
  {
    "id": "general",
    "label": "General",
    "promptHint": "key people, topics, terminology, and proper nouns relevant to this content"
  }
]
```

- [ ] **Step 4: Create `lib/content-types.js`**

```js
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const CT_PATH = 'content-types.json';

let anthropic;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ maxRetries: 2, timeout: 30_000 });
  }
  return anthropic;
}

function slugify(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function list() {
  const data = await readFile(CT_PATH, 'utf-8');
  return JSON.parse(data);
}

async function add(label) {
  const id = slugify(label);
  const types = await list();
  if (types.find(t => t.id === id)) {
    throw new Error(`Content type "${id}" already exists`);
  }

  const promptHint = await generatePromptHint(label);
  const newType = { id, label: label.trim(), promptHint };
  types.push(newType);
  await writeFile(CT_PATH, JSON.stringify(types, null, 2));
  return newType;
}

async function generatePromptHint(label) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `Given a content type called "${label}", what specific context should I search for to help with live Italian transcription? Reply with ONLY a short comma-separated list of what to find (e.g. "host names, guest names, topics discussed"). No explanation, just the list.`,
      },
    ],
  });

  const text = response.content[0]?.text?.trim();
  if (!text) throw new Error('Failed to generate prompt hint');
  return text;
}

export { list, add, generatePromptHint, slugify };
```

- [ ] **Step 5: Run tests**

Run: `node --test test/content-types.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add content-types.json lib/content-types.js test/content-types.test.js
git commit -m "feat: add content types module with presets and CRUD"
```

---

### Task 2: Update `lib/context-search.js` — accept `promptHint`, make `buildContextString` generic

**Files:**
- Modify: `lib/context-search.js`
- Modify: `test/context-search.test.js`

- [ ] **Step 1: Add tests for the updated `buildContextString`**

Add to `test/context-search.test.js`, inside the `buildContextString` describe block:

```js
  it('handles non-football content with arbitrary keys', () => {
    const data = {
      show: 'Masterchef Italia',
      host: 'Bruno Barbieri',
      dishes: ['risotto', 'ossobuco'],
      ingredients: ['saffron', 'veal'],
    };

    const result = buildContextString(data);
    assert.ok(result.includes('Masterchef Italia'));
    assert.ok(result.includes('Bruno Barbieri'));
    assert.ok(result.includes('risotto'));
    assert.ok(result.includes('saffron'));
  });

  it('still handles football format with teams array', () => {
    const data = {
      match: 'Inter vs Roma',
      teams: [
        { name: 'Inter', squad: ['Lautaro', 'Barella'] },
      ],
    };

    const result = buildContextString(data);
    assert.ok(result.includes('Inter vs Roma'));
    assert.ok(result.includes('Inter: Lautaro, Barella'));
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/context-search.test.js`
Expected: The non-football test FAILs (current `buildContextString` ignores unknown keys)

- [ ] **Step 3: Update `lib/context-search.js`**

Replace the `PROMPT_TEMPLATE` with a function and update `searchContext` to accept `promptHint`:

```js
const DEFAULT_PROMPT_HINT = 'full matchday squads (starting XI + bench), managers, competition, venue';

function buildPrompt(query, promptHint) {
  const hint = promptHint || DEFAULT_PROMPT_HINT;
  return `I'm building context for a live Italian transcription tool.
Search for context about: "${query}"

Find: ${hint}

Return ONLY valid JSON. Adapt the structure to the content type. For example, a football match might use:
{
  "match": "...",
  "competition": "...",
  "venue": "...",
  "managers": ["..."],
  "teams": [{ "name": "...", "squad": ["..."] }]
}

But a cooking show might use:
{
  "show": "...",
  "host": "...",
  "dishes": ["..."],
  "ingredients": ["..."]
}

Use whatever fields best capture the context for this content type.
Use names as they would appear on official sources.
Do not include generic vocabulary or anything not sourced from the web search.`;
}
```

Update `searchContext` signature to `async function searchContext(query, promptHint)` and use `buildPrompt(query, promptHint)` instead of `PROMPT_TEMPLATE.replace(...)`.

Replace `buildContextString` with a generic version:

```js
function buildContextString(data) {
  const lines = [];
  const handled = new Set();

  // Known football fields first (for backward compatibility)
  if (data.match) { lines.push(data.match); handled.add('match'); }
  if (data.competition) { lines.push(data.competition); handled.add('competition'); }
  if (data.venue) { lines.push(`Venue: ${data.venue}`); handled.add('venue'); }
  if (data.date) { lines.push(`Date: ${data.date}`); handled.add('date'); }
  if (data.managers?.length) { lines.push(`Managers: ${data.managers.join(', ')}`); handled.add('managers'); }
  if (data.teams?.length) {
    lines.push('');
    for (const team of data.teams) {
      lines.push(`${team.name}: ${team.squad.join(', ')}`);
    }
    handled.add('teams');
  }

  // Generic fallback for any other keys
  for (const [key, value] of Object.entries(data)) {
    if (handled.has(key)) continue;
    const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
    if (Array.isArray(value)) {
      lines.push(`${label}: ${value.join(', ')}`);
    } else if (typeof value === 'string') {
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/context-search.test.js`
Expected: All PASS (including new tests)

- [ ] **Step 5: Commit**

```bash
git add lib/context-search.js test/context-search.test.js
git commit -m "feat: accept promptHint in context search, make buildContextString generic"
```

---

### Task 3: Add `GET/POST /api/content-types` routes + update context-search route

**Files:**
- Modify: `server.js:15` (import), `server.js:79-91` (routes)

- [ ] **Step 1: Add import**

After line 15 (`import { searchContext, buildContextString } from './lib/context-search.js';`), add:

```js
import * as contentTypes from './lib/content-types.js';
```

- [ ] **Step 2: Add content-types routes**

After the `POST /api/sessions` route (after line 78), before the `/api/context-search` route:

```js
      if (urlPath === '/api/content-types' && req.method === 'GET') {
        const types = await contentTypes.list();
        return sendJson(res, 200, { types });
      }

      if (urlPath === '/api/content-types' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.label?.trim()) return sendJson(res, 400, { error: 'label is required' });
        try {
          const type = await contentTypes.add(body.label);
          return sendJson(res, 201, type);
        } catch (err) {
          if (err.message.includes('already exists')) {
            return sendJson(res, 409, { error: err.message });
          }
          console.error('[capitaliano] Content type creation failed:', err.message);
          return sendJson(res, 502, { error: err.message });
        }
      }
```

- [ ] **Step 3: Update the context-search route to pass `promptHint`**

Change line 84 from:

```js
          const { data, costUsd } = await searchContext(body.query);
```

to:

```js
          const { data, costUsd } = await searchContext(body.query, body.promptHint);
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add content-types API routes, pass promptHint to context search"
```

---

## Chunk 2: Frontend

### Task 4: Add dropdown + add-new form to HTML

**Files:**
- Modify: `public/index.html:993-1001` (form HTML), `public/index.html` (CSS)

- [ ] **Step 1: Replace the context-search-row in index.html**

Replace lines 995-1001 (the existing `context-search-row` div) with:

```html
      <div class="context-search-row">
        <select id="content-type-select" class="content-type-select">
          <option value="">Loading...</option>
        </select>
        <label class="context-search-toggle">
          <input type="checkbox" id="context-search-toggle" />
          <span class="toggle-slider"></span>
        </label>
        <span class="context-search-label" id="context-search-label">Search for context</span>
      </div>
      <div id="add-type-row" class="add-type-row hidden">
        <input type="text" id="add-type-input" placeholder="e.g. Opera, Cooking Show" />
        <button id="add-type-btn">Add</button>
        <button id="cancel-type-btn" class="secondary-btn">Cancel</button>
      </div>
```

- [ ] **Step 2: Add CSS**

Add after the existing `.context-search-label.searching` rule (after line 804):

```css
    .content-type-select {
      font-family: inherit;
      font-size: 12px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      flex-shrink: 0;
    }

    .content-type-select:focus {
      border-color: var(--text);
      outline: none;
    }

    .add-type-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }

    .add-type-row input {
      flex: 1;
      font-family: inherit;
      font-size: 12px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
    }

    .add-type-row input:focus {
      border-color: var(--text);
      outline: none;
    }

    .add-type-row button {
      font-family: inherit;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid var(--border);
    }

    .add-type-row #add-type-btn {
      background: var(--text);
      color: var(--bg);
      border-color: var(--text);
    }
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add content type dropdown and add-new form to session creation"
```

---

### Task 5: Wire dropdown and add-new flow in app.js

**Files:**
- Modify: `public/app.js:32-33` (DOM refs), `public/app.js:35` (state), `public/app.js:166-174` (form reset), `public/app.js:212-241` (search handler)

- [ ] **Step 1: Add DOM refs and state**

After line 33 (`const contextSearchLabel = ...`), add:

```js
const contentTypeSelect = document.getElementById('content-type-select');
const addTypeRow = document.getElementById('add-type-row');
const addTypeInput = document.getElementById('add-type-input');
const addTypeBtn = document.getElementById('add-type-btn');
const cancelTypeBtn = document.getElementById('cancel-type-btn');
```

After line 43 (`let sessionCostUsd = 0;`), add:

```js
let contentTypes = [];
```

- [ ] **Step 2: Add content types loading function**

After the state variables section (around line 45), add:

```js
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
```

- [ ] **Step 3: Wire the dropdown change handler and add-new flow**

After the `contextSearchToggle.addEventListener` block (after line ~241), add:

```js
contentTypeSelect.addEventListener('change', () => {
  if (contentTypeSelect.value === '__add_new__') {
    addTypeRow.classList.remove('hidden');
    addTypeInput.value = '';
    addTypeInput.focus();
    // Reset select to previous value so it doesn't stay on "+ Add new..."
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
```

- [ ] **Step 4: Update the search toggle handler to send `promptHint`**

In the `contextSearchToggle.addEventListener('change', ...)` handler, update the fetch body. Change:

```js
      body: JSON.stringify({ query }),
```

to:

```js
      body: JSON.stringify({ query, promptHint: contentTypeSelect.selectedOptions[0]?.dataset.promptHint }),
```

- [ ] **Step 5: Reset add-type-row when form opens**

In the `newSessionBtn` click handler (line ~168), inside the `if` block, after `contextSearchLabel.textContent = 'Search for context';`, add:

```js
    addTypeRow.classList.add('hidden');
```

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: wire content type dropdown, add-new flow, and promptHint to search"
```

---

### Task 6: Final test run and verification

- [ ] **Step 1: Run all tests**

Run: `node --test test/content-types.test.js test/context-search.test.js test/sessions.test.js test/translate.test.js test/audio.test.js test/batch.test.js test/audio-endpoint.test.js`
Expected: All pass

- [ ] **Step 2: Manual end-to-end test**

1. Start server: `node server.js`
2. Open `http://localhost:3000`
3. Click sessions → "+ New"
4. Verify dropdown shows: Football Match, Football Podcast, General, + Add new...
5. Select "Football Match", type "Inter vs Napoli", toggle search → verify squads populate
6. Select "+ Add new...", type "Opera", click "Add" → verify it appears in dropdown
7. Select the new "Opera" type, type "La Traviata, Teatro alla Scala", toggle search → verify relevant opera context

- [ ] **Step 3: Commit any final changes**

```bash
git add -A
git commit -m "chore: final cleanup for content types feature"
```
