import { edgeMidpoint } from '../model/shape.js';
import { MANIFOLD_STROKE, SHAPE_SCALE, SIDE_OPPOSITE, SIDE_DELTA, outlineWidth } from '../constants.js';

// Solid line between two aligned funnels on adjacent factories (including
// factory↔border). Same stroke style as the manifold flow but no dash
// animation.

export function renderBridges(scene, container, level, { pxCell, pxGap }) {
  const gfx = scene.make.graphics({ add: false });
  const strokeW = outlineWidth(pxCell);
  gfx.lineStyle(strokeW, MANIFOLD_STROKE, 1);

  const byKey = new Map();
  for (const fac of level.factories || []) {
    for (const f of (fac.funnels || [])) {
      const ar = fac.anchor.row + f.r;
      const ac = fac.anchor.col + f.c;
      byKey.set(`${ar},${ac},${f.side}`, { ar, ac, side: f.side, role: f.role, scale: SHAPE_SCALE });
    }
  }
  if (level.border && Array.isArray(level.border.funnels)) {
    for (const f of level.border.funnels) {
      byKey.set(`${f.r},${f.c},${f.side}`, { ar: f.r, ac: f.c, side: f.side, role: f.role, scale: 1 });
    }
  }

  const drawn = new Set();
  for (const [key, a] of byKey) {
    if (drawn.has(key)) continue;
    const [dr, dc] = SIDE_DELTA[a.side];
    const otherKey = `${a.ar + dr},${a.ac + dc},${SIDE_OPPOSITE[a.side]}`;
    const b = byKey.get(otherKey);
    if (!b) continue;
    const p1 = edgeMidpoint(a.ar, a.ac, a.side, pxCell, pxGap, a.scale);
    const p2 = edgeMidpoint(b.ar, b.ac, b.side, pxCell, pxGap, b.scale);
    gfx.beginPath();
    gfx.moveTo(p1[0], p1[1]);
    gfx.lineTo(p2[0], p2[1]);
    gfx.strokePath();
    drawn.add(key);
    drawn.add(otherKey);
  }
  container.add(gfx);
  return gfx;
}
