import { funnelPolyPoints } from '../model/shape.js';
import {
  SHAPE_SCALE,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE,
  FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE,
  outlineWidth, BOARD_GAP,
} from '../constants.js';
import { drawEmittersInto } from './EmitterGlyph.js';

// Extended signature, fully backwards compatible:
//   renderFunnels(scene, container, funnels, { pxCell, pxGap, scale, isBorder,
//                 getOpts: (f) => ({ alpha?, fill?, stroke?, stageBg?, hidden? }) })
// `stageBg` paints a tinted rounded-rect cell background under the funnel
// (used by the boss cross-stage view to color-code stage ownership).
// `hidden` suppresses the funnel entirely (used to drop destroyed reds).
export function renderFunnels(scene, container, funnels, opts) {
  const {
    pxCell, pxGap = BOARD_GAP, scale = SHAPE_SCALE, isBorder = false,
    getOpts = null,
  } = opts || {};
  const gfx = scene.make.graphics({ add: false });
  drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale, isBorder, getOpts);
  container.add(gfx);
  return gfx;
}

export function drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale, isBorder = false, getOpts = null) {
  gfx.clear();
  const strokeW = outlineWidth(pxCell);
  const inputFill   = isBorder ? FUNNEL_INPUT_FILL   : FACTORY_FUNNEL_INPUT_FILL;
  const inputStroke = isBorder ? FUNNEL_INPUT_STROKE : FACTORY_FUNNEL_INPUT_STROKE;
  const outFill     = isBorder ? FUNNEL_OUTPUT_FILL   : FACTORY_FUNNEL_OUTPUT_FILL;
  const outStroke   = isBorder ? FUNNEL_OUTPUT_STROKE : FACTORY_FUNNEL_OUTPUT_STROKE;

  // Phase 1: stage-background paint (rounded rect behind the funnel cell).
  // Drawn before the funnel glyph so the tint sits under it.
  if (getOpts) {
    for (const f of funnels) {
      const o = getOpts(f) || {};
      if (o.hidden) continue;
      if (o.stageBg == null) continue;
      const cellX = f.c * (pxCell + pxGap);
      const cellY = f.r * (pxCell + pxGap);
      gfx.fillStyle(o.stageBg, o.stageBgAlpha != null ? o.stageBgAlpha : 0.35);
      gfx.fillRoundedRect(cellX, cellY, pxCell, pxCell, Math.max(4, pxCell * 0.1));
    }
  }

  const laserFunnels = [];
  const shapeFunnels = [];
  for (const f of funnels) {
    const o = getOpts ? (getOpts(f) || {}) : null;
    if (o && o.hidden) continue;
    if (f.role === 'emitter' || f.role === 'collector') laserFunnels.push(f);
    else                                                 shapeFunnels.push(f);
  }
  for (const f of shapeFunnels) {
    const pts = funnelPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
    if (pts.length < 3) continue;
    const isInput = f.role !== 'output';
    const o = getOpts ? (getOpts(f) || {}) : null;
    const alpha = o && o.alpha != null ? o.alpha : 1;
    const fill   = o && o.fill   != null ? o.fill   : (isInput ? inputFill   : outFill);
    const stroke = o && o.stroke != null ? o.stroke : (isInput ? inputStroke : outStroke);
    gfx.fillStyle(fill, alpha);
    gfx.lineStyle(strokeW, stroke, alpha);
    gfx.beginPath();
    gfx.moveTo(pts[0][0], pts[0][1]);
    gfx.lineTo(pts[1][0], pts[1][1]);
    gfx.lineTo(pts[2][0], pts[2][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }
  if (laserFunnels.length) drawEmittersInto(gfx, laserFunnels, pxCell, pxGap, scale, isBorder);
}
