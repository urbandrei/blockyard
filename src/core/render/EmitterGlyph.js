import { SHAPE_SCALE, EMITTER_FILL, EMITTER_STROKE, COLLECTOR_FILL, COLLECTOR_STROKE, outlineWidth } from '../constants.js';
import { emitterKey, GLYPH_REF_PXCELL } from './textures/atlas.js';

// Laser emitter / collector glyph. The silhouette is a "flipped funnel with
// a central gap": two mirrored half-triangles point OUTWARD from the cell,
// leaving a small slit down the middle where the beam exits. Same footprint
// as `funnelPolyPoints` so emitters line up pixel-perfectly with input/
// output funnels in the same cell. `isCollector` swaps to the white-fill
// palette — collectors read as the "catch" end of a beam.

const GAP_FRAC  = 0.18;   // width of central slit as a fraction of the triangle base
const FIN_WIDEN = 1.05;   // splay the outer corners slightly so the gap reads clearly
// Asymmetric straddle — more of the glyph pokes OUTSIDE the block than sits
// inside it, so the emitter reads as a cannon protruding from the body.
const OUT_FRAC  = 0.6;

export function emitterPolyPoints(r, c, side, pxCell, pxGap, scale = SHAPE_SCALE) {
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const x0 = c * step + m, y0 = r * step + m;
  const cx = x0 + inner / 2, cy = y0 + inner / 2;
  const funInner = pxCell * SHAPE_SCALE;
  // Slightly bigger than a regular funnel so the emitter reads as a chunkier
  // piece of hardware, and protrudes further than 50/50 past the block.
  const h = Math.round(funInner * 0.6);
  const base = Math.round(funInner * 0.68 * FIN_WIDEN);
  const half = base / 2;
  const gap = Math.max(2, Math.round(base * GAP_FRAC));
  const halfGap = gap / 2;
  const outH = Math.round(h * OUT_FRAC);
  const inH  = h - outH;

  // Two right triangles with their LONGER legs back-to-back along the beam
  // axis. Glyph straddles the scaled block boundary asymmetrically: `outH`
  // past the edge (sharp tip) and `inH` inside the body (short-leg base).
  switch (side) {
    case 'top': {
      const tipY  = y0 - outH;
      const baseY = y0 + inH;
      return [
        [[cx - halfGap, baseY], [cx - half,    baseY], [cx - halfGap, tipY]],
        [[cx + halfGap, baseY], [cx + halfGap, tipY],  [cx + half,    baseY]],
      ];
    }
    case 'bottom': {
      const tipY  = y0 + inner + outH;
      const baseY = y0 + inner - inH;
      return [
        [[cx - halfGap, baseY], [cx - halfGap, tipY], [cx - half,    baseY]],
        [[cx + halfGap, baseY], [cx + half,    baseY], [cx + halfGap, tipY]],
      ];
    }
    case 'left': {
      const tipX  = x0 - outH;
      const baseX = x0 + inH;
      return [
        [[baseX, cy - halfGap], [baseX, cy - half],    [tipX, cy - halfGap]],
        [[baseX, cy + halfGap], [tipX,  cy + halfGap], [baseX, cy + half]],
      ];
    }
    case 'right': {
      const tipX  = x0 + inner + outH;
      const baseX = x0 + inner - inH;
      return [
        [[baseX, cy - halfGap], [tipX,  cy - halfGap], [baseX, cy - half]],
        [[baseX, cy + halfGap], [baseX, cy + half],    [tipX,  cy + halfGap]],
      ];
    }
  }
  return [];
}

// Draw a list of emitter/collector glyphs into `gfx`. `role` on each funnel
// selects emitter vs. collector styling. `isBorder` kept in the signature
// for parity with `drawFunnelsInto` though it currently has no effect (same
// palette on both sides).
export function drawEmittersInto(gfx, funnels, pxCell, pxGap, scale, _isBorder = false) {
  const strokeW = outlineWidth(pxCell);
  for (const f of funnels) {
    const isCollector = f.role === 'collector';
    const fill   = isCollector ? COLLECTOR_FILL   : EMITTER_FILL;
    const stroke = isCollector ? COLLECTOR_STROKE : EMITTER_STROKE;
    const polys = emitterPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
    for (const poly of polys) {
      if (poly.length < 3) continue;
      gfx.fillStyle(fill, 1);
      gfx.lineStyle(strokeW, stroke, 1);
      gfx.beginPath();
      gfx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) gfx.lineTo(poly[i][0], poly[i][1]);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    }
  }
}

export function renderEmitters(scene, container, funnels, { pxCell, pxGap, scale = SHAPE_SCALE, isBorder = false }) {
  const gfx = scene.make.graphics({ add: false });
  drawEmittersInto(gfx, funnels, pxCell, pxGap, scale, isBorder);
  container.add(gfx);
  return gfx;
}

// Sprite-based emitter render. Adds one Image per funnel to `container`,
// each pulled from the emitter atlas (atlas.js) and scaled to the current
// pxCell. Falls back to drawEmittersInto on a scratch Graphics for any
// emitter whose atlas key didn't bake (defensive).
export function renderEmittersAsSprites(scene, container, funnels, { pxCell, pxGap, scale = SHAPE_SCALE, isBorder = false } = {}) {
  if (!funnels || funnels.length === 0) return;
  const step = pxCell + pxGap;
  const spriteScale = pxCell / GLYPH_REF_PXCELL;
  let fallbackGfx = null;
  for (const f of funnels) {
    const role = f.role === 'collector' ? 'collector' : 'emitter';
    const key = emitterKey(role, f.side);
    if (scene.textures.exists(key)) {
      const cx = f.c * step + pxCell / 2;
      const cy = f.r * step + pxCell / 2;
      const img = scene.add.image(cx, cy, key).setOrigin(0.5);
      img.setScale(spriteScale);
      container.add(img);
    } else {
      if (!fallbackGfx) {
        fallbackGfx = scene.make.graphics({ add: false });
        container.add(fallbackGfx);
      }
      drawEmittersInto(fallbackGfx, [f], pxCell, pxGap, scale, isBorder);
    }
  }
}

// Distance (in pixels) from the emitter gap center (= beam origin) OUT along
// the beam axis to the glyph's sharp tip. Used to anchor the charge
// animation at the protruding tip. Matches the geometry in emitterPolyPoints
// (h · OUT_FRAC).
export function emitterTipOffset(pxCell) {
  const funInner = pxCell * SHAPE_SCALE;
  const h = Math.round(funInner * 0.6);
  return Math.round(h * OUT_FRAC);
}

// Exit point on the cell edge where the beam originates — the CENTER of the
// gap between the two half-triangles. Used by the sim/renderer to anchor
// beam starts/ends.
export function emitterGapCenter(r, c, side, pxCell, pxGap, scale = SHAPE_SCALE) {
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const x0 = c * step + m, y0 = r * step + m;
  const cx = x0 + inner / 2, cy = y0 + inner / 2;
  switch (side) {
    case 'top':    return [cx, y0];
    case 'bottom': return [cx, y0 + inner];
    case 'left':   return [x0, cy];
    case 'right':  return [x0 + inner, cy];
  }
  return [cx, cy];
}
