// Player progress, persisted via the platform adapter.
//
// Shape:
//   {
//     beaten: string[],                  // catalog level ids the player has cleared
//     sectionsSeenIntros: string[],      // section ids whose intro cinematic was shown
//     featuredCompleted: string[],       // YYYY-MM-DD UTC dates whose featured the player beat
//     streakCount: number,               // current consecutive-days streak (0 if broken)
//     streakLastUtc: string | null,      // last UTC date that advanced the streak
//   }
//
// Stored as arrays (not Sets) so the platform JSON pipe can round-trip it
// cleanly. A small in-memory cache avoids hammering platform.loadData on
// every check during a single session.

import { platform } from '../platform/index.js';

const KEY = 'progress';

let cache = null;

function empty() {
  return {
    beaten: [],
    sectionsSeenIntros: [],
    featuredCompleted: [],
    streakCount: 0,
    streakLastUtc: null,
  };
}

function normalize(raw) {
  const p = empty();
  if (raw && Array.isArray(raw.beaten)) p.beaten = raw.beaten.slice();
  if (raw && Array.isArray(raw.sectionsSeenIntros)) p.sectionsSeenIntros = raw.sectionsSeenIntros.slice();
  if (raw && Array.isArray(raw.featuredCompleted)) p.featuredCompleted = raw.featuredCompleted.slice();
  if (raw && typeof raw.streakCount === 'number' && raw.streakCount >= 0) p.streakCount = raw.streakCount | 0;
  if (raw && typeof raw.streakLastUtc === 'string') p.streakLastUtc = raw.streakLastUtc;
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

// ----- daily featured + streak -----

/** Today's UTC date as YYYY-MM-DD (used by streak math). */
export function utcToday(now = Date.now()) {
  const d = new Date(now);
  return ymdUtc(d);
}

function ymdUtc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(aYmd, bYmd) {
  // a - b in whole UTC days. Returns NaN on invalid input.
  const a = Date.UTC(+aYmd.slice(0, 4), +aYmd.slice(5, 7) - 1, +aYmd.slice(8, 10));
  const b = Date.UTC(+bYmd.slice(0, 4), +bYmd.slice(5, 7) - 1, +bYmd.slice(8, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((a - b) / 86400000);
}

/**
 * Mark a featured level (identified by its UTC date) as completed and
 * advance the streak per the strict rule: if the date is exactly one
 * day after `streakLastUtc`, the streak ticks up; otherwise it resets
 * to 1. Completing the SAME date twice is a no-op for the streak.
 *
 * Catch-up completions (utcDate older than streakLastUtc) get recorded
 * in `featuredCompleted` but DO NOT change the streak — only same-day
 * completions count, per the user-confirmed strict rule.
 */
export async function markFeaturedCompleted(utcDate) {
  if (!utcDate || !/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return;
  const p = await loadProgress();
  const wasNew = !p.featuredCompleted.includes(utcDate);
  if (wasNew) p.featuredCompleted.push(utcDate);
  // Only advance the streak when the completion is for "today" — past
  // featureds beaten via the arrow browser don't count.
  const today = utcToday();
  if (utcDate === today) {
    if (p.streakLastUtc && dayDiff(today, p.streakLastUtc) === 1) {
      p.streakCount = (p.streakCount | 0) + 1;
    } else if (p.streakLastUtc !== today) {
      p.streakCount = 1;
    }
    p.streakLastUtc = today;
  }
  if (wasNew || utcDate === today) await persist();
}

export async function isFeaturedCompleted(utcDate) {
  if (!utcDate) return false;
  const p = await loadProgress();
  return p.featuredCompleted.includes(utcDate);
}

/**
 * Returns the currently-displayable streak count. Reads as a pure
 * function on the cache: if the player's last streak day is today or
 * yesterday (UTC) the stored count is still alive; older than that and
 * the streak has lapsed and we report 0 without mutating storage.
 * The stored count is only reset to 1 the next time they actually
 * complete a featured.
 */
/**
 * Once-only check for section-unlock cinematics. Sections are referenced
 * by string id (e.g., 'paint-spill', 'acid-swamp') from sectionThemes.
 * The first call for a given id returns false AND marks it seen so the
 * cinematic never plays a second time. Every subsequent call returns true.
 *
 * Returns true if the intro was already seen (caller should skip), false
 * if this is the first time (caller should show the intro).
 */
export async function consumeSectionIntro(sectionId) {
  if (!sectionId) return true;
  const p = await loadProgress();
  if (p.sectionsSeenIntros.includes(sectionId)) return true;
  p.sectionsSeenIntros.push(sectionId);
  await persist();
  return false;
}

/** Read-only check — true if the section intro has been seen, no mutation. */
export async function hasSeenSectionIntro(sectionId) {
  if (!sectionId) return true;
  const p = await loadProgress();
  return p.sectionsSeenIntros.includes(sectionId);
}

/**
 * Dev command — wipes the "section intros seen" list so every section
 * unlock cinematic (Paint Spill / Acid Swamp / Laser Field / Wild West)
 * plays again the next time it's triggered. Returns the new count of
 * cleared entries so the caller (typically the dev console) can show
 * a confirmation. The end-game credits sequence isn't gated by a flag
 * so it doesn't need resetting — it plays every time level 40 is beaten.
 */
export async function resetCutscenes() {
  const p = await loadProgress();
  const cleared = p.sectionsSeenIntros.length;
  p.sectionsSeenIntros = [];
  await persist();
  return cleared;
}

export async function currentStreak() {
  const p = await loadProgress();
  if (!p.streakLastUtc) return 0;
  const diff = dayDiff(utcToday(), p.streakLastUtc);
  if (diff === 0 || diff === 1) return p.streakCount | 0;
  return 0;
}
