import { computeBufferLabelBox } from './BufferLabelRenderer.js';

// Persistent X / ✓ markers stamped over a buffer-funnel label box to show
// the most-recent typed-sink resolution at that funnel:
//   • mismatched shape arrived → red X
//   • matching  shape arrived  → green check
//
// Markers stay until the consumer calls `clearAll()` (the scenes do this on
// `_restartSim`, so any level edit / sim restart wipes the slate). Re-marking
// the same funnel replaces the previous mark — useful if the level changes
// such that a funnel that was once correct starts rejecting (or vice versa).

const X_COLOR     = 0xd02020;
const CHECK_COLOR = 0x2ea84a;
const STROKE_W    = 4;

export class BufferMarkerRenderer {
  constructor(scene, container, level, { pxCell, pxGap }) {
    this.scene = scene;
    this.container = container;
    this.level = level;
    this.pxCell = pxCell;
    this.pxGap = pxGap;
    this.handles = new Map(); // funnel.key → Graphics
  }

  // Stamp / replace the marker at this funnel. accepted=true → green check,
  // false → red X. Funnel comes from Simulation, so cells are exposed as
  // `absR`/`absC` (with `r`/`c` as a fallback for non-sim callers).
  mark(funnel, accepted) {
    const prev = this.handles.get(funnel.key);
    if (prev) prev.destroy();

    const r = funnel.absR != null ? funnel.absR : funnel.r;
    const c = funnel.absC != null ? funnel.absC : funnel.c;
    const { x, y, size } = computeBufferLabelBox(this.level, { r, c, side: funnel.side }, this.pxCell, this.pxGap);
    const gfx = this.scene.make.graphics({ add: false });
    gfx.x = x;
    gfx.y = y;
    if (accepted) drawCheck(gfx, size); else drawX(gfx, size);
    this.container.add(gfx);
    this.handles.set(funnel.key, gfx);
  }

  clearAll() {
    for (const gfx of this.handles.values()) gfx.destroy();
    this.handles.clear();
  }
}

function drawX(gfx, boxSize) {
  const half = boxSize * 0.42;
  gfx.lineStyle(STROKE_W, X_COLOR, 1);
  gfx.beginPath();
  gfx.moveTo(-half, -half);
  gfx.lineTo( half,  half);
  gfx.moveTo( half, -half);
  gfx.lineTo(-half,  half);
  gfx.strokePath();
}

function drawCheck(gfx, boxSize) {
  // Three-point checkmark fitted inside the label box. Sized similarly to
  // the X for visual parity. Anchored on the box center.
  const r = boxSize * 0.42;
  gfx.lineStyle(STROKE_W, CHECK_COLOR, 1);
  gfx.beginPath();
  gfx.moveTo(-r,           r * 0.05);
  gfx.lineTo(-r * 0.25,    r * 0.6);
  gfx.lineTo( r * 0.85,   -r * 0.55);
  gfx.strokePath();
}
