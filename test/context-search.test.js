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
});
