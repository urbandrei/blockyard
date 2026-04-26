import { computeBufferLabelBox } from './BufferLabelRenderer.js';
import { markKey, GLYPH_REF_PXCELL } from './textures/atlas.js';

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
// Chunky strokes that fill most of the tile — reads clearly at a glance.
// Width scales with box size so the marker stays proportionate on resize.
const STROKE_FRAC = 0.18;   // stroke width = STROKE_FRAC * boxSize
const EXTENT_FRAC = 0.48;   // marker extends EXTENT_FRAC * boxSize from center

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
  // Uses the baked check / X sprite from the static atlas; falls back to
  // the legacy Graphics draw if the bake didn't load.
  mark(funnel, accepted) {
    const prev = this.handles.get(funnel.key);
    if (prev) prev.destroy();

    const r = funnel.absR != null ? funnel.absR : funnel.r;
    const c = funnel.absC != null ? funnel.absC : funnel.c;
    const { x, y, size } = computeBufferLabelBox(this.level, { r, c, side: funnel.side }, this.pxCell, this.pxGap);
    const key = markKey(accepted ? 'check' : 'x');
    let handle;
    if (this.scene.textures.exists(key)) {
      handle = this.scene.add.image(x, y, key).setOrigin(0.5);
      handle.setScale(this.pxCell / GLYPH_REF_PXCELL);
    } else {
      handle = this.scene.make.graphics({ add: false });
      handle.x = x;
      handle.y = y;
      if (accepted) drawCheck(handle, size); else drawX(handle, size);
    }
    this.container.add(handle);
    this.handles.set(funnel.key, handle);
  }

  clearAll() {
    for (const gfx of this.handles.values()) gfx.destroy();
    this.handles.clear();
  }
}

function drawX(gfx, boxSize) {
  const half = boxSize * EXTENT_FRAC;
  const w    = Math.max(3, Math.round(boxSize * STROKE_FRAC));
  gfx.lineStyle(w, X_COLOR, 1);
  gfx.beginPath();
  gfx.moveTo(-half, -half);
  gfx.lineTo( half,  half);
  gfx.moveTo( half, -half);
  gfx.lineTo(-half,  half);
  gfx.strokePath();
}

function drawCheck(gfx, boxSize) {
  // Chunky three-point checkmark fitted inside the label box.
  const r = boxSize * EXTENT_FRAC;
  const w = Math.max(3, Math.round(boxSize * STROKE_FRAC));
  gfx.lineStyle(w, CHECK_COLOR, 1);
  gfx.beginPath();
  gfx.moveTo(-r,           r * 0.08);
  gfx.lineTo(-r * 0.20,    r * 0.70);
  gfx.lineTo( r * 0.95,   -r * 0.65);
  gfx.strokePath();
}
