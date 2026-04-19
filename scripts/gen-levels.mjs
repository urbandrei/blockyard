// Generates levels/level-1.json … level-20.json from a structured table.
// Run once locally: `node scripts/gen-levels.mjs`. Re-runs are idempotent.
//
// The catalog (`src/core/catalog/index.js`) glob-imports every levels/*.json
// at build time and stamps `.number` from index. Author intent for each
// level lives in DEFS below; this script handles the boilerplate (stable
// ids, border-funnel + inputs/outputs symmetry, etc.) so the JSON files
// stay diff-clean.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'levels');
mkdirSync(OUT, { recursive: true });

// ---------- helpers ----------

const T_BLUE_CIRCLE = { form: 'circle',   color: 'blue' };
const T_RED_SQUARE  = { form: 'square',   color: 'red' };
const T_GREEN_TRI   = { form: 'triangle', color: 'green' };
const T_BLUE_SQUARE = { form: 'square',   color: 'blue' };
const T_RED_CIRCLE  = { form: 'circle',   color: 'red' };
const T_GREEN_CIRCLE= { form: 'circle',   color: 'green' };
const T_RED_TRI     = { form: 'triangle', color: 'red' };
const T_BLUE_TRI    = { form: 'triangle', color: 'blue' };
const T_GREEN_SQR   = { form: 'square',   color: 'green' };

// Stable ids — keep them readable so save round-trips don't shuffle keys.
function fid(prefix, idx) { return `${prefix}-${idx}`; }

// Input/output entry + matching border funnel from a single declaration.
function bin(r, c, side, type)  { return { r, c, side, type: { ...type } }; }
function bout(r, c, side, type) { return { r, c, side, type: { ...type } }; }
function bfun(r, c, side, role) { return { r, c, side, role }; }

// Single-cell factory in player's blueprint at a given slot.
function pf(id, slotRow, slotCol, funnels, label, rotation = 0) {
  const cells = [{ r: 0, c: 0 }];
  if (label) cells[0].label = { ...label };
  return { id, slot: { row: slotRow, col: slotCol }, cells, funnels, rotation };
}
// Multi-cell factory in player's blueprint.
function pfm(id, slotRow, slotCol, cells, funnels, rotation = 0) {
  return { id, slot: { row: slotRow, col: slotCol }, cells, funnels, rotation };
}

// Shorthand: top-edge border input at col c, with a matching output spec
// describing where the player should route it.
function topInput(c, type) {
  return { input: bin(0, c, 'bottom', type), border: bfun(0, c, 'bottom', 'input') };
}
function botOutput(rows, c, type) {
  return { output: bout(rows - 1, c, 'top', type), border: bfun(rows - 1, c, 'top', 'output') };
}
function leftOutput(r, type) {
  return { output: bout(r, 0, 'right', type), border: bfun(r, 0, 'right', 'output') };
}
function rightOutput(cols, r, type) {
  return { output: bout(r, cols - 1, 'left', type), border: bfun(r, cols - 1, 'left', 'output') };
}
function rightInput(cols, r, type) {
  return { input: bin(r, cols - 1, 'left', type), border: bfun(r, cols - 1, 'left', 'input') };
}
function leftInput(r, type) {
  return { input: bin(r, 0, 'right', type), border: bfun(r, 0, 'right', 'input') };
}
function botInput(rows, c, type) {
  return { input: bin(rows - 1, c, 'top', type), border: bfun(rows - 1, c, 'top', 'input') };
}
function topOutput(c, type) {
  return { output: bout(0, c, 'bottom', type), border: bfun(0, c, 'bottom', 'output') };
}

// Compose a level from { board, name, instructionalText, ports[], initialFactories[] }
// where `ports` is an array of {input/output, border} records produced by the
// helpers above.
function composeLevel({ id, name, board, instructionalText = null, ports = [], initialFactories = [] }) {
  const inputs  = ports.filter((p) => p.input ).map((p) => p.input);
  const outputs = ports.filter((p) => p.output).map((p) => p.output);
  const border  = { funnels: ports.map((p) => p.border) };
  return {
    id, name, number: 0, board,
    factories: [],
    initialFactories,
    lockedFactories: [],
    border, inputs, outputs,
    instructionalText,
    boss: null,
  };
}

// Boss: same shape, but `boss.rounds` carries per-round border + factories.
function composeBoss({ id, name, board, rounds }) {
  return {
    id, name, number: 0, board,
    factories: [],
    initialFactories: [],
    lockedFactories: [],
    border: { funnels: [] }, inputs: [], outputs: [],
    instructionalText: null,
    boss: {
      rounds: rounds.map((r) => ({
        instructionalText: r.instructionalText ?? null,
        border:  { funnels: r.ports.map((p) => p.border) },
        inputs:  r.ports.filter((p) => p.input ).map((p) => p.input ),
        outputs: r.ports.filter((p) => p.output).map((p) => p.output),
        initialFactories: r.initialFactories,
      })),
    },
  };
}

// ---------- per-level definitions ----------
//
// Two buckets: REGULARS are the numbered campaign levels (1..N). BOSSES
// are the numbered boss fights (1..M). Sections stitch them together in
// the catalog — each section is 10 regulars + 1 boss. Bosses sit BETWEEN
// regulars in catalog order (so level 10 → boss 1 → level 11), and they
// don't carry a "LEVEL N" label in the UI.

const REGULARS = [];
const BOSSES   = [];

// ----- L1 — Place a factory (5×5) -----
REGULARS.push(composeLevel({
  id: 'level-1', name: 'First Steps',
  board: { cols: 5, rows: 5 },
  instructionalText: 'Drag the factory onto the play area.',
  ports: [
    topInput(2, T_BLUE_CIRCLE),
    rightOutput(5, 2, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l1', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
  ],
}));

// ----- L2 — Splitting (5×5) -----
REGULARS.push(composeLevel({
  id: 'level-2', name: 'Twin Outputs',
  board: { cols: 5, rows: 5 },
  instructionalText: 'Splitters fire every output together.',
  ports: [
    topInput(2, T_BLUE_CIRCLE),
    leftOutput(2, T_BLUE_CIRCLE),
    rightOutput(5, 2, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l2', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'left',  role: 'output' },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
  ],
}));

// ----- L3 — Rotation (5×5) -----
// Border: top input → bottom output. Factory's funnels are top-input + bottom-
// output but it ships rotated 1× (90° CW), so the player must rotate it 3
// times to align — the goal is to get them into the rotation habit.
REGULARS.push(composeLevel({
  id: 'level-3', name: 'Spin to Win',
  board: { cols: 5, rows: 5 },
  instructionalText: 'Tap a placed factory to rotate it.',
  ports: [
    topInput(2, T_BLUE_CIRCLE),
    botOutput(5, 2, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l3', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], null, 1),
  ],
}));

// ----- L4 — Multiple factories (6×6) -----
// 3-segment chain top → bottom, each cell hops one row.
REGULARS.push(composeLevel({
  id: 'level-4', name: 'Three in a Row',
  board: { cols: 6, rows: 6 },
  instructionalText: 'Place every factory to clear the level.',
  ports: [
    topInput(3, T_BLUE_CIRCLE),
    botOutput(6, 3, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l4', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
    pf(fid('l4', 1), 1, 1, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
    pf(fid('l4', 2), 1, 2, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
  ],
}));

// ----- L5 — Combo (6×6) -----
// Bend through 2 factories — top → right → bottom of board.
REGULARS.push(composeLevel({
  id: 'level-5', name: 'Detour',
  board: { cols: 6, rows: 6 },
  instructionalText: null,
  ports: [
    topInput(1, T_RED_CIRCLE),
    botOutput(6, 4, T_RED_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l5', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
    pf(fid('l5', 1), 1, 1, [
      { r: 0, c: 0, side: 'left',  role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
    pf(fid('l5', 2), 1, 2, [
      { r: 0, c: 0, side: 'left',   role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
  ],
}));

// ----- L6 — Shape converter (6×6) -----
// Border: blue square in → blue circle out. Factory `{form:circle}` (white
// circle glyph): wildcard color in, emits a circle of whatever color came in.
REGULARS.push(composeLevel({
  id: 'level-6', name: 'Reshape',
  board: { cols: 6, rows: 6 },
  instructionalText: 'White-form factories: any color in, this shape out.',
  ports: [
    topInput(2, T_BLUE_SQUARE),
    botOutput(6, 2, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l6', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
  ],
}));

// ----- L7 — Combo (6×6) -----
// Bend + reshape: red square in → red circle out via a bend then converter.
REGULARS.push(composeLevel({
  id: 'level-7', name: 'Bent Reshape',
  board: { cols: 6, rows: 6 },
  instructionalText: null,
  ports: [
    topInput(1, T_RED_SQUARE),
    rightOutput(6, 3, T_RED_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l7', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
    pf(fid('l7', 1), 1, 1, [
      { r: 0, c: 0, side: 'left',  role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ], { form: 'circle' }),
  ],
}));

// ----- L8 — Combo (6×6) -----
// Splitter feeding two reshapes: green triangle in → triangle left + circle right.
REGULARS.push(composeLevel({
  id: 'level-8', name: 'Two Paths',
  board: { cols: 6, rows: 6 },
  instructionalText: null,
  ports: [
    topInput(2, T_GREEN_TRI),
    leftOutput(2, T_GREEN_TRI),
    rightOutput(6, 2, T_GREEN_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l8', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'left',  role: 'output' },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
    pf(fid('l8', 1), 1, 1, [
      { r: 0, c: 0, side: 'left',  role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ], { form: 'circle' }),
  ],
}));

// ----- L9 — Combo (7×7) -----
// Two parallel circuits, both shape converters:
//   • Top→bottom in col 1:  red square in → red circle out.
//   • Right→left in row 4:  blue square in → blue circle out.
// Each circuit is one straight pipe with a single pass-through-shape
// converter — the player's job is to drop both factories on the right
// row/col so the streams reach the matching outputs.
REGULARS.push(composeLevel({
  id: 'level-9', name: 'Parallel',
  board: { cols: 7, rows: 7 },
  instructionalText: null,
  ports: [
    topInput(1, T_RED_SQUARE),
    botOutput(7, 1, T_RED_CIRCLE),
    rightInput(7, 4, T_BLUE_SQUARE),
    leftOutput(4, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l9', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
    pf(fid('l9', 1), 1, 1, [
      { r: 0, c: 0, side: 'right',  role: 'input'  },
      { r: 0, c: 0, side: 'left',   role: 'output' },
    ], { form: 'circle' }),
  ],
}));

// ----- L10 — Section 1 finale (7×7) -----
// Combo of everything L1–L9 uses (no color, no multi-input): one input
// splits, two shape converters (rotated) convert each stream before it
// leaves the board.
REGULARS.push(composeLevel({
  id: 'level-10', name: 'Junction',
  board: { cols: 7, rows: 7 },
  instructionalText: null,
  ports: [
    topInput(3, T_RED_SQUARE),
    leftOutput(3, T_RED_CIRCLE),
    rightOutput(7, 3, T_RED_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l10', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'left',  role: 'output' },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ]),
    pf(fid('l10', 1), 1, 1, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
    pf(fid('l10', 2), 1, 2, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
  ],
}));

// ----- BOSS 1 — after Section 1 (7×7) -----
BOSSES.push(composeBoss({
  id: 'boss-1', name: 'Section 1 Boss',
  board: { cols: 7, rows: 7 },
  rounds: [
    {
      instructionalText: 'Round 1 — clear it; placed blocks lock for Round 2.',
      ports: [
        topInput(2, T_BLUE_CIRCLE),
        botOutput(7, 2, T_BLUE_CIRCLE),
      ],
      initialFactories: [
        pf(fid('l10r1', 0), 1, 0, [
          { r: 0, c: 0, side: 'top',    role: 'input'  },
          { r: 0, c: 0, side: 'bottom', role: 'output' },
        ]),
      ],
    },
    {
      instructionalText: 'Round 2 — new ports; old factories are locked.',
      ports: [
        topInput(4, T_RED_SQUARE),
        botOutput(7, 4, T_RED_CIRCLE),
      ],
      initialFactories: [
        pf(fid('l10r2', 0), 1, 0, [
          { r: 0, c: 0, side: 'top',    role: 'input'  },
          { r: 0, c: 0, side: 'bottom', role: 'output' },
        ], { form: 'circle' }),
      ],
    },
    {
      instructionalText: 'Final round — dodge your locked factories.',
      ports: [
        leftInput(3, T_GREEN_TRI),
        rightOutput(7, 3, T_GREEN_CIRCLE),
      ],
      initialFactories: [
        pf(fid('l10r3', 0), 1, 0, [
          { r: 0, c: 0, side: 'left',   role: 'input'  },
          { r: 0, c: 0, side: 'right',  role: 'output' },
        ], { form: 'circle' }),
      ],
    },
  ],
}));

// ----- L11 — Color converter (7×7) -----
REGULARS.push(composeLevel({
  id: 'level-11', name: 'Repaint',
  board: { cols: 7, rows: 7 },
  instructionalText: 'Puddle factories: any shape in, this color out.',
  ports: [
    topInput(3, T_RED_SQUARE),
    botOutput(7, 3, T_BLUE_SQUARE),
  ],
  initialFactories: [
    pf(fid('l11', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { color: 'blue' }),
  ],
}));

// ----- L12 — Combo (7×7) -----
// Shape converter then color converter chained: blue square in → red circle out.
REGULARS.push(composeLevel({
  id: 'level-12', name: 'Two Steps',
  board: { cols: 7, rows: 7 },
  instructionalText: null,
  ports: [
    topInput(3, T_BLUE_SQUARE),
    botOutput(7, 3, T_RED_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l12', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
    pf(fid('l12', 1), 1, 1, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { color: 'red' }),
  ],
}));

// ----- L13 — In-out factory (8×8) -----
// Singleton with both funnels on the same labeled cell.
REGULARS.push(composeLevel({
  id: 'level-13', name: 'Same Cell',
  board: { cols: 8, rows: 8 },
  instructionalText: 'In and out can sit on the same cell.',
  ports: [
    topInput(3, T_BLUE_CIRCLE),
    botOutput(8, 3, T_RED_SQUARE),
  ],
  initialFactories: [
    pf(fid('l13', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'square', color: 'red' }),
  ],
}));

// ----- L14 — Combo (8×8) -----
REGULARS.push(composeLevel({
  id: 'level-14', name: 'Reroute',
  board: { cols: 8, rows: 8 },
  instructionalText: null,
  ports: [
    topInput(2, T_RED_TRI),
    rightOutput(8, 5, T_BLUE_TRI),
  ],
  initialFactories: [
    pf(fid('l14', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'right',  role: 'output' },
    ], { color: 'blue' }),
    pf(fid('l14', 1), 1, 1, [
      { r: 0, c: 0, side: 'left',   role: 'input'  },
      { r: 0, c: 0, side: 'right',  role: 'output' },
    ]),
  ],
}));

// ----- L15 — Multi-output (8×8) -----
REGULARS.push(composeLevel({
  id: 'level-15', name: 'Triple Spread',
  board: { cols: 8, rows: 8 },
  instructionalText: 'One input, many outputs — every output fires.',
  ports: [
    topInput(3, T_GREEN_CIRCLE),
    leftOutput(3, T_GREEN_CIRCLE),
    rightOutput(8, 3, T_GREEN_CIRCLE),
    botOutput(8, 3, T_GREEN_CIRCLE),
  ],
  initialFactories: [
    pf(fid('l15', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'left',   role: 'output' },
      { r: 0, c: 0, side: 'right',  role: 'output' },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
  ],
}));

// ----- L16 — Combo (8×8) -----
// Splitter fans red-square input into left + down streams. Left goes
// through a shape converter (rotated to right→left) to become a red
// circle; down goes through a color converter to become a blue square.
// Both the splitter's bottom output AND the bottom-border output sit on
// col 3 — the factory set has no bend tile, so the bottom stream must
// stay in its column.
REGULARS.push(composeLevel({
  id: 'level-16', name: 'Sort and Spin',
  board: { cols: 8, rows: 8 },
  instructionalText: null,
  ports: [
    topInput(3, T_RED_SQUARE),
    leftOutput(3, T_RED_CIRCLE),
    botOutput(8, 3, T_BLUE_SQUARE),
  ],
  initialFactories: [
    pf(fid('l16', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'left',   role: 'output' },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
    pf(fid('l16', 1), 1, 1, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
    pf(fid('l16', 2), 1, 2, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { color: 'blue' }),
  ],
}));

// ----- L17 — Combo (8×8) -----
// Two independent L-shaped routes. Red square top-col-1 → bottom-col-3
// via a top→right bend and a left→bottom bend. Blue circle top-col-6 →
// bottom-col-4 via a top→left bend and a right→bottom bend. The streams
// never share a cell, so 4 bend factories are enough — an earlier
// crossing version couldn't solve without over/under bridges.
REGULARS.push(composeLevel({
  id: 'level-17', name: 'Parallel Bends',
  board: { cols: 8, rows: 8 },
  instructionalText: null,
  ports: [
    topInput(1, T_RED_SQUARE),
    topInput(6, T_BLUE_CIRCLE),
    botOutput(8, 3, T_RED_SQUARE),
    botOutput(8, 4, T_BLUE_CIRCLE),
  ],
  initialFactories: [
    // Red path bends.
    pf(fid('l17', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'right',  role: 'output' },
    ]),
    pf(fid('l17', 1), 1, 1, [
      { r: 0, c: 0, side: 'left',   role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
    // Blue path bends.
    pf(fid('l17', 2), 1, 2, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'left',   role: 'output' },
    ]),
    pf(fid('l17', 3), 1, 3, [
      { r: 0, c: 0, side: 'right',  role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ]),
  ],
}));

// ----- L18 — Multi-input (9×9) -----
// 3×1 merger with a label on every cell: outer cells filter the two
// typed top-border inputs (red circle + blue circle), middle cell owns
// the output funnel and emits a green circle. Anchored at col 3 the
// factory spans cols 3..5 so the two inputs + bottom output line up
// with the three border ports.
REGULARS.push(composeLevel({
  id: 'level-18', name: 'Two to Tango',
  board: { cols: 9, rows: 9 },
  instructionalText: 'Multi-input factories wait for every input.',
  ports: [
    topInput(3, T_RED_CIRCLE),
    topInput(5, T_BLUE_CIRCLE),
    botOutput(9, 4, T_GREEN_CIRCLE),
  ],
  initialFactories: [
    pfm(fid('l18', 0), 1, 0,
      [
        { r: 0, c: 0, label: { form: 'circle', color: 'red'   } },
        { r: 0, c: 1, label: { form: 'circle', color: 'green' } },
        { r: 0, c: 2, label: { form: 'circle', color: 'blue'  } },
      ],
      [
        { r: 0, c: 0, side: 'top',    role: 'input'  },
        { r: 0, c: 2, side: 'top',    role: 'input'  },
        { r: 0, c: 1, side: 'bottom', role: 'output' },
      ]),
  ],
}));

// ----- L19 — Combo (9×9) -----
REGULARS.push(composeLevel({
  id: 'level-19', name: 'Stress Test',
  board: { cols: 9, rows: 9 },
  instructionalText: null,
  ports: [
    topInput(2, T_RED_SQUARE),
    topInput(6, T_BLUE_CIRCLE),
    botOutput(9, 2, T_GREEN_CIRCLE),
    botOutput(9, 6, T_GREEN_TRI),
  ],
  initialFactories: [
    pf(fid('l19', 0), 1, 0, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'circle' }),
    pf(fid('l19', 1), 1, 1, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { color: 'green' }),
    pf(fid('l19', 2), 1, 2, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { form: 'triangle' }),
    pf(fid('l19', 3), 1, 3, [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ], { color: 'green' }),
  ],
}));

// ----- L20 — Section 2 finale (9×9) -----
// 3×1 labeled merger (same shape as L18): outer cells filter a red
// square + blue circle at the top, middle cell owns the output and
// emits a green triangle. Anchored at col 3 so cols 3..5 line up with
// the border input/output ports.
REGULARS.push(composeLevel({
  id: 'level-20', name: 'Keystone',
  board: { cols: 9, rows: 9 },
  instructionalText: null,
  ports: [
    topInput(3, T_RED_SQUARE),
    topInput(5, T_BLUE_CIRCLE),
    botOutput(9, 4, T_GREEN_TRI),
  ],
  initialFactories: [
    pfm(fid('l20', 0), 1, 0,
      [
        { r: 0, c: 0, label: { form: 'square',   color: 'red'   } },
        { r: 0, c: 1, label: { form: 'triangle', color: 'green' } },
        { r: 0, c: 2, label: { form: 'circle',   color: 'blue'  } },
      ],
      [
        { r: 0, c: 0, side: 'top',    role: 'input'  },
        { r: 0, c: 2, side: 'top',    role: 'input'  },
        { r: 0, c: 1, side: 'bottom', role: 'output' },
      ]),
  ],
}));

// ----- BOSS 2 — after Section 2 (9×9) -----
BOSSES.push(composeBoss({
  id: 'boss-2', name: 'Section 2 Boss',
  board: { cols: 9, rows: 9 },
  rounds: [
    {
      instructionalText: 'Boss Round 1 — get a clean route.',
      ports: [
        topInput(4, T_RED_SQUARE),
        botOutput(9, 4, T_RED_CIRCLE),
      ],
      initialFactories: [
        pf(fid('l20r1', 0), 1, 0, [
          { r: 0, c: 0, side: 'top',    role: 'input'  },
          { r: 0, c: 0, side: 'bottom', role: 'output' },
        ], { form: 'circle' }),
      ],
    },
    {
      instructionalText: 'Boss Round 2 — palette swap.',
      ports: [
        leftInput(4, T_BLUE_CIRCLE),
        rightOutput(9, 4, T_GREEN_CIRCLE),
      ],
      initialFactories: [
        pf(fid('l20r2', 0), 1, 0, [
          { r: 0, c: 0, side: 'left',   role: 'input'  },
          { r: 0, c: 0, side: 'right',  role: 'output' },
        ], { color: 'green' }),
      ],
    },
    {
      // 3×1 VERTICAL labeled merger on the left side. Two typed inputs
      // come from left-border at rows 1 + 3, output leaves right from
      // the middle cell toward a right-border green-circle sink at row
      // 2. Row 4 is never traversed, so round-2's locked factory (which
      // the player parked somewhere on that row) can't block the path.
      instructionalText: 'Boss Round 3 — multi-input finale.',
      ports: [
        leftInput(1, T_RED_SQUARE),
        leftInput(3, T_BLUE_CIRCLE),
        rightOutput(9, 2, T_GREEN_CIRCLE),
      ],
      initialFactories: [
        pfm(fid('b2r3', 0), 1, 0,
          [
            { r: 0, c: 0, label: { form: 'square',   color: 'red'   } },
            { r: 1, c: 0, label: { form: 'circle',   color: 'green' } },
            { r: 2, c: 0, label: { form: 'circle',   color: 'blue'  } },
          ],
          [
            { r: 0, c: 0, side: 'left',  role: 'input'  },
            { r: 2, c: 0, side: 'left',  role: 'input'  },
            { r: 1, c: 0, side: 'right', role: 'output' },
          ]),
      ],
    },
  ],
}));

// ---------- emit ----------

if (REGULARS.length !== 20) {
  console.error(`expected 20 regular levels, got ${REGULARS.length}`);
  process.exit(1);
}
if (BOSSES.length !== 2) {
  console.error(`expected 2 boss levels, got ${BOSSES.length}`);
  process.exit(1);
}

for (let i = 0; i < REGULARS.length; i++) {
  const name = `level-${i + 1}.json`;
  writeFileSync(join(OUT, name), JSON.stringify(REGULARS[i], null, 2) + '\n');
  console.log(`wrote ${name}`);
}
for (let i = 0; i < BOSSES.length; i++) {
  const name = `boss-${i + 1}.json`;
  writeFileSync(join(OUT, name), JSON.stringify(BOSSES[i], null, 2) + '\n');
  console.log(`wrote ${name}`);
}
