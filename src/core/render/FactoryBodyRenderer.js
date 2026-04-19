import { traceFactoryLoops, unitVec, COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_SCALE, BLOCK_LIGHT, BLOCK_DARK, BLOCK_STROKE, outlineWidth } from '../constants.js';
import { drawPuddle } from './shapes.js';

// Renders a factory body (one or more cells, merged) as a Phaser Graphics
// game object. Uses perimeter-tracing + quadratic-bezier rounded corners.
// Gradient fills aren't in Phaser Graphics natively; we mix BLOCK_LIGHT and
// BLOCK_DARK into a single mid-tone fill.

export function renderFactoryBody(scene, container, { cells, pxCell, pxGap, scale = SHAPE_SCALE, fill, stroke, locked, invalid }) {
  const gfx = scene.make.graphics({ add: false });
  // Invalid factories paint their perimeter in red so the author sees at a
  // glance which block needs fixing; the actual reason floats as text near
  // the body (see EditorScene._drawFactory).
  const effectiveStroke = invalid ? 0xd02020 : stroke;
  drawFactoryBodyInto(gfx, cells, pxCell, pxGap, scale, { fill, stroke: effectiveStroke });
  if (locked) {
    // Darken the body cells before labels paint, so the lock state reads
    // at a glance for boss carry-over factories. Labels + lock pin sit on
    // top of the dim wash.
    drawLockedTint(gfx, cells, pxCell, pxGap, scale);
  }
  // Per-cell labels — one mini form+color glyph centered on each labeled cell.
  drawCellLabels(gfx, cells, pxCell, pxGap, scale);
  if (locked) {
    drawLockPin(gfx, cells, pxCell, pxGap, scale);
  }
  container.add(gfx);
  return gfx;
}

// Faint dark overlay over every cell of a locked factory. Reads as
// "this block is pinned in place" without obscuring the underlying body
// color or the per-cell labels.
function drawLockedTint(gfx, cells, pxCell, pxGap, scale) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  gfx.fillStyle(0x000000, 0.22);
  for (const { r, c } of cells) {
    gfx.fillRect(c * step + m, r * step + m, inner, inner);
  }
}

// Anchor-pin accent in the factory's top-right corner cell, marking it as
// non-draggable. Drawn as a filled disc + a downward triangle (a stylized
// pushpin) so it reads as "fixed in place" without text.
function drawLockPin(gfx, cells, pxCell, pxGap, scale) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  // Anchor to the top-rightmost cell so the pin doesn't hide the converter
  // badge (which lives near centroid).
  let pick = cells[0];
  for (const c of cells) {
    if (c.r < pick.r || (c.r === pick.r && c.c > pick.c)) pick = c;
  }
  const x = pick.c * step + m + inner;
  const y = pick.r * step + m;
  const r = Math.max(4, Math.round(inner * 0.12));
  // Disc (head) + small triangle (point) just inside the corner.
  gfx.fillStyle(0xffffff, 0.95);
  gfx.lineStyle(Math.max(1, Math.round(outlineWidth(pxCell) * 0.6)), 0x1a2332, 1);
  gfx.fillCircle(x - r, y + r, r);
  gfx.strokeCircle(x - r, y + r, r);
  gfx.beginPath();
  gfx.moveTo(x - r * 1.6, y + r * 1.6);
  gfx.lineTo(x - r * 0.4, y + r * 1.6);
  gfx.lineTo(x - r,       y + r * 2.6);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
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
