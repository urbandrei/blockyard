import { traceFactoryLoops, unitVec, COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_SCALE, BLOCK_LIGHT, BLOCK_DARK, BLOCK_STROKE, SINGLE_CELL_FILL, outlineWidth } from '../constants.js';
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

// Powered-factory palette — any factory carrying a lightning bolt renders
// in dark green when idle and brightens to the lit shade as its bolts
// power up. The scene drives this via an overlay gfx whose alpha tracks
// the factory's max bolt glow.
const CIRCUIT_BG     = 0x1a3d2a;   // unpowered (dark green)
const CIRCUIT_BG_LIT = 0x4ea96b;   // fully powered (lighter green)

function hasAnyBolt(cells) {
  if (!Array.isArray(cells)) return false;
  for (const cell of cells) if (cell.bolt) return true;
  return false;
}

export function renderFactoryBody(scene, container, { cells, pxCell, pxGap, scale = SHAPE_SCALE, fill, stroke, invalid, caution, rotation = 0 }) {
  const gfx = scene.make.graphics({ add: false });
  // Invalid factories paint their perimeter in red so the author sees at a
  // glance which block needs fixing; the actual reason floats as text near
  // the body (see EditorScene._drawFactory).
  const effectiveStroke = invalid ? 0xd02020 : stroke;
  // Powered (laser-gated) factories render as a circuit board: dark green
  // substrate + silver traces. Caution + explicit `fill` overrides still
  // win so obstacles and special tints aren't clobbered.
  const isPowered = hasAnyBolt(cells) && !caution;
  let effectiveFill;
  if (caution)                           effectiveFill = CAUTION_YELLOW;
  else if (fill != null)                 effectiveFill = fill;
  else if (isPowered)                    effectiveFill = CIRCUIT_BG;
  else if (cells && cells.length === 1)  effectiveFill = SINGLE_CELL_FILL;
  drawFactoryBodyInto(gfx, cells, pxCell, pxGap, scale, { fill: effectiveFill, stroke: effectiveStroke });
  if (caution) drawCautionStripesInto(gfx, cells, pxCell, pxGap, scale, rotation);

  // Body goes in FIRST so the later-added labels render ON TOP (Phaser
  // containers draw in insertion order).
  container.add(gfx);

  // Lit-green overlay for powered factories — identical silhouette painted
  // in CIRCUIT_BG_LIT. The scene drives its alpha from the factory's max
  // bolt glow so the body visibly brightens as it powers on.
  if (isPowered) {
    const [cx, cy] = factoryCellsCenter(cells, pxCell, pxGap);
    const litGfx = scene.make.graphics({ add: false });
    drawFactoryBodyInto(litGfx, cells, pxCell, pxGap, scale, { fill: CIRCUIT_BG_LIT, stroke: effectiveStroke });
    litGfx.setPosition(-cx, -cy);
    litGfx.alpha = 0;
    container.add(litGfx);
    gfx.poweredGlow = litGfx;
  }

  gfx.labels = buildCellLabels(scene, cells, pxCell, pxGap, scale, container);
  gfx.bolts  = buildBoltGlyphs(scene, cells, pxCell, pxGap, scale, container);
  return gfx;
}

function factoryCellsCenter(cells, pxCell, pxGap) {
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    if (cell.r < minR) minR = cell.r; if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c; if (cell.c > maxC) maxC = cell.c;
  }
  const step = pxCell + pxGap;
  return [
    ((minC + maxC) * step + pxCell) / 2,
    ((minR + maxR) * step + pxCell) / 2,
  ];
}

// Lightning-bolt glyphs for cells that carry the `bolt` flag. Rendered as a
// separate gfx per cell so scenes can pulse/dim each one independently as
// its power state flips. Callers stash a handle on `gfx.bolts` and update
// `bolt.powered` from the sim each frame.
function buildBoltGlyphs(scene, cells, pxCell, pxGap, scale, container) {
  if (!cells || cells.length === 0) return [];
  const step = pxCell + pxGap;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    if (cell.r < minR) minR = cell.r;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.c > maxC) maxC = cell.c;
  }
  const cx = ((minC + maxC) * step + pxCell) / 2;
  const cy = ((minR + maxR) * step + pxCell) / 2;
  const size = Math.max(8, Math.round(pxCell * scale * 0.34));
  const bolts = [];
  for (const cell of cells) {
    if (!cell.bolt) continue;
    const g = scene.make.graphics({ add: false });
    g.x = cell.c * step + pxCell / 2 - cx;
    g.y = cell.r * step + pxCell / 2 - cy;
    container.add(g);
    // Initial draw at glow=0 (unpowered: white-outlined silhouette).
    drawBoltInto(g, size, 0, 0);
    bolts.push({ gfx: g, cellR: cell.r, cellC: cell.c, size, glow: 0 });
  }
  return bolts;
}

// Bolt polygon. `size` is the rough half-height; width ~size*0.55. Centered
// at (cx, cy). Pulled into its own helper so the per-frame draw can reuse
// the same vertex set for clipping / stroking / fill.
export function boltPolygonPoints(cx, cy, size) {
  const h = size;
  const w = size * 0.85;   // widened silhouette — reads bigger on a powered cell
  return [
    [ cx + w * 0.15, cy - h        ],
    [ cx - w * 0.60, cy - h * 0.15 ],
    [ cx - w * 0.10, cy - h * 0.15 ],
    [ cx - w * 0.35, cy + h        ],
    [ cx + w * 0.70, cy + h * 0.05 ],
    [ cx + w * 0.15, cy + h * 0.05 ],
    [ cx + w * 0.55, cy - h * 0.65 ],
    [ cx + w * 0.05, cy - h * 0.65 ],
  ];
}

// Draw a lightning bolt at three states driven by `glow ∈ [0, 1]`:
//   glow = 0       → white-outlined silhouette, no fill ("off").
//   0 < glow < 1   → yellow fills from the bottom up ("powering up").
//   glow ≥ 1       → solid bright yellow + wavy electricity arcs around.
// `timeMs` drives the wavy-arc animation at full power.
export function drawBoltInto(gfx, size, glow, timeMs) {
  gfx.clear();
  const pts = boltPolygonPoints(0, 0, size);
  let minY = Infinity, maxY = -Infinity;
  for (const [, py] of pts) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const h = maxY - minY;
  const strokeW = Math.max(1, Math.round(size * 0.14));

  // Grey silhouette, always on — so the shape reads even when unpowered.
  gfx.fillStyle(0x3a3a3a, 0.85);
  gfx.lineStyle(strokeW, 0xa0a4aa, 1);
  tracePoly(gfx, pts);
  gfx.fillPath();
  gfx.strokePath();

  // Yellow fill, clipped to the bottom `glow * h` portion — draws the
  // "filling up" animation as a rising yellow silhouette inside the outline.
  if (glow > 0) {
    const fillY = maxY - h * Math.min(1, glow);
    const lower = clipHalfPlane(pts, (_x, y) => y - fillY);
    if (lower.length >= 3) {
      gfx.fillStyle(0xffd84a, 1);
      gfx.lineStyle(0, 0, 0);
      tracePoly(gfx, lower);
      gfx.fillPath();
    }
  }

  // Full-power juice: bright inner stroke, fades in over the top 20% of
  // glow so it doesn't pop on. The lively "electricity" now animates on
  // the factory body's perimeter instead of on the bolt itself.
  if (glow > 0.8) {
    const brightness = Math.min(1, (glow - 0.8) / 0.2);
    gfx.lineStyle(Math.max(1, Math.round(strokeW * 0.7)), 0xfff27a, brightness);
    tracePoly(gfx, pts);
    gfx.strokePath();
  }
}

function tracePoly(gfx, pts) {
  gfx.beginPath();
  gfx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i][0], pts[i][1]);
  gfx.closePath();
}

// Create one Graphics per labeled cell, positioned in the body's wrap-local
// coord system (so when the caller does `body.setPosition(-cx, -cy)`, the
// labels already sit on the right cell centers — they don't need to be
// moved). Each label draws its mini-form at its own origin (0, 0) so the
// label's own `.rotation` can counter-rotate against a spinning bodyWrap
// without translating the glyph.
function buildCellLabels(scene, cells, pxCell, pxGap, scale, container) {
  if (!cells || cells.length === 0) return [];
  const step = pxCell + pxGap;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    if (cell.r < minR) minR = cell.r;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.c > maxC) maxC = cell.c;
  }
  const cx = ((minC + maxC) * step + pxCell) / 2;
  const cy = ((minR + maxR) * step + pxCell) / 2;
  const iconR = Math.max(4, Math.round(pxCell * scale * 0.22));
  const strokeW = Math.max(1, Math.round(outlineWidth(pxCell) * 0.6));
  const labels = [];
  for (const cell of cells) {
    if (!cell.label) continue;
    const lblGfx = scene.make.graphics({ add: false });
    lblGfx.lineStyle(strokeW, 0x000000, 0.9);
    drawMiniForm(lblGfx, 0, 0, iconR, cell.label);
    lblGfx.x = cell.c * step + pxCell / 2 - cx;
    lblGfx.y = cell.r * step + pxCell / 2 - cy;
    container.add(lblGfx);
    labels.push(lblGfx);
  }
  return labels;
}

// Paint 45°-angled black hazard-tape stripes over the yellow body, clipped
// per cell/bridge rect.
//
// Rotation-consistency trick:
//   Stripe direction follows rotation parity — even rotations draw `/`,
//   odd draw `\`. Bands are CENTERED on pitch multiples in factory-center-
//   shifted coords (i.e. each stripe spans [k·pitch − sW/2, k·pitch + sW/2]
//   around the line (x−cx)±(y−cy) = k·pitch). Centered bands at integer
//   k·pitch are rotation-invariant: under any 90° rotation around the
//   factory center the set of stripes maps onto itself, so the tween-end
//   visual and the fresh re-render land on identical patterns.
function drawCautionStripesInto(gfx, cells, pxCell, pxGap, scale, rotation = 0) {
  if (!cells || cells.length === 0) return;
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const stripeW = Math.max(6, Math.round(pxCell * 0.24));
  const pitch = stripeW * 2; // equal-width yellow and black bands

  // Collect convex rects covering the body.
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

  // Factory center in gfx-local coords — matches `body.setPosition(-cx, -cy)`
  // used by every caller, so (x − cx, y − cy) is wrap-origin-centered.
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    if (cell.r < minR) minR = cell.r;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.c > maxC) maxC = cell.c;
  }
  const cx = ((minC + maxC) * step + pxCell) / 2;
  const cy = ((minR + maxR) * step + pxCell) / 2;

  const useBackslash = (((rotation % 4) + 4) % 4) % 2 === 1;
  const dFn = useBackslash
    ? (px, py) => (px - cx) - (py - cy)
    : (px, py) => (px - cx) + (py - cy);

  let dcMin = Infinity, dcMax = -Infinity;
  for (const [x, y, w, h] of rects) {
    for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
      const dv = dFn(px, py);
      if (dv < dcMin) dcMin = dv;
      if (dv > dcMax) dcMax = dv;
    }
  }

  gfx.fillStyle(CAUTION_BLACK, 1);
  // Iterate every k·pitch line that could touch the shape. Each stripe is
  // CENTERED on d = k·pitch, spanning [d − sW/2, d + sW/2].
  const halfW = stripeW / 2;
  const kStart = Math.floor((dcMin - halfW) / pitch) - 1;
  const kEnd   = Math.ceil((dcMax + halfW) / pitch) + 1;
  for (let k = kStart; k <= kEnd; k++) {
    const d = k * pitch;
    const d1 = d - halfW, d2 = d + halfW;
    for (const [x, y, w, h] of rects) {
      let rMin = Infinity, rMax = -Infinity;
      for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        const dv = dFn(px, py);
        if (dv < rMin) rMin = dv;
        if (dv > rMax) rMax = dv;
      }
      if (rMax < d1 || rMin > d2) continue;
      const poly = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      let p = clipHalfPlane(poly, (px, py) => dFn(px, py) - d1);
      p = clipHalfPlane(p, (px, py) => d2 - dFn(px, py));
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
