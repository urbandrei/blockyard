// Catalog of all draggable + tap-only tools surfaced by the editor's
// palette bar. Each tool is data: an id, a category (which palette slot it
// belongs to), a drawIcon(g, cx, cy, size) helper, and a payload used by
// applyToolAt(). Keeping these as plain data — not Phaser objects — means
// the same definitions can be rendered into any graphics context (palette
// slot, popup option grid, drag ghost).

import { COLOR_HEX, FORMS, COLORS, funnelPolyPoints } from '../model/shape.js';
import {
  ACID_WHITE,
  FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE,
  FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE,
  FUNNEL_INPUT_FILL as FUNNEL_INPUT_FILL_REF,
  FUNNEL_INPUT_STROKE as FUNNEL_INPUT_STROKE_REF,
  FUNNEL_OUTPUT_FILL as FUNNEL_OUTPUT_FILL_REF,
  FUNNEL_OUTPUT_STROKE as FUNNEL_OUTPUT_STROKE_REF,
  EMITTER_FILL, EMITTER_STROKE,
  COLLECTOR_FILL, COLLECTOR_STROKE,
  ACID_EDGE_STROKE,
  BLOCK_LIGHT, BLOCK_STROKE,
  BUFFER_FILL_ALT, FRAME_STROKE,
} from '../constants.js';
import { emitterPolyPoints } from '../render/EmitterGlyph.js';

// Slot indices — referenced by PaletteBar / PaletteDragController so the
// numeric position is named, not magic.
export const SLOT = Object.freeze({
  FACTORY:     0,
  FUNNEL:      1,
  BOARD_PIECE: 2,
  LABEL:       3,
  TRASH:       4,
  UNDO:        5,
  HELP:        6,
});
export const SLOT_COUNT = 7;

// ---------- icon drawing helpers ----------
//
// Each helper draws into a Phaser Graphics object centered at (cx, cy)
// fitting roughly within a `size`-pixel square. Strokes are kept thin
// (~max(1, size*0.07)) so icons read at all palette zoom levels.

function lw(size) { return Math.max(1, Math.round(size * 0.07)); }

function drawFactoryIcon(g, cx, cy, size) {
  const s = size * 0.78;
  const r = Math.max(2, Math.round(s * 0.18));
  g.fillStyle(BLOCK_LIGHT, 1);
  g.lineStyle(lw(size), BLOCK_STROKE, 1);
  g.fillRoundedRect(cx - s / 2, cy - s / 2, s, s, r);
  g.strokeRoundedRect(cx - s / 2, cy - s / 2, s, s, r);
}

function drawTriangleIcon(g, cx, cy, size, fill, stroke) {
  const s = size * 0.78;
  const half = s / 2;
  g.fillStyle(fill, 1);
  g.lineStyle(lw(size), stroke, 1);
  g.beginPath();
  g.moveTo(cx, cy - half);
  g.lineTo(cx + half, cy + half * 0.85);
  g.lineTo(cx - half, cy + half * 0.85);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

// Helper — draw the emitter (or collector) glyph using the actual game
// geometry from EmitterGlyph.js, centered at (cx, cy) and SCALED to fill
// the icon slot (`size * 0.78` to match the other tool icons). The native
// glyph is drawn at SHAPE_SCALE inside the cell with one side protruding,
// so we measure its bounding box and re-center + re-scale here so the
// palette icon fills its slot like every other category icon.
function _drawEmitterShape(g, cx, cy, size, fill, stroke) {
  const REF = 100;
  const polys = emitterPolyPoints(0, 0, 'top', REF, 0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const w = maxX - minX, h = maxY - minY;
  const target = size * 0.78;
  const scale = target / Math.max(w, h);
  const cxRef = (minX + maxX) / 2;
  const cyRef = (minY + maxY) / 2;
  g.fillStyle(fill, 1);
  g.lineStyle(lw(size), stroke, 1);
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const [x0, y0] = poly[0];
    g.beginPath();
    g.moveTo((x0 - cxRef) * scale + cx, (y0 - cyRef) * scale + cy);
    for (let i = 1; i < poly.length; i++) {
      const [x, y] = poly[i];
      g.lineTo((x - cxRef) * scale + cx, (y - cyRef) * scale + cy);
    }
    g.closePath();
    g.fillPath();
    g.strokePath();
  }
}

function drawEmitterIcon(g, cx, cy, size) {
  _drawEmitterShape(g, cx, cy, size, EMITTER_FILL, EMITTER_STROKE);
}

function drawCollectorIcon(g, cx, cy, size) {
  _drawEmitterShape(g, cx, cy, size, COLLECTOR_FILL, COLLECTOR_STROKE);
}

function drawAcidPitIcon(g, cx, cy, size) {
  // Wobbled blob outline + a few bubble circles, mirroring AcidPitRenderer.
  // Fixed seed so the icon is deterministic across redraws.
  const r = (size * 0.78) / 2;
  const STEPS = 28;
  const wobbleAmp = r * 0.07;
  const path = [];
  for (let i = 0; i < STEPS; i++) {
    const t = i / STEPS;
    const a = t * Math.PI * 2;
    // Two-frequency sine for an "alive" perimeter that's deterministic.
    const w = wobbleAmp * (Math.sin(a * 3.1) + 0.5 * Math.sin(a * 5.7));
    const rr = r + w;
    path.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  g.fillStyle(ACID_WHITE, 1);
  g.beginPath();
  g.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) g.lineTo(path[i][0], path[i][1]);
  g.closePath();
  g.fillPath();
  g.lineStyle(lw(size), ACID_EDGE_STROKE, 1);
  g.beginPath();
  g.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) g.lineTo(path[i][0], path[i][1]);
  g.closePath();
  g.strokePath();
  // Bubbles — small dark-stroked circles inside the blob.
  const br = Math.max(1.2, r * 0.13);
  const bubbleStroke = Math.max(1, Math.round(lw(size) * 0.7));
  g.lineStyle(bubbleStroke, ACID_EDGE_STROKE, 0.85);
  for (const [bx, by, scl] of [[-0.35, -0.25, 1.0], [0.30, -0.05, 0.85], [-0.05, 0.40, 0.70]]) {
    g.strokeCircle(cx + bx * r, cy + by * r, br * scl);
  }
}

// Border-piece icon: render `size × size` AS the buffer cell. Tile +
// glyph use the actual game geometry (SHAPE_SCALE-based) translated
// into the icon's local coords, so:
//   - Tile is centered on the cell, sized SHAPE_SCALE * size (60%) —
//     bigger than the funnel.
//   - Funnel apex sits INSIDE the tile's lower portion (overlap), base
//     extends DOWN past the tile but stays INSIDE the cell's bottom edge.
//   - Emitter / collector likewise: base inside the tile, sharp tip
//     extends down inside the cell.
// Result: the entire combined body sits within the square cell — no
// element protrudes below the icon's container.
//
// `role` ∈ { 'input', 'output', 'emitter', 'collector' }
function _drawBorderPieceIcon(g, cx, cy, size, role) {
  const SCALE = 0.6;                      // matches SHAPE_SCALE
  const inner = size * SCALE;
  const m = (size - inner) / 2;
  const cellLeft = cx - size / 2;
  const cellTop  = cy - size / 2;
  const tileX = cellLeft + m;
  const tileY = cellTop  + m;
  const tileR = Math.max(2, Math.round(inner * 0.16));

  let tileFill, tileStroke;
  if      (role === 'emitter')   { tileFill = EMITTER_FILL;   tileStroke = EMITTER_STROKE; }
  else if (role === 'collector') { tileFill = COLLECTOR_FILL; tileStroke = COLLECTOR_STROKE; }
  else if (role === 'output')    { tileFill = FUNNEL_OUTPUT_FILL_REF; tileStroke = FUNNEL_OUTPUT_STROKE_REF; }
  else                            { tileFill = FUNNEL_INPUT_FILL_REF;  tileStroke = FUNNEL_INPUT_STROKE_REF; }

  // ORDER MATTERS: the funnel / emitter / collector glyph paints FIRST so
  // the buffer-label tile lands ON TOP of the overlap region, hiding the
  // glyph's apex/base behind the tile. Matches the in-game render order
  // where the buffer label sits above the funnel in the depth stack.
  if (role === 'input' || role === 'output') {
    const fh    = inner * 0.50;
    const fbase = inner * 0.55;
    const fhalf = fbase / 2;
    const fhalfH = fh / 2;
    const apexY = tileY + inner - fhalfH;     // inside tile lower portion
    const baseY = tileY + inner + fhalfH;     // below tile (still inside cell)
    const fillTri   = role === 'output' ? FUNNEL_OUTPUT_FILL_REF   : FUNNEL_INPUT_FILL_REF;
    const strokeTri = role === 'output' ? FUNNEL_OUTPUT_STROKE_REF : FUNNEL_INPUT_STROKE_REF;
    g.fillStyle(fillTri, 1);
    g.lineStyle(lw(size), strokeTri, 1);
    g.beginPath();
    g.moveTo(cx,         apexY);
    g.lineTo(cx + fhalf, baseY);
    g.lineTo(cx - fhalf, baseY);
    g.closePath();
    g.fillPath();
    g.strokePath();
  } else if (role === 'emitter') {
    _drawEmitterPolyAt(g, cellLeft, cellTop, size, EMITTER_FILL, EMITTER_STROKE);
  } else if (role === 'collector') {
    _drawEmitterPolyAt(g, cellLeft, cellTop, size, COLLECTOR_FILL, COLLECTOR_STROKE);
  }

  // Tile painted ON TOP so it covers the glyph's overlapping portion.
  g.fillStyle(tileFill, 1);
  g.lineStyle(lw(size), tileStroke, 1);
  g.fillRoundedRect(tileX, tileY, inner, inner, tileR);
  g.strokeRoundedRect(tileX, tileY, inner, inner, tileR);

  // Type marker INSIDE the tile.
  const tileCx = tileX + inner / 2;
  const tileCy = tileY + inner / 2;
  if (role === 'emitter' || role === 'collector') {
    const ringR = inner * 0.30;
    const dotR  = inner * 0.16;
    g.lineStyle(Math.max(1, lw(size)), 0xd02020, 1);
    g.strokeCircle(tileCx, tileCy, ringR);
    g.fillStyle(0xd02020, 1);
    g.fillCircle(tileCx, tileCy, dotR);
  } else {
    const dotR = inner * 0.20;
    g.fillStyle(COLOR_HEX.blue, 1);
    g.lineStyle(Math.max(1, lw(size)), 0x000000, 1);
    g.fillCircle(tileCx, tileCy, dotR);
    g.strokeCircle(tileCx, tileCy, dotR);
  }
}

// Draw emitter glyph (side='bottom') with the synthetic cell at (ox, oy)
// and width=size. Uses emitterPolyPoints directly so the in-icon glyph
// matches the on-board glyph pixel-for-pixel (apart from scale).
function _drawEmitterPolyAt(g, ox, oy, size, fill, stroke) {
  const polys = emitterPolyPoints(0, 0, 'bottom', size, 0);
  g.fillStyle(fill, 1);
  g.lineStyle(lw(size), stroke, 1);
  for (const poly of polys) {
    if (poly.length < 3) continue;
    g.beginPath();
    g.moveTo(poly[0][0] + ox, poly[0][1] + oy);
    for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0] + ox, poly[i][1] + oy);
    g.closePath();
    g.fillPath();
    g.strokePath();
  }
}

function drawFormGlyph(g, cx, cy, size, form, fill, stroke) {
  const r = (size * 0.78) / 2;
  g.fillStyle(fill, 1);
  g.lineStyle(lw(size), stroke, 1);
  if (form === 'circle') {
    g.fillCircle(cx, cy, r);
    g.strokeCircle(cx, cy, r);
  } else if (form === 'square') {
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.strokeRect(cx - r, cy - r, r * 2, r * 2);
  } else if (form === 'triangle') {
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r, cy + r * 0.85);
    g.lineTo(cx - r, cy + r * 0.85);
    g.closePath();
    g.fillPath();
    g.strokePath();
  }
}

// Color-only label icon: irregular puddle shape filled in the label color.
// Mirrors the convention used by FactoryBodyRenderer.drawMiniForm for a
// {color} (no form) cell label. Deterministic geometry — fixed seed-style
// vertex offsets so the puddle is the same across redraws.
function drawPuddleIcon(g, cx, cy, size, color) {
  const r = (size * 0.78) / 2;
  const STEPS = 16;
  const noise = [
    1.00, 0.90, 1.05, 0.85, 1.00, 1.10, 0.92, 1.05,
    0.88, 1.00, 1.07, 0.95, 1.02, 0.86, 1.06, 0.93,
  ];
  g.fillStyle(color, 1);
  g.lineStyle(lw(size), 0x1a2332, 1);
  g.beginPath();
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    const rr = r * noise[i % noise.length];
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fillPath();
  g.strokePath();
}

function drawEraserIcon(g, cx, cy, size) {
  const s = size * 0.6;
  g.lineStyle(lw(size) + 1, 0x6a6a6a, 1);
  g.beginPath();
  g.moveTo(cx - s / 2, cy - s / 2);
  g.lineTo(cx + s / 2, cy + s / 2);
  g.moveTo(cx + s / 2, cy - s / 2);
  g.lineTo(cx - s / 2, cy + s / 2);
  g.strokePath();
}

function drawBoltIcon(g, cx, cy, size) {
  const s = size * 0.78;
  g.fillStyle(0xffd33b, 1);
  g.lineStyle(lw(size), 0x6b4f10, 1);
  g.beginPath();
  g.moveTo(cx + s * 0.05, cy - s * 0.5);
  g.lineTo(cx - s * 0.25, cy + s * 0.05);
  g.lineTo(cx + s * 0.0,  cy + s * 0.05);
  g.lineTo(cx - s * 0.05, cy + s * 0.5);
  g.lineTo(cx + s * 0.3,  cy - s * 0.05);
  g.lineTo(cx + s * 0.05, cy - s * 0.05);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

function drawTrashIcon(g, cx, cy, size) {
  // Scissors-y "X-on-square" so it doesn't visually collide with the
  // start-over trash icon on the icon island.
  const s = size * 0.7;
  const half = s / 2;
  g.fillStyle(0xeeeeee, 1);
  g.lineStyle(lw(size), 0x444444, 1);
  g.fillRoundedRect(cx - half, cy - half, s, s, 3);
  g.strokeRoundedRect(cx - half, cy - half, s, s, 3);
  // Bold X.
  g.lineStyle(lw(size) + 2, 0xb02525, 1);
  const xs = s * 0.55;
  g.beginPath();
  g.moveTo(cx - xs / 2, cy - xs / 2);
  g.lineTo(cx + xs / 2, cy + xs / 2);
  g.moveTo(cx + xs / 2, cy - xs / 2);
  g.lineTo(cx - xs / 2, cy + xs / 2);
  g.strokePath();
}

// Undo icon — a leftward-pointing back arrow (←). Bold straight shaft +
// a triangular arrowhead, matching common "back" affordances.
function drawUndoIcon(g, cx, cy, size) {
  const w = size * 0.78;
  const stroke = lw(size) + 1;
  const halfH = size * 0.18;
  const tipX = cx - w / 2;
  const tailX = cx + w / 2;
  // Shaft.
  g.lineStyle(stroke, 0x1a2332, 1);
  g.beginPath();
  g.moveTo(tipX, cy);
  g.lineTo(tailX, cy);
  g.strokePath();
  // Arrowhead — solid triangle at the left end.
  g.fillStyle(0x1a2332, 1);
  g.beginPath();
  g.moveTo(tipX, cy);
  g.lineTo(tipX + halfH, cy - halfH);
  g.lineTo(tipX + halfH, cy + halfH);
  g.closePath();
  g.fillPath();
}

// Help icon — just the outlined circle in pure graphics. The "?" glyph
// is layered on top by PaletteBar (and any other consumer) using a real
// Phaser Text object, mirroring `drawQuestion` in src/core/ui/Icons.js so
// the visual matches the existing in-game hint button.
function drawHelpIcon(g, cx, cy, size) {
  const r = (size * 0.78) / 2;
  g.lineStyle(Math.max(2, Math.round(size * 0.1)), 0x1a2332, 1);
  g.strokeCircle(cx, cy, r);
}

// ---------- tool catalog ----------

// Funnels: the user only wants 3 options (emitter / red / green). Form is
// set later via labels. Red/green here mean "input-role funnel pre-typed
// to that color", which matches the existing factory-funnel coloring of
// red=input / green=output — we use role+color as the payload.
const FUNNEL_TOOLS = [
  {
    id: 'funnel.emitter',
    category: SLOT.FUNNEL,
    label: 'Emitter',
    drawIcon: drawEmitterIcon,
    payload: { role: 'emitter' },
  },
  {
    id: 'funnel.red',
    category: SLOT.FUNNEL,
    label: 'Red funnel',
    drawIcon: (g, cx, cy, size) => drawTriangleIcon(g, cx, cy, size, FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE),
    payload: { role: 'input', color: 'red' },
  },
  {
    id: 'funnel.green',
    category: SLOT.FUNNEL,
    label: 'Green funnel',
    drawIcon: (g, cx, cy, size) => drawTriangleIcon(g, cx, cy, size, FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE),
    payload: { role: 'output', color: 'green' },
  },
];

const BOARD_PIECE_TOOLS = [
  {
    id: 'board.acid',
    category: SLOT.BOARD_PIECE,
    label: 'Acid pit',
    drawIcon: drawAcidPitIcon,
    payload: { kind: 'acid' },
  },
  {
    id: 'board.borderInput',
    category: SLOT.BOARD_PIECE,
    label: 'Border input',
    drawIcon: (g, cx, cy, size) => _drawBorderPieceIcon(g, cx, cy, size, 'input'),
    payload: { kind: 'borderFunnel', role: 'input' },
  },
  {
    id: 'board.borderOutput',
    category: SLOT.BOARD_PIECE,
    label: 'Border output',
    drawIcon: (g, cx, cy, size) => _drawBorderPieceIcon(g, cx, cy, size, 'output'),
    payload: { kind: 'borderFunnel', role: 'output' },
  },
  {
    id: 'board.borderEmitter',
    category: SLOT.BOARD_PIECE,
    label: 'Border emitter',
    drawIcon: (g, cx, cy, size) => _drawBorderPieceIcon(g, cx, cy, size, 'emitter'),
    payload: { kind: 'borderFunnel', role: 'emitter' },
  },
  {
    id: 'board.borderCatcher',
    category: SLOT.BOARD_PIECE,
    label: 'Border catcher',
    drawIcon: (g, cx, cy, size) => _drawBorderPieceIcon(g, cx, cy, size, 'collector'),
    payload: { kind: 'borderFunnel', role: 'collector' },
  },
];

// Labels: 9 (form, color) combos + 3 color-only + 3 form-only + eraser +
// bolt. The color-only and form-only variants emit partial labels — the
// sim already handles partial labels on funnels (form-only or color-only),
// and acid pits / border funnels honor the color (and ignore the form).
// `special` tags drive the grid layout in PalettePopup:
//   special: 'eraser'      → top-left corner of the labels grid
//   special: 'bolt'        → centered row below the grid
//   special: 'colorHeader' → top header row of the grid
//   special: 'formHeader'  → left header column of the grid
const LABEL_TOOLS = [];
for (const form of FORMS) {
  for (const color of COLORS) {
    LABEL_TOOLS.push({
      id: `label.${form}.${color}`,
      category: SLOT.LABEL,
      label: `${color} ${form}`,
      form, color,
      drawIcon: (g, cx, cy, size) => drawFormGlyph(g, cx, cy, size, form, COLOR_HEX[color], 0x1a2332),
      payload: { kind: 'label', label: { form, color } },
    });
  }
}
// Color-only labels (puddle shape in the label's color). Render as the
// "color column header" in the labels grid.
for (const color of COLORS) {
  LABEL_TOOLS.push({
    id: `label.color.${color}`,
    category: SLOT.LABEL,
    label: `${color} (any shape)`,
    color,
    special: 'colorHeader',
    drawIcon: (g, cx, cy, size) => drawPuddleIcon(g, cx, cy, size, COLOR_HEX[color]),
    payload: { kind: 'label', label: { color } },
  });
}
// Form-only labels (form glyph filled white, black outline). Render as
// the "form row header" on the left of the labels grid.
for (const form of FORMS) {
  LABEL_TOOLS.push({
    id: `label.form.${form}`,
    category: SLOT.LABEL,
    label: `${form} (any color)`,
    form,
    special: 'formHeader',
    drawIcon: (g, cx, cy, size) => drawFormGlyph(g, cx, cy, size, form, 0xffffff, 0x1a2332),
    payload: { kind: 'label', label: { form } },
  });
}
LABEL_TOOLS.push({
  id: 'label.eraser',
  category: SLOT.LABEL,
  label: 'Erase label',
  special: 'eraser',
  drawIcon: drawEraserIcon,
  payload: { kind: 'label', clear: true },
});
LABEL_TOOLS.push({
  id: 'label.bolt',
  category: SLOT.LABEL,
  label: 'Bolt',
  special: 'bolt',
  drawIcon: drawBoltIcon,
  payload: { kind: 'bolt' },
});

const FACTORY_TOOLS = [
  {
    id: 'factory.block',
    category: SLOT.FACTORY,
    label: 'Factory block',
    drawIcon: drawFactoryIcon,
    payload: { kind: 'factory' },
  },
];

const TRASH_TOOLS = [
  {
    id: 'trash',
    category: SLOT.TRASH,
    label: 'Trash',
    drawIcon: drawTrashIcon,
    payload: { kind: 'trash' },
  },
];

// Slot 5 (Undo) is tap-only and has no draggable tools — it's modeled as
// an empty options array so PaletteBar can still render its icon.
const UNDO_TOOLS = [
  {
    id: 'undo',
    category: SLOT.UNDO,
    label: 'Undo',
    drawIcon: drawUndoIcon,
    payload: null,
    tapOnly: true,
  },
];

// Slot 6 (Help) — also tap-only. Opens a click-through tutorial modal
// explaining the editor's interactions.
const HELP_TOOLS = [
  {
    id: 'help',
    category: SLOT.HELP,
    label: 'Help',
    drawIcon: drawHelpIcon,
    payload: null,
    tapOnly: true,
  },
];

export const TOOLS_BY_SLOT = Object.freeze([
  FACTORY_TOOLS,
  FUNNEL_TOOLS,
  BOARD_PIECE_TOOLS,
  LABEL_TOOLS,
  TRASH_TOOLS,
  UNDO_TOOLS,
  HELP_TOOLS,
]);

// Default armed tool per slot — the icon initially shown in the palette
// bar before the user picks something else. Picked to be the most-used /
// most-neutral option per category.
export const DEFAULT_ARMED_BY_SLOT = Object.freeze([
  'factory.block',
  'funnel.emitter',
  'board.acid',
  'label.circle.red',
  'trash',
  'undo',
  'help',
]);

// Category label rendered above each palette slot. Always shows the
// category name (NOT the currently-armed tool's name) — a stable visual
// anchor regardless of which option the user has picked.
export const SLOT_LABELS = Object.freeze([
  'factory',
  'in/out',
  'board',
  'labels',
  'eraser',
  'undo',
  'help',
]);

export function findTool(id) {
  for (const slot of TOOLS_BY_SLOT) {
    for (const t of slot) if (t.id === id) return t;
  }
  return null;
}
