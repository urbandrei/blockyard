// Shared constants (ported from v1 common.css CSS vars + shape.js).

export const CYCLE_MS = 1100;           // one animation / simulation cycle
export const SHAPE_SCALE = 0.6;         // interior factory body renders at 60% of grid cell
export const BOARD_GAP = 3;             // px gap between board grid cells

// Colors — white-bg palette.
//
// Factory bodies stay in the grey family (readable on white, no change needed).
// Funnel fills keep their existing green/orange; strokes (dark green / brown)
// read fine on both the grey body and the white buffer.
// Flow-line dashes stay white — they only ever overlay a grey factory body.
export const BLOCK_LIGHT    = 0x5a5f66;
export const BLOCK_DARK     = 0x2e3238;
export const BLOCK_STROKE   = 0x14161a;
export const FUNNEL_INPUT_FILL   = 0x6fcf7b;
export const FUNNEL_INPUT_STROKE = 0x1f5a2a;
export const FUNNEL_OUTPUT_FILL  = 0xff8a6a;
export const FUNNEL_OUTPUT_STROKE = 0x7a2a10;
export const MANIFOLD_STROKE = 0xffffff;

// Scene clear color (Phaser game `backgroundColor`). Dark brown per the
// polish pass; HTML body background matches so the letterbox is seamless.
export const BG_COLOR        = 0x412722;

// Playable-area surface. Peachy checker on the interior, dark-brown checker
// on the buffer ring, chocolate-brown outline around the interior.
export const INTERIOR_FILL     = 0xDFA06E;   // parity 0 (primary)
export const INTERIOR_FILL_ALT = 0xC48652;   // parity 1 (darker peach)
export const BUFFER_FILL       = 0x412722;   // parity 0 (matches scene bg)
export const BUFFER_FILL_ALT   = 0x552e26;   // parity 1 (lighter brown)
export const FRAME_STROKE      = 0x3a1f1a;

// Shape / label sizing. Shapes emit at this fraction of pxCell (used by
// both ShapeRenderer and BufferLabelRenderer so the two render identically).
export const SHAPE_RADIUS_FRAC = 0.26;

// Kept for backwards reference; unused since Milestone B.
export const CELL_BG         = 0x000000;

// Blueprint (bottom composer) palette. Royal-blue ground with white dotted
// grid for the editable cells, plus a mid-blue subtle divider for the icon
// strip.
export const BLUEPRINT_BG        = 0x3b66b8;
export const BLUEPRINT_DOT       = 0xffffff;
export const BLUEPRINT_STRIP_BG  = 0x2f559f;   // darker band for the icon strip
export const BLUEPRINT_STROKE    = 0x1f3a74;   // frame around the blueprint

// Mouse-proximity grid inside the playable area (GridHoverRenderer). The
// grid fades out beyond this radius (in cells) from the pointer.
export const HOVER_GRID_COLOR  = 0x6b7a8d;
export const HOVER_GRID_RADIUS = 2;            // in cell-units

// Motion (phase-based, in sync with the pulse animation keyframes).
// The cycle has two slow plateaus: one centered on the cell EDGE (wraps
// across t=0 / t=1) and one centered on the cell CENTER (t=0.5). Each slow
// plateau covers 0.15 distance over 0.35 time; each fast transition covers
// 0.35 distance over 0.15 time. Centering the middle plateau on distance
// 0.5 makes the shape appear to "hold" directly over the grid-point center
// rather than past it.
export function phaseDistance(t) {
  const p = t - Math.floor(t);
  if (p < 0.175) return (p / 0.175) * 0.075;                         // edge slow, first half
  if (p < 0.325) return 0.075 + ((p - 0.175) / 0.15) * 0.35;         // fast 1
  if (p < 0.675) return 0.425 + ((p - 0.325) / 0.35) * 0.15;         // center slow
  if (p < 0.825) return 0.575 + ((p - 0.675) / 0.15) * 0.35;         // fast 2
  return         0.925 + ((p - 0.825) / 0.175) * 0.075;              // edge slow, second half
}
export function cumulativeDistance(cycles) {
  return Math.floor(cycles) + phaseDistance(cycles);
}

// Speed-based warp envelope, SIGNED: across each fast band it sweeps 0 →
// +1 → 0 → -1 → 0 (full sine), so the first half (accelerating) stretches
// the shape along its motion direction and the second half (decelerating)
// compresses it. Shape is neutral-round at peak speed and at both slow
// plateaus. Used by ShapeRenderer.
export function motionWarp(t) {
  const p = t - Math.floor(t);
  let localT = -1;
  if (p >= 0.175 && p < 0.325)      localT = (p - 0.175) / 0.15;
  else if (p >= 0.675 && p < 0.825) localT = (p - 0.675) / 0.15;
  if (localT < 0) return 0;
  return Math.sin(localT * Math.PI * 2);
}

// Opposite / neighbor side helpers
export const SIDE_TO_EXIT = {
  top:    [1, 0],
  bottom: [-1, 0],
  left:   [0, 1],
  right:  [0, -1],
};
export const SIDE_OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
export const SIDE_DELTA    = { top: [-1, 0], bottom: [1, 0], left: [0, -1], right: [0, 1] };

// Uniform outline thickness across every stroked shape — factory bodies,
// funnel triangles, border, flow-line dashes, frame outline. Fixed so that
// resizing the playable area does NOT change the thickness of any stroke in
// the game. (`pxCell` is kept as a parameter for legacy callers.)
// eslint-disable-next-line no-unused-vars
export function outlineWidth(pxCell) {
  return 3;
}
