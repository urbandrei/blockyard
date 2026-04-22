// Two concepts share the "shape" word in this project — keep them separate:
//
//   1. FACTORY SHAPE  — the cell configuration of a factory body. All the
//      geometry helpers below (`isAdjacentToFactory`, `normalizeFactory`,
//      `traceFactoryLoops`, …) work on this concept.
//
//   2. SIM SHAPE TYPE — the form+color of a flowing unit in the simulation
//      (ShapeType / Form / Color, exported at the bottom of this file). These
//      are pure value types used by the sim and the renderers.
//
// The legacy constant `SHAPE_SCALE` refers to FACTORY shape (body scale inside
// a grid cell). The `shapeSquash` pulse curve likewise refers to factory
// bodies, not sim shapes.

import { SHAPE_SCALE } from '../constants.js';

const cellKey = (r, c) => `${r},${c}`;
const parseKey = (k) => { const [r, c] = k.split(',').map(Number); return { r, c }; };

export function cellsToSet(cells) {
  return new Set(cells.map(({ r, c }) => cellKey(r, c)));
}

export function isContiguous(cells) {
  if (cells.length <= 1) return true;
  const set = cellsToSet(cells);
  const start = cellKey(cells[0].r, cells[0].c);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const { r, c } = parseKey(queue.shift());
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const k = cellKey(r + dr, c + dc);
      if (set.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return seen.size === set.size;
}

export function isAdjacentToFactory(cells, r, c) {
  if (cells.length === 0) return true;
  const set = cellsToSet(cells);
  return (
    set.has(cellKey(r - 1, c)) ||
    set.has(cellKey(r + 1, c)) ||
    set.has(cellKey(r, c - 1)) ||
    set.has(cellKey(r, c + 1))
  );
}

export function perimeterEdges(cells) {
  const set = cellsToSet(cells);
  const edges = [];
  for (const { r, c } of cells) {
    if (!set.has(cellKey(r - 1, c))) edges.push({ r, c, side: 'top' });
    if (!set.has(cellKey(r + 1, c))) edges.push({ r, c, side: 'bottom' });
    if (!set.has(cellKey(r, c - 1))) edges.push({ r, c, side: 'left' });
    if (!set.has(cellKey(r, c + 1))) edges.push({ r, c, side: 'right' });
  }
  return edges;
}

export function isPerimeterEdge(cells, r, c, side) {
  const set = cellsToSet(cells);
  if (!set.has(cellKey(r, c))) return false;
  const nb = { top: [r - 1, c], bottom: [r + 1, c], left: [r, c - 1], right: [r, c + 1] }[side];
  return !set.has(cellKey(nb[0], nb[1]));
}

function boundingBox(cells) {
  if (cells.length === 0) return { minR: 0, minC: 0, maxR: -1, maxC: -1 };
  let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
  for (const { r, c } of cells) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { minR, minC, maxR, maxC };
}

// Normalize a factory's cells (and attached funnels) so the bounding box
// starts at (0, 0). Used both when placing a draft onto the board and when
// storing an imported / saved factory.
export function normalizeFactory(rawCells, rawFunnels = []) {
  const bbox = boundingBox(rawCells);
  if (rawCells.length === 0) return { cells: [], funnels: [], rows: 0, cols: 0 };
  const cells = rawCells.map((cell) => ({ ...cell, r: cell.r - bbox.minR, c: cell.c - bbox.minC }));
  const funnels = rawFunnels.map((f) => ({ ...f, r: f.r - bbox.minR, c: f.c - bbox.minC }));
  return {
    cells,
    funnels,
    rows: bbox.maxR - bbox.minR + 1,
    cols: bbox.maxC - bbox.minC + 1,
  };
}

// ---------- Rotation ----------
// Rotate a factory's cells (and attached funnels) 90° CW around the bounding-
// box origin. After rotation the result is re-normalized so cells start at
// (0,0). Funnel sides rotate top→right→bottom→left→top.
//
// `times` may be any integer (negative for CCW). Identity at multiples of 4.

const SIDE_ROTATE_CW = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };

export function rotateFactoryShape({ cells, funnels = [] }, times = 1) {
  const n = ((times % 4) + 4) % 4;
  let curCells = cells.map((c) => ({ ...c }));
  let curFunnels = funnels.map((f) => ({ ...f }));
  for (let i = 0; i < n; i++) {
    const maxR = curCells.reduce((m, c) => (c.r > m ? c.r : m), 0);
    curCells = curCells.map((cell) => ({ ...cell, r: cell.c, c: maxR - cell.r }));
    curFunnels = curFunnels.map((f) => ({
      ...f,
      r: f.c,
      c: maxR - f.r,
      side: SIDE_ROTATE_CW[f.side] || f.side,
    }));
  }
  const norm = normalizeFactory(curCells, curFunnels);
  return { cells: norm.cells, funnels: norm.funnels, rows: norm.rows, cols: norm.cols };
}

// ---------- Cell-label helpers ----------
// A factory's cells may carry per-cell `label: ShapeType` (form+color). These
// drive funnel typing in the sim:
//   • Single-cell labeled factory → INPUTS are wildcard, OUTPUTS emit label.
//   • Multi-cell factory → funnels on labeled cells inherit the label
//     (input = only accepts that type, output = only emits it).

export function cellLabelAt(cells, r, c) {
  if (!Array.isArray(cells)) return null;
  for (const cell of cells) {
    if (cell.r === r && cell.c === c && cell.label) return cell.label;
  }
  return null;
}

export function hasAnyLabel(cells) {
  if (!Array.isArray(cells)) return false;
  for (const cell of cells) if (cell.label) return true;
  return false;
}

// Check whether a factory's labels + funnels form a valid configuration.
// Returns `{ valid: true }` when OK or `{ valid: false, error: string }`
// with a short human-readable reason. Validation rules (per the per-cell
// label model):
//   • Pass-through (no labels anywhere) must have exactly ONE input funnel.
//   • Multi-cell factories must have every output funnel on a labeled cell
//     (output funnels on unlabeled cells are underspecified — we wouldn't
//     know what shape to emit).
//   • Single-cell labeled factories are always valid.
// True when a factory has no funnels at all — it's a pure obstacle (a wall
// that blocks shape flow without consuming or producing anything). The body
// renderer paints these in hazard-tape yellow-and-black stripes so the
// player reads them as "obstacle" rather than a normal factory.
export function isObstacleFactory(funnels) {
  return !Array.isArray(funnels) || funnels.length === 0;
}

export function validateFactory({ cells = [], funnels = [] } = {}) {
  const hasLabels = hasAnyLabel(cells);
  const inputs  = funnels.filter((f) => f.role !== 'output');
  const outputs = funnels.filter((f) => f.role === 'output');

  if (!hasLabels) {
    if (inputs.length === 0 && outputs.length === 0) return { valid: true };   // no funnels yet — still authoring
    if (inputs.length === 0)  return { valid: false, error: 'needs an input' };
    if (inputs.length > 1)    return { valid: false, error: 'pass-through needs 1 input' };
    return { valid: true };
  }

  if (cells.length > 1) {
    for (const f of outputs) {
      const cell = cells.find((c) => c.r === f.r && c.c === f.c);
      if (!cell || !cell.label) {
        return { valid: false, error: 'output must sit on a labeled cell' };
      }
    }
  }
  return { valid: true };
}

// ---------- Border helpers ----------
// The border is the outer ring of the board. Auto-generated from board size;
// user edits only its funnels.

export function borderCells(board) {
  const { cols, rows } = board;
  const out = [];
  for (let c = 0; c < cols; c++) { out.push({ r: 0, c }); if (rows > 1) out.push({ r: rows - 1, c }); }
  for (let r = 1; r < rows - 1; r++) { out.push({ r, c: 0 }); if (cols > 1) out.push({ r, c: cols - 1 }); }
  return out;
}

export function isBorderCell(board, r, c) {
  return r === 0 || r === board.rows - 1 || c === 0 || c === board.cols - 1;
}

// Canonical inner-facing side for a border cell, or null for corners.
export function innerSideOf(board, r, c) {
  const { cols, rows } = board;
  const topRow = r === 0;
  const botRow = r === rows - 1;
  const leftCol = c === 0;
  const rightCol = c === cols - 1;
  if ((topRow || botRow) && (leftCol || rightCol)) return null;
  if (topRow) return 'bottom';
  if (botRow) return 'top';
  if (leftCol) return 'right';
  if (rightCol) return 'left';
  return null;
}

// ---------- Perimeter path tracing (for rounded merged factory-body rendering) ----------

// Returns an array of closed perimeter loops (arrays of [x, y] vertices in
// pixel user-space) for the factory, with cells at scale `scale` of pxCell
// and gap `pxGap` between board cells. Handles bridges across adjacent inner
// cells. For ring-like factories (e.g. the border), returns both the outer
// and inner perimeters as separate loops.
export function traceFactoryLoops(cells, pxCell, pxGap, scale) {
  const set = cellsToSet(cells);
  const H = (r, c) => set.has(cellKey(r, c));
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const bridgeW = step - inner;
  const edges = [];
  const pushEdge = (x1, y1, x2, y2) => edges.push({ from: [x1, y1], to: [x2, y2] });

  for (const { r, c } of cells) {
    const x = c * step + m, y = r * step + m;
    const xR = x + inner, yB = y + inner;
    if (!H(r - 1, c)) pushEdge(x,  y,  xR, y);
    if (!H(r, c + 1)) pushEdge(xR, y,  xR, yB);
    if (!H(r + 1, c)) pushEdge(xR, yB, x,  yB);
    if (!H(r, c - 1)) pushEdge(x,  yB, x,  y);

    if (bridgeW > 0 && H(r, c + 1)) {
      const xNext = (c + 1) * step + m;
      if (!(H(r - 1, c) && H(r - 1, c + 1))) pushEdge(xR,    y,  xNext, y);
      if (!(H(r + 1, c) && H(r + 1, c + 1))) pushEdge(xNext, yB, xR,    yB);
    }
    if (bridgeW > 0 && H(r + 1, c)) {
      const yNext = (r + 1) * step + m;
      if (!(H(r, c - 1) && H(r + 1, c - 1))) pushEdge(x,  yNext, x,  yB);
      if (!(H(r, c + 1) && H(r + 1, c + 1))) pushEdge(xR, yB,    xR, yNext);
    }
  }

  const keyOf = (p) => `${p[0]},${p[1]}`;
  const byFrom = new Map();
  edges.forEach((e, i) => byFrom.set(keyOf(e.from), i));

  const visited = new Set();
  const loops = [];
  for (let s = 0; s < edges.length; s++) {
    if (visited.has(s)) continue;
    const loop = [];
    let i = s;
    while (!visited.has(i)) {
      visited.add(i);
      loop.push(edges[i].from);
      const next = byFrom.get(keyOf(edges[i].to));
      if (next === undefined || next === s) break;
      i = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops.map(collapseCollinear).filter((l) => l.length >= 3);
}

function collapseCollinear(loop) {
  const n = loop.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross !== 0) out.push(curr);
  }
  return out;
}

export function unitVec(x, y) {
  const d = Math.hypot(x, y);
  return d === 0 ? [0, 0] : [x / d, y / d];
}

// ---------- Funnel / edge geometry ----------

export function edgeMidpoint(r, c, side, pxCell, pxGap, scale = SHAPE_SCALE) {
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

export function funnelPolyPoints(r, c, side, pxCell, pxGap, scale = SHAPE_SCALE) {
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const x0 = c * step + m, y0 = r * step + m;
  const cx = x0 + inner / 2, cy = y0 + inner / 2;
  const funInner = pxCell * SHAPE_SCALE;   // triangle size always interior size
  const h = Math.round(funInner * 0.5);
  const base = Math.round(funInner * 0.55);
  const half = base / 2;
  const halfH = h / 2;
  switch (side) {
    case 'top':    return [[cx, y0 + halfH],          [cx - half, y0 - halfH],         [cx + half, y0 - halfH]];
    case 'bottom': return [[cx, y0 + inner - halfH],  [cx - half, y0 + inner + halfH], [cx + half, y0 + inner + halfH]];
    case 'left':   return [[x0 + halfH, cy],          [x0 - halfH, cy - half],         [x0 - halfH, cy + half]];
    case 'right':  return [[x0 + inner - halfH, cy],  [x0 + inner + halfH, cy - half], [x0 + inner + halfH, cy + half]];
  }
  return [];
}

export function cellCenterPx(r, c, pxCell, pxGap) {
  const step = pxCell + pxGap;
  return [c * step + pxCell / 2, r * step + pxCell / 2];
}

// ---------- Manifold flow-path tracing (input→output) ----------

export function buildManifoldSegments(cells, funnels, pxCell, pxGap, scale) {
  const inputs = funnels.filter((f) => f.role !== 'output');
  const outputs = funnels.filter((f) => f.role === 'output');
  if (inputs.length === 0 || outputs.length === 0) return [];

  const arcR = pxCell * scale * 0.3;
  const segments = [];
  for (const inF of inputs) {
    for (const outF of outputs) {
      const inMid = edgeMidpoint(inF.r, inF.c, inF.side, pxCell, pxGap, scale);
      const outMid = edgeMidpoint(outF.r, outF.c, outF.side, pxCell, pxGap, scale);
      const inExit = SIDE_TO_EXIT_IMPORTED[inF.side];
      const cellPath = bfsCellPath(cells, { r: inF.r, c: inF.c }, { r: outF.r, c: outF.c }, inExit);
      const pts = [inMid];
      for (const cc of cellPath) pts.push(cellCenterPx(cc.r, cc.c, pxCell, pxGap));
      pts.push(outMid);
      segments.push({ pts, startPt: inMid, endPt: outMid, arcR });
    }
  }
  return segments;
}

// local copy of the side→exit table so this file stays self-contained
const SIDE_TO_EXIT_IMPORTED = { top: [1, 0], bottom: [-1, 0], left: [0, 1], right: [0, -1] };

function bfsCellPath(cells, start, end, preferredFirstDir) {
  const set = cellsToSet(cells);
  const startKey = cellKey(start.r, start.c);
  const endKey = cellKey(end.r, end.c);
  if (startKey === endKey) return [start];

  const allDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let startDirs = allDirs;
  if (preferredFirstDir) {
    const [pr, pc] = preferredFirstDir;
    const perp = allDirs.filter(([dr, dc]) => !(dr === pr && dc === pc) && !(dr === -pr && dc === -pc));
    startDirs = [preferredFirstDir, ...perp, [-pr, -pc]];
  }

  const prev = new Map();
  prev.set(startKey, null);
  const queue = [start];
  while (queue.length) {
    const curr = queue.shift();
    const ck = cellKey(curr.r, curr.c);
    if (ck === endKey) break;
    const dirs = ck === startKey ? startDirs : allDirs;
    for (const [dr, dc] of dirs) {
      const nr = curr.r + dr, nc = curr.c + dc;
      const nk = cellKey(nr, nc);
      if (set.has(nk) && !prev.has(nk)) {
        prev.set(nk, curr);
        queue.push({ r: nr, c: nc });
      }
    }
  }
  if (!prev.has(endKey)) return [start];
  const path = [];
  let cur = end;
  while (cur) {
    path.push(cur);
    cur = prev.get(cellKey(cur.r, cur.c));
  }
  return path.reverse();
}

// ---------- Sim shape type (form + color of a flowing unit) ----------

/**
 * @typedef {'circle'|'square'|'triangle'} Form
 * @typedef {'red'|'green'|'blue'} Color
 * @typedef {{ form: Form, color: Color }} ShapeType
 */

export const FORMS = Object.freeze(['circle', 'square', 'triangle']);
export const COLORS = Object.freeze(['red', 'green', 'blue']);

/** Palette hex values keyed by color name. Used by ShapeRenderer. */
export const COLOR_HEX = Object.freeze({
  red:   0xd94c4c,
  green: 0x4caf50,
  blue:  0x3e8ed0,
});

/** Default shape type used when a spawn/expect does not specify one. */
export const DEFAULT_SHAPE_TYPE = Object.freeze({ form: 'circle', color: 'blue' });

export function isValidShapeType(t) {
  return !!t && FORMS.includes(t.form) && COLORS.includes(t.color);
}
