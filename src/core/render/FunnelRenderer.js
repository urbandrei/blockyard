import { funnelPolyPoints } from '../model/shape.js';
import {
  SHAPE_SCALE,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  outlineWidth,
} from '../constants.js';

export function renderFunnels(scene, container, funnels, { pxCell, pxGap, scale = SHAPE_SCALE }) {
  // make (not add) so the gfx starts outside the scene display list — we only
  // want it rendered as part of its target container, never doubly-registered.
  const gfx = scene.make.graphics({ add: false });
  drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale);
  container.add(gfx);
  return gfx;
}

export function drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale) {
  gfx.clear();
  const strokeW = outlineWidth(pxCell);
  for (const f of funnels) {
    const pts = funnelPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
    if (pts.length < 3) continue;
    const isInput = f.role !== 'output';
    const fill = isInput ? FUNNEL_INPUT_FILL : FUNNEL_OUTPUT_FILL;
    const stroke = isInput ? FUNNEL_INPUT_STROKE : FUNNEL_OUTPUT_STROKE;
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(strokeW, stroke, 1);
    gfx.beginPath();
    gfx.moveTo(pts[0][0], pts[0][1]);
    gfx.lineTo(pts[1][0], pts[1][1]);
    gfx.lineTo(pts[2][0], pts[2][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }
}
