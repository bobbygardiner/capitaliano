// lib/batch.js

/**
 * Parse a free-text match context into a context_bias string array.
 * Extracts proper nouns (multi-word names starting with uppercase).
 */
export function parseContextBias(context) {
  if (!context || !context.trim()) return [];

  const names = new Set();
  const lines = context.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;

    const teamCoachMatch = trimmed.match(/^(.+?)\s*\(Coach:\s*(.+?)\)/);
    if (teamCoachMatch) {
      names.add(teamCoachMatch[1].trim());
      names.add(teamCoachMatch[2].trim());
      continue;
    }

    const vsMatch = trimmed.match(/^(.+?)\s+vs\s+(.+?)\s*[—–-]/);
    if (vsMatch) {
      names.add(vsMatch[1].trim());
      names.add(vsMatch[2].trim());
      continue;
    }

    const afterLabel = trimmed.replace(/^(Starters|Substitutes)\s*:\s*/, '');
    if (afterLabel === trimmed && !trimmed.includes(',') && !trimmed.includes(';')) continue;

    const parts = afterLabel.split(/[,;]+/);
    for (const part of parts) {
      const name = part.trim();
      if (name.length >= 2 && /^[A-ZÀ-Ž]/.test(name)) {
        const words = name.split(/\s+/).filter(w => w.length >= 2);
        if (words.length >= 1 && words.every(w => /^[A-ZÀ-Ž]/.test(w))) {
          names.add(words.join(' '));
        }
      }
    }
  }

  return [...names].slice(0, 100);
}
