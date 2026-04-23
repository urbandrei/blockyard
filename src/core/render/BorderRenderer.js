import { drawFunnelsInto } from './FunnelRenderer.js';
import { SHAPE_SCALE } from '../constants.js';

// Renders buffer-funnel triangles. Each funnel gets its OWN pulseWrap
// container, centered on the buffer cell's center, so scenes can apply
// `shapeSquash().funnels` per frame — making border funnels breathe in
// lockstep with factory funnels.
//
// Accepts:
//   funnels:  explicit list (optional — defaults to level.border.funnels)
//   getOpts:  (f) => { alpha?, fill?, stroke?, stageBg?, stageBgAlpha?, hidden? }
//             optional per-funnel styling override (see FunnelRenderer).
//
// Returns `{ wraps, funnels, destroy }`. `funnels` is the list that was
// rendered (same length as wraps, index-aligned).

export function renderBorder(scene, _bodyContainer, funnelContainer, level, opts) {
  const { pxCell, pxGap, funnels: overrideFunnels, getOpts } = opts || {};
  const wraps = [];
  const funnels = overrideFunnels || (level.border && level.border.funnels) || [];
  if (funnels.length === 0) return { wraps, funnels, destroy() {} };

  const step = pxCell + pxGap;
  for (const f of funnels) {
    const cx = f.c * step + pxCell / 2;
    const cy = f.r * step + pxCell / 2;
    const wrap = scene.add.container(cx, cy);
    funnelContainer.add(wrap);
    const gfx = scene.make.graphics({ add: false });
    // Render at SHAPE_SCALE — same scale as the buffer label tile — so the
    // triangle / emitter glyph protrudes from the tile edge exactly like a
    // factory funnel protrudes from a factory body edge.
    drawFunnelsInto(gfx, [f], pxCell, pxGap, SHAPE_SCALE, /* isBorder */ true, getOpts);
    gfx.setPosition(-cx, -cy);
    wrap.add(gfx);
    wraps.push(wrap);
  }

  return {
    wraps,
    funnels,
    destroy() { for (const w of wraps) w.destroy(); },
  };
}
