// Per-stage color palette for boss levels. The palette is indexed by round
// idx (mod length) and gives each stage a distinct identity on pills, border
// funnel cells, and blueprint cells.
//
// The CURRENT stage overrides this palette with CURRENT_STAGE_COLOR (blue)
// wherever stage color is used, and pills around the current stage get the
// CURRENT_STAGE_BORDER (green) as a thick outline. Past stages are rendered
// at PAST_STAGE_ALPHA; future stages at FUTURE_STAGE_ALPHA.

export const STAGE_COLORS = Object.freeze([
  0xff8a3b, // 1 orange
  0x9c66c7, // 2 purple
  0xe86fa8, // 3 pink
  0x3bbfb3, // 4 teal
  0xe8c64a, // 5 yellow
]);

export const CURRENT_STAGE_COLOR  = 0x3b82f6; // blue — active/current stage override
export const CURRENT_STAGE_BORDER = 0x22c55e; // green — emphasis border on active pill
export const CURRENT_STAGE_STROKE = 0x1a2332; // dark stroke used on all pills

export const PAST_STAGE_ALPHA   = 0.35;
export const FUTURE_STAGE_ALPHA = 0.55;
export const CELL_TINT_ALPHA    = 0.35;
export const CURRENT_PILL_SCALE = 1.25;

export function stageColor(idx) {
  const n = STAGE_COLORS.length;
  const i = ((idx | 0) % n + n) % n;
  return STAGE_COLORS[i];
}

/** Convenience: pick the effective color for a stage given whether it's the
 *  current stage. */
export function effectiveStageColor(stageIdx, currentIdx) {
  return stageIdx === currentIdx ? CURRENT_STAGE_COLOR : stageColor(stageIdx);
}

/** Convenience: pick the alpha tier for a stage relative to current. */
export function stageAlpha(stageIdx, currentIdx) {
  if (stageIdx === currentIdx) return 1.0;
  if (stageIdx <  currentIdx) return PAST_STAGE_ALPHA;
  return FUTURE_STAGE_ALPHA;
}
