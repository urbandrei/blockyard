import { funnelPolyPoints } from '../model/shape.js';
import {
  SHAPE_SCALE,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE,
  FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE,
  outlineWidth,
} from '../constants.js';

export function renderFunnels(scene, container, funnels, { pxCell, pxGap, scale = SHAPE_SCALE, isBorder = false }) {
  // make (not add) so the gfx starts outside the scene display list — we only
  // want it rendered as part of its target container, never doubly-registered.
  const gfx = scene.make.graphics({ add: false });
  drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale, isBorder);
  container.add(gfx);
  return gfx;
}

export function drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale, isBorder = false) {
  gfx.clear();
  const strokeW = outlineWidth(pxCell);
  // Border funnels keep the original green-in / red-out palette. Factory
  // funnels use the inverted palette so colors read relative to the
  // factory body itself (input = where shapes arrive = red).
  const inputFill   = isBorder ? FUNNEL_INPUT_FILL   : FACTORY_FUNNEL_INPUT_FILL;
  const inputStroke = isBorder ? FUNNEL_INPUT_STROKE : FACTORY_FUNNEL_INPUT_STROKE;
  const outFill     = isBorder ? FUNNEL_OUTPUT_FILL   : FACTORY_FUNNEL_OUTPUT_FILL;
  const outStroke   = isBorder ? FUNNEL_OUTPUT_STROKE : FACTORY_FUNNEL_OUTPUT_STROKE;
  for (const f of funnels) {
    const pts = funnelPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
    if (pts.length < 3) continue;
    const isInput = f.role !== 'output';
    gfx.fillStyle(isInput ? inputFill : outFill, 1);
    gfx.lineStyle(strokeW, isInput ? inputStroke : outStroke, 1);
    gfx.beginPath();
    gfx.moveTo(pts[0][0], pts[0][1]);
    gfx.lineTo(pts[1][0], pts[1][1]);
    gfx.lineTo(pts[2][0], pts[2][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }
}
