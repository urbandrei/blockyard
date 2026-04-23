import { drawFunnelsInto } from './FunnelRenderer.js';
import { SHAPE_SCALE } from '../constants.js';

// Renders buffer-funnel triangles. Each funnel gets its OWN pulseWrap
// container, centered on the buffer cell's center, so scenes can apply
// `shapeSquash().funnels` per frame — making border funnels breathe in
// lockstep with factory funnels.
//
// The ring body is gone (Milestone B). The unused `bodyContainer` argument
// is kept in the signature for one beat so callers don't need to rewire.
//
// Returns `{ wraps: Container[], destroy }` — scenes stash `wraps` and pulse
// each wrap's scaleX/Y from their update loop.

export function renderBorder(scene, _bodyContainer, funnelContainer, level, { pxCell, pxGap }) {
  const wraps = [];
  const funnels = (level.border && level.border.funnels) || [];
  if (funnels.length === 0) return { wraps, destroy() {} };

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
    drawFunnelsInto(gfx, [f], pxCell, pxGap, SHAPE_SCALE, /* isBorder */ true);
    gfx.setPosition(-cx, -cy);
    wrap.add(gfx);
    wraps.push(wrap);
  }

  return {
    wraps,
    destroy() { for (const w of wraps) w.destroy(); },
  };
}
