# Web Search Context Biasing — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Search for context" toggle to session creation that uses Claude Haiku with web search to auto-populate match/event context.

**Architecture:** New `lib/context-search.js` module makes a single Haiku API call with `web_search` tool. The server exposes a new `POST /api/context-search` endpoint. The frontend adds a toggle + loading state to the session creation form, calls the endpoint, and populates the context textarea with the result.

**Tech Stack:** `@anthropic-ai/sdk` (already installed), Claude Haiku 4.5, `web_search_20260209` server-side tool

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/context-search.js` | Create | Haiku + web search call, prompt template, JSON extraction |
| `server.js` | Modify | Add `POST /api/context-search` route |
| `public/index.html` | Modify | Add toggle switch + loading state to session form |
| `public/app.js` | Modify | Wire toggle to API call, populate textarea |
| `test/context-search.test.js` | Create | Unit tests for context search module |

---

## Chunk 1: Backend

### Task 1: Create `lib/context-search.js`

**Files:**
- Create: `lib/context-search.js`
- Test: `test/context-search.test.js`

- [ ] **Step 1: Write the test file**

```js
// test/context-search.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchContext, buildContextString } from '../lib/context-search.js';

describe('searchContext', () => {
  it('is exported as a function', () => {
    assert.equal(typeof searchContext, 'function');
  });
});

describe('buildContextString', () => {
  it('formats structured context into a plain text string', () => {
    const data = {
      match: 'PSG vs Liverpool',
      competition: 'Champions League QF',
      venue: 'Parc des Princes',
      date: '2026-04-08',
      managers: ['Luis Enrique', 'Arne Slot'],
      teams: [
        { name: 'PSG', squad: ['Safonov', 'Hakimi', 'Marquinhos'] },
        { name: 'Liverpool', squad: ['Mamardashvili', 'Van Dijk', 'Salah'] },
      ],
    };

    const result = buildContextString(data);

    assert.ok(result.includes('PSG vs Liverpool'));
    assert.ok(result.includes('Champions League QF'));
    assert.ok(result.includes('Parc des Princes'));
    assert.ok(result.includes('Luis Enrique'));
    assert.ok(result.includes('Arne Slot'));
    assert.ok(result.includes('Hakimi'));
    assert.ok(result.includes('Van Dijk'));
    assert.ok(result.includes('Salah'));
  });

  it('handles missing optional fields gracefully', () => {
    const data = {
      teams: [
        { name: 'Team A', squad: ['Player 1'] },
      ],
    };

    const result = buildContextString(data);
    assert.ok(result.includes('Player 1'));
    assert.ok(!result.includes('undefined'));
    assert.ok(!result.includes('null'));
  });

  it('handles empty teams array', () => {
    const data = { match: 'Test', teams: [] };
    const result = buildContextString(data);
    assert.ok(result.includes('Test'));
  });

  it('handles completely empty data', () => {
    const result = buildContextString({});
    assert.equal(typeof result, 'string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/context-search.test.js`
Expected: FAIL — module does not exist yet

- [ ] **Step 3: Write `lib/context-search.js`**

```js
import Anthropic from '@anthropic-ai/sdk';

// Haiku pricing per million tokens (matches translate.js)
const INPUT_COST_PER_MTOK = 1.0;
const OUTPUT_COST_PER_MTOK = 5.0;

function calcCost(usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  return (input * INPUT_COST_PER_MTOK + output * OUTPUT_COST_PER_MTOK) / 1_000_000;
}

let anthropic;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  }
  return anthropic;
}

const PROMPT_TEMPLATE = `I'm building context for a live Italian transcription tool. Search for the full matchday squads (not just starting XI — include substitutes) for this match: "{query}"

Return ONLY valid JSON with this structure:
{
  "match": "Team A vs Team B",
  "competition": "...",
  "venue": "...",
  "date": "...",
  "managers": ["...", "..."],
  "teams": [
    { "name": "...", "squad": ["Player Name", "..."] }
  ]
}

Include the full matchday squad (starting XI + bench) for each team. Use the player names as they would appear on official teamsheets. Do not include generic vocabulary or anything not sourced from the web search.`;

async function searchContext(query) {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      { role: 'user', content: PROMPT_TEMPLATE.replace('{query}', query) },
    ],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] },
    ],
  });

  // Extract text blocks (skip search result blocks)
  const textBlocks = response.content.filter(b => b.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  // Extract JSON from response
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in web search response');
  }

  const data = JSON.parse(jsonMatch[0]);

  return { data, costUsd: calcCost(response.usage) };
}

function buildContextString(data) {
  const lines = [];

  if (data.match) lines.push(data.match);
  if (data.competition) lines.push(data.competition);
  if (data.venue) lines.push(`Venue: ${data.venue}`);
  if (data.date) lines.push(`Date: ${data.date}`);
  if (data.managers?.length) lines.push(`Managers: ${data.managers.join(', ')}`);

  if (data.teams) {
    lines.push('');
    for (const team of data.teams) {
      lines.push(`${team.name}: ${team.squad.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export { searchContext, buildContextString };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/context-search.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/context-search.js test/context-search.test.js
git commit -m "feat: add context search module with Haiku web search"
```

---

### Task 2: Add `POST /api/context-search` route to server

**Files:**
- Modify: `server.js:14` (import), `server.js:67-77` (routes)

- [ ] **Step 1: Add import to server.js**

Add after the translate import (line 14):

```js
import { searchContext, buildContextString } from './lib/context-search.js';
```

- [ ] **Step 2: Add the route**

Add after the `POST /api/sessions` route (after line 77), before the audio match:

```js
      if (urlPath === '/api/context-search' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.query) return sendJson(res, 400, { error: 'query is required' });
        try {
          const { data, costUsd } = await searchContext(body.query);
          const contextString = buildContextString(data);
          return sendJson(res, 200, { context: contextString, structured: data, costUsd });
        } catch (err) {
          console.error('[capito] Context search failed:', err.message);
          return sendJson(res, 502, { error: 'Context search failed: ' + err.message });
        }
      }
```

- [ ] **Step 3: Manual smoke test**

Run: `node server.js` then in another terminal:
```bash
curl -X POST http://localhost:3000/api/context-search \
  -H 'Content-Type: application/json' \
  -d '{"query": "PSG vs Liverpool Champions League"}'
```
Expected: JSON response with `context`, `structured`, and `costUsd` fields

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add POST /api/context-search endpoint"
```

---

## Chunk 2: Frontend

### Task 3: Add toggle and loading state to session creation form

**Files:**
- Modify: `public/index.html:933-940` (form HTML), `public/index.html` (CSS)

- [ ] **Step 1: Add the toggle HTML**

In `index.html`, replace the session form section (lines 933-939):

```html
    <div id="new-session-form" class="new-session-form hidden">
      <input type="text" id="session-name-input" placeholder="e.g. Napoli vs Milan" />
      <div class="context-search-row">
        <label class="context-search-toggle">
          <input type="checkbox" id="context-search-toggle" />
          <span class="toggle-slider"></span>
        </label>
        <span class="context-search-label" id="context-search-label">Search for context</span>
      </div>
      <textarea id="session-context-input" rows="4" placeholder="Paste squad names, coaches, stadium (optional)"></textarea>
      <div class="new-session-actions">
        <button id="create-session-btn">Create</button>
        <button id="cancel-session-btn" class="secondary-btn">Cancel</button>
      </div>
    </div>
```

- [ ] **Step 2: Add CSS for the toggle**

Add to the `<style>` block, after the existing `.new-session-form` styles:

```css
    .context-search-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .context-search-label {
      font-size: 12px;
      color: var(--text-secondary);
      user-select: none;
    }

    .context-search-toggle {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }

    .context-search-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--border-strong);
      border-radius: 10px;
      transition: background 0.2s var(--ease-out);
    }

    .toggle-slider::before {
      content: '';
      position: absolute;
      height: 14px;
      width: 14px;
      left: 3px;
      bottom: 3px;
      background: var(--bg);
      border-radius: 50%;
      transition: transform 0.2s var(--ease-out);
    }

    .context-search-toggle input:checked + .toggle-slider {
      background: var(--accent);
    }

    .context-search-toggle input:checked + .toggle-slider::before {
      transform: translateX(16px);
    }

    .context-search-label.searching {
      color: var(--accent);
    }
```

- [ ] **Step 3: Visual check**

Run server, open browser, click "+ New" in sessions panel. Verify:
- Toggle appears between name input and context textarea
- Toggle slides smoothly
- Label reads "Search for context"

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add context search toggle to session creation form"
```

---

### Task 4: Wire toggle to API call in app.js

**Files:**
- Modify: `public/app.js:31` (DOM ref), `public/app.js:164-171` (form reset), `public/app.js:173-201` (create handler)

- [ ] **Step 1: Add DOM refs**

After line 31 (`const cancelContextBtn = ...`), add with the other form-related refs:

```js
const contextSearchToggle = document.getElementById('context-search-toggle');
const contextSearchLabel = document.getElementById('context-search-label');
```

- [ ] **Step 2: Add the search trigger on toggle change**

After the `cancelSessionBtn` listener (after line 206), add:

```js
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
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    sessionContextInput.value = data.context;
    contextSearchLabel.textContent = `Context found ($${data.costUsd.toFixed(2)})`;
  } catch (err) {
    console.error('[capito] Context search failed:', err);
    contextSearchLabel.textContent = 'Search failed';
    contextSearchToggle.checked = false;
  } finally {
    contextSearchLabel.classList.remove('searching');
    contextSearchToggle.disabled = false;
  }
});
```

- [ ] **Step 3: Reset toggle when form opens**

In the `newSessionBtn` click handler (around line 164-171), add reset inside the `if` block after clearing inputs:

```js
    contextSearchToggle.checked = false;
    contextSearchLabel.textContent = 'Search for context';
```

- [ ] **Step 4: Manual end-to-end test**

1. Start server: `node server.js`
2. Open browser to `http://localhost:3000`
3. Click sessions panel → "+ New"
4. Type "Inter vs Napoli, Serie A"
5. Toggle "Search for context" on
6. Wait for "Searching..." → context populates textarea
7. Review the populated context — should have squad names
8. Optionally edit the context
9. Click "Create" — session starts with context

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: wire context search toggle to API and populate textarea"
```

---

### Task 5: Final cleanup and verification

- [ ] **Step 1: Run all existing tests**

Run: `node --test test/context-search.test.js test/sessions.test.js test/translate.test.js test/audio.test.js test/batch.test.js test/audio-endpoint.test.js`
Expected: All pass, no regressions

- [ ] **Step 2: Verify no leftover test artifacts**

Check `sessions/` directory for any test-created session files and clean up if needed.

- [ ] **Step 3: Commit any final changes**

```bash
git add -A
git commit -m "chore: final cleanup for web search context feature"
```
