import { traceFactoryLoops, unitVec, COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_SCALE, BLOCK_LIGHT, BLOCK_DARK, BLOCK_STROKE, outlineWidth } from '../constants.js';
import { drawPuddle } from './shapes.js';

// Renders a factory body (one or more cells, merged) as a Phaser Graphics
// game object. Uses perimeter-tracing + quadratic-bezier rounded corners.
// Gradient fills aren't in Phaser Graphics natively; we mix BLOCK_LIGHT and
// BLOCK_DARK into a single mid-tone fill.

// Hazard-tape palette — applied when `caution` is set (a factory with no
// funnels at all: pure obstacle). Diagonal black stripes on a bright yellow
// base read as "this is a wall, not something the shape flows through".
const CAUTION_YELLOW = 0xd6a30b;
const CAUTION_BLACK  = 0x1a1a1a;

export function renderFactoryBody(scene, container, { cells, pxCell, pxGap, scale = SHAPE_SCALE, fill, stroke, invalid, caution }) {
  const gfx = scene.make.graphics({ add: false });
  // Invalid factories paint their perimeter in red so the author sees at a
  // glance which block needs fixing; the actual reason floats as text near
  // the body (see EditorScene._drawFactory).
  const effectiveStroke = invalid ? 0xd02020 : stroke;
  const effectiveFill = caution ? CAUTION_YELLOW : fill;
  drawFactoryBodyInto(gfx, cells, pxCell, pxGap, scale, { fill: effectiveFill, stroke: effectiveStroke });
  // Caution factories: overlay 45° black hazard stripes directly into the
  // body graphics. Stripes are drawn as polygon-clipped fills (per cell
  // body-rect and per bridge rect) so they stay inside the merged body
  // without needing Phaser's mask system (which doesn't reliably track
  // container transforms here).
  if (caution) drawCautionStripesInto(gfx, cells, pxCell, pxGap, scale);
  drawCellLabels(gfx, cells, pxCell, pxGap, scale);
  container.add(gfx);
  return gfx;
}

// Paint 45°-angled hazard-tape stripes across the factory's body, clipped
// per cell/bridge rect so the fills stay inside the merged body. Stripe
// phase is keyed to absolute (x + y) world coordinates so adjacent cells'
// stripes line up into continuous diagonal bands.
function drawCautionStripesInto(gfx, cells, pxCell, pxGap, scale) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const stripeW = Math.max(6, Math.round(pxCell * 0.24));
  const pitch = stripeW * 2; // equal-width yellow and black bands

  // Collect convex rects covering the body: one per cell, one per bridge
  // between adjacent cells (horizontal/vertical), and one at the center of
  // every 2x2 block so a square of four tiled cells is fully covered (the
  // four bridges form a "+" and leave a hole at the intersection otherwise).
  // Stripes clip against each rect independently but share a single `d`
  // phase keyed to world coords, so the overall pattern reads as continuous.
  const rects = [];
  const set = new Set(cells.map((c) => `${c.r},${c.c}`));
  for (const { r, c } of cells) {
    rects.push([c * step + m, r * step + m, inner, inner]);
    if (set.has(`${r},${c + 1}`)) {
      rects.push([c * step + m + inner, r * step + m, step - inner, inner]);
    }
    if (set.has(`${r + 1},${c}`)) {
      rects.push([c * step + m, r * step + m + inner, inner, step - inner]);
    }
    if (set.has(`${r},${c + 1}`) && set.has(`${r + 1},${c}`) && set.has(`${r + 1},${c + 1}`)) {
      rects.push([c * step + m + inner, r * step + m + inner, step - inner, step - inner]);
    }
  }
  if (rects.length === 0) return;

  let dcMin = Infinity, dcMax = -Infinity;
  for (const [x, y, w, h] of rects) {
    if (x + y < dcMin) dcMin = x + y;
    if (x + w + y + h > dcMax) dcMax = x + w + y + h;
  }

  gfx.fillStyle(CAUTION_BLACK, 1);
  // Anchor the stripe phase to the factory's own top-left (dcMin) so the
  // pattern stays fixed relative to the factory itself. Rounding dcMin to
  // an absolute-coord pitch boundary would make the stripes jump by up to a
  // full period whenever a factory is placed into a non-pitch-aligned cell.
  const dStart = dcMin - pitch;
  for (let d = dStart; d <= dcMax + pitch; d += pitch) {
    const d1 = d, d2 = d + stripeW;
    for (const [x, y, w, h] of rects) {
      if (x + w + y + h < d1 || x + y > d2) continue;
      const poly = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      let p = clipHalfPlane(poly, (px, py) => (px + py) - d1);
      p = clipHalfPlane(p, (px, py) => d2 - (px + py));
      if (p.length < 3) continue;
      gfx.beginPath();
      gfx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) gfx.lineTo(p[i][0], p[i][1]);
      gfx.closePath();
      gfx.fillPath();
    }
  }
}

// Sutherland-Hodgman half-plane clip. `f(x,y) >= 0` is the keep-side; points
// outside are trimmed, edges crossing the boundary are interpolated.
function clipHalfPlane(poly, f) {
  if (!poly || poly.length === 0) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a[0], a[1]);
    const fb = f(b[0], b[1]);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// Paints the "locked" floor tint: a solid dim square covering each cell
// of a locked factory. Drawn on a container below the factory body so
// the body can be alpha-dimmed independently without fading the tint.
// Returns the graphics so the caller can destroy it on re-render.
export function renderLockedTint(scene, container, { cells, pxCell, pxGap }) {
  const gfx = scene.make.graphics({ add: false });
  gfx.fillStyle(0x000000, 0.35);
  const step = pxCell + pxGap;
  for (const { r, c } of (cells || [])) {
    gfx.fillRect(c * step, r * step, pxCell, pxCell);
  }
  container.add(gfx);
  return gfx;
}

export function drawFactoryBodyInto(gfx, cells, pxCell, pxGap, scale, opts = {}) {
  gfx.clear();
  if (!cells || cells.length === 0) return;
  const loops = traceFactoryLoops(cells, pxCell, pxGap, scale);
  if (loops.length === 0) return;
  const fill = opts.fill != null ? opts.fill : mixColor(BLOCK_LIGHT, BLOCK_DARK, 0.5);
  const stroke = opts.stroke != null ? opts.stroke : BLOCK_STROKE;
  const strokeW = outlineWidth(pxCell);   // uniform across all stroked shapes
  const cornerR = Math.max(3, Math.round(pxCell * scale * 0.18));

  // Phaser WebGL's FILL_PATH fills every subpath independently (no winding-
  // rule hole support), so for ring shapes (the border) we simulate a hole by
  // filling the outermost loop with `fill` and every inner loop with
  // `holeFill` — typically the scene bg color, so the player sees "through"
  // the border. Outer = loop with the largest area.
  const holeFill = opts.holeFill != null ? opts.holeFill : fill;
  let outerIdx = 0;
  if (loops.length > 1) {
    let maxArea = -Infinity;
    for (let i = 0; i < loops.length; i++) {
      const a = loopArea(loops[i]);
      if (a > maxArea) { maxArea = a; outerIdx = i; }
    }
  }

  gfx.lineStyle(strokeW, stroke, 1);
  for (let i = 0; i < loops.length; i++) {
    gfx.fillStyle(i === outerIdx ? fill : holeFill, 1);
    gfx.beginPath();
    traceLoopSubpath(gfx, loops[i], cornerR);
    gfx.fillPath();
    gfx.strokePath();
  }
}

function loopArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

// Append ONE loop as a subpath (moveTo + lineTos + closePath). Caller wraps
// all subpaths in a single beginPath / fillPath / strokePath.
function traceLoopSubpath(gfx, loop, cornerR) {
  const n = loop.length;
  // Clamp corner radius so it never exceeds half the shortest adjacent edge.
  let minHalf = Infinity;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    if (d < minHalf) minHalf = d;
  }
  const r = Math.max(1, Math.min(cornerR, minHalf));

  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const toPrev = unitVec(prev[0] - curr[0], prev[1] - curr[1]);
    const toNext = unitVec(next[0] - curr[0], next[1] - curr[1]);
    const pIn  = [curr[0] + toPrev[0] * r, curr[1] + toPrev[1] * r];
    const pOut = [curr[0] + toNext[0] * r, curr[1] + toNext[1] * r];
    if (i === 0) gfx.moveTo(pIn[0], pIn[1]);
    else         gfx.lineTo(pIn[0], pIn[1]);
    // Phaser Graphics has no quadraticCurveTo — sample the bezier ourselves.
    sampleQuadratic(gfx, pIn, curr, pOut, 8);
  }
  gfx.closePath();
}

function sampleQuadratic(gfx, p0, p1, p2, steps) {
  // B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    gfx.lineTo(x, y);
  }
}

// Per-cell labels — paint a single mini form+color glyph centered on each
// labeled cell. Single-cell factories: the lone label means "wildcard input,
// labeled output". Multi-cell: each labeled cell constrains its own funnels.
function drawCellLabels(gfx, cells, pxCell, pxGap, scale) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  const iconR = Math.max(4, Math.round(pxCell * scale * 0.22));
  const strokeW = Math.max(1, Math.round(outlineWidth(pxCell) * 0.6));
  for (const cell of cells) {
    if (!cell.label) continue;
    const cx = cell.c * step + pxCell / 2;
    const cy = cell.r * step + pxCell / 2;
    gfx.lineStyle(strokeW, 0x000000, 0.9);
    drawMiniForm(gfx, cx, cy, iconR, cell.label);
  }
}

// Legacy badge — kept around in case some code path still references it. Not
// invoked from renderFactoryBody anymore.
// eslint-disable-next-line no-unused-vars
function drawConverterBadge(gfx, cells, pxCell, pxGap, scale, converter) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  let cx = 0, cy = 0;
  for (const { r, c } of cells) { cx += c * step + pxCell / 2; cy += r * step + pxCell / 2; }
  cx /= cells.length;
  cy /= cells.length;

  const iconR = Math.max(3, pxCell * scale * 0.16);
  const gap   = iconR * 1.6;
  const inX   = cx - gap;
  const outX  = cx + gap;
  const strokeW = Math.max(1, Math.round(outlineWidth(pxCell) * 0.6));

  // Faint dark wash so the badge reads on the grey body.
  gfx.fillStyle(0x000000, 0.18);
  gfx.fillRoundedRect(cx - gap - iconR - 4, cy - iconR - 3, gap * 2 + iconR * 2 + 8, iconR * 2 + 6, iconR * 0.6);

  gfx.lineStyle(strokeW, 0x000000, 0.9);
  drawMiniForm(gfx, inX,  cy, iconR, converter.in);
  drawMiniForm(gfx, outX, cy, iconR, converter.out);

  // Arrow between the two icons.
  gfx.lineStyle(strokeW, 0x000000, 0.85);
  const ax = cx - iconR * 0.45;
  const bx = cx + iconR * 0.45;
  gfx.beginPath();
  gfx.moveTo(ax, cy);
  gfx.lineTo(bx, cy);
  gfx.strokePath();
  const head = iconR * 0.45;
  gfx.beginPath();
  gfx.moveTo(bx, cy);
  gfx.lineTo(bx - head, cy - head * 0.7);
  gfx.lineTo(bx - head, cy + head * 0.7);
  gfx.closePath();
  gfx.fillStyle(0x000000, 0.85);
  gfx.fillPath();
}

function drawMiniForm(gfx, cx, cy, r, type) {
  // Partial label dispatch:
  //   {form, color}  → existing form glyph in color (default)
  //   {form}         → form glyph filled WHITE (color-axis is wildcard)
  //   {color}        → puddle blob filled in color (form-axis is wildcard)
  //   {} / null      → fallback to DEFAULT_SHAPE_TYPE
  const hasForm  = !!(type && type.form);
  const hasColor = !!(type && type.color);
  if (!hasForm && hasColor) {
    gfx.fillStyle(COLOR_HEX[type.color], 1);
    drawPuddle(gfx, cx, cy, r);
    return;
  }
  const form = hasForm ? type.form : DEFAULT_SHAPE_TYPE.form;
  const fill = hasColor
    ? COLOR_HEX[type.color]
    : (hasForm ? 0xffffff : COLOR_HEX[DEFAULT_SHAPE_TYPE.color]);
  gfx.fillStyle(fill, 1);
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(cx - s / 2, cy - s / 2, s, s);
      gfx.strokeRect(cx - s / 2, cy - s / 2, s, s);
      return;
    }
    case 'triangle': {
      const h = r * 2;
      const halfBase = r * 1.05;
      gfx.beginPath();
      gfx.moveTo(cx,            cy - h * 0.6);
      gfx.lineTo(cx - halfBase, cy + h * 0.4);
      gfx.lineTo(cx + halfBase, cy + h * 0.4);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      return;
    }
    case 'circle':
    default: {
      gfx.fillCircle(cx, cy, r);
      gfx.strokeCircle(cx, cy, r);
    }
  }
}

function mixColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
