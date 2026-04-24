// Shared BPM clock. Every UI element that wants to breathe in time
// reads `beatPulse(scene.game.loop.time)` from an update tick — driving
// off the game's global clock (not scene-local time) keeps the rhythm
// in sync when scenes transition so the pulse doesn't reset.
//
// `BPM` / `BEAT_MS` live in constants.js since the sim cycle derives
// from the same tempo (CYCLE_MS = BEAT_MS * 2). Re-export them here so
// callers that only need the beat helpers don't have to reach into
// constants.

import { BPM, BEAT_MS } from '../constants.js';
export { BPM, BEAT_MS };

// Phase in [0, 1) for the current beat.
export function beatPhase(timeMs) {
  const t = ((timeMs || 0) / BEAT_MS) % 1;
  return t < 0 ? t + 1 : t;
}

// Smooth oscillation: returns base ± amp across the beat.
//   phase 0.00 → base         (rest)
//   phase 0.25 → base + amp   (max)
//   phase 0.50 → base         (rest)
//   phase 0.75 → base - amp   (min)
// Default amp = 0.06 is a subtle breath — bigger values read as shaky.
export function beatPulse(timeMs, { amp = 0.06, base = 1 } = {}) {
  const s = Math.sin(beatPhase(timeMs) * Math.PI * 2);
  return base + s * amp;
}
