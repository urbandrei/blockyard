// Player progress, persisted via the platform adapter.
//
// Shape:
//   { beaten: string[], sectionsSeenIntros: string[] }
//
// Stored as arrays (not Sets) so the platform JSON pipe can round-trip it
// cleanly. A small in-memory cache avoids hammering platform.loadData on
// every check during a single session.

import { platform } from '../platform/index.js';

const KEY = 'progress';

let cache = null;

function empty() {
  return { beaten: [], sectionsSeenIntros: [] };
}

function normalize(raw) {
  const p = empty();
  if (raw && Array.isArray(raw.beaten)) p.beaten = raw.beaten.slice();
  if (raw && Array.isArray(raw.sectionsSeenIntros)) p.sectionsSeenIntros = raw.sectionsSeenIntros.slice();
  return p;
}

export async function loadProgress() {
  if (cache) return cache;
  try {
    const raw = await platform.loadData(KEY);
    cache = normalize(raw);
  } catch (e) {
    console.warn('[progress] load failed', e);
    cache = empty();
  }
  return cache;
}

async function persist() {
  try {
    await platform.saveData(KEY, cache);
  } catch (e) {
    console.warn('[progress] save failed', e);
  }
}

export async function markBeaten(levelId) {
  const p = await loadProgress();
  if (!p.beaten.includes(levelId)) {
    p.beaten.push(levelId);
    await persist();
  }
}

export async function isBeaten(levelId) {
  const p = await loadProgress();
  return p.beaten.includes(levelId);
}

export async function beatenSet() {
  const p = await loadProgress();
  return new Set(p.beaten);
}
