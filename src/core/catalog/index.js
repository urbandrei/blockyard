// MVP level catalog. One section, three handcrafted levels covering filter
// (single-factory redirect), converter (transform), and multi-factory routing.
//
// Each level is a plain object matching the level.js schema:
//   { id, sectionId, name, number, board, inputs, outputs, border,
//     lockedFactories[], initialFactories[] }
//
// `id` is the unlock-graph key (used by progress.js). `initialFactories[]`
// declare what starts in the player's blueprint with `slot:{row,col}` plus
// `cells/funnels/converter/rotation?`. `lockedFactories[]` are anchored to
// the play area.

import { genId } from '../model/level.js';

const blueCircle  = { form: 'circle',   color: 'blue'  };
const redSquare   = { form: 'square',   color: 'red'   };
const greenTri    = { form: 'triangle', color: 'green' };

// Section 1 — three intro levels.

// L1 "First Bend": redirect a top-down stream into a side output.
const LEVEL_1 = {
  id: 's1-l1',
  sectionId: 's1',
  name: 'First Bend',
  number: 1,
  board: { cols: 5, rows: 5 },
  inputs:  [{ r: 0, c: 2, side: 'bottom', type: { ...blueCircle } }],
  outputs: [{ r: 2, c: 4, side: 'left',   type: { ...blueCircle } }],
  border: { funnels: [
    { r: 0, c: 2, side: 'bottom', role: 'input'  },
    { r: 2, c: 4, side: 'left',   role: 'output' },
  ]},
  lockedFactories: [],
  initialFactories: [{
    id: genId(),
    slot: { row: 0, col: 0 },
    cells: [{ r: 0, c: 0 }],
    funnels: [
      { r: 0, c: 0, side: 'top',   role: 'input'  },
      { r: 0, c: 0, side: 'right', role: 'output' },
    ],
    rotation: 0,
  }],
};

// L2 "Transformer": single-cell converter level. Player has a converter
// factory that turns a blue circle into a red square.
const LEVEL_2 = {
  id: 's1-l2',
  sectionId: 's1',
  name: 'Transformer',
  number: 2,
  board: { cols: 5, rows: 5 },
  inputs:  [{ r: 0, c: 2, side: 'bottom', type: { ...blueCircle } }],
  outputs: [{ r: 4, c: 2, side: 'top',    type: { ...redSquare  } }],
  border: { funnels: [
    { r: 0, c: 2, side: 'bottom', role: 'input'  },
    { r: 4, c: 2, side: 'top',    role: 'output' },
  ]},
  lockedFactories: [],
  initialFactories: [{
    // Single-cell labeled factory: input = wildcard (blue circle qualifies),
    // output emits the cell's label (red square).
    id: genId(),
    slot: { row: 0, col: 0 },
    cells: [{ r: 0, c: 0, label: { ...redSquare } }],
    funnels: [
      { r: 0, c: 0, side: 'top',    role: 'input'  },
      { r: 0, c: 0, side: 'bottom', role: 'output' },
    ],
    rotation: 0,
  }],
};

// L3 "Two-Stage": two converters in series. Input → square → triangle.
const LEVEL_3 = {
  id: 's1-l3',
  sectionId: 's1',
  name: 'Two-Stage',
  number: 3,
  board: { cols: 6, rows: 6 },
  inputs:  [{ r: 0, c: 2, side: 'bottom', type: { ...blueCircle } }],
  outputs: [{ r: 5, c: 3, side: 'top',    type: { ...greenTri   } }],
  border: { funnels: [
    { r: 0, c: 2, side: 'bottom', role: 'input'  },
    { r: 5, c: 3, side: 'top',    role: 'output' },
  ]},
  lockedFactories: [],
  initialFactories: [
    {
      // Stage 1: any input → red square; bend top→right.
      id: genId(),
      slot: { row: 0, col: 0 },
      cells: [{ r: 0, c: 0, label: { ...redSquare } }],
      funnels: [
        { r: 0, c: 0, side: 'top',   role: 'input'  },
        { r: 0, c: 0, side: 'right', role: 'output' },
      ],
      rotation: 0,
    },
    {
      // Stage 2: any input → green triangle; bend left→bottom.
      id: genId(),
      slot: { row: 0, col: 1 },
      cells: [{ r: 0, c: 0, label: { ...greenTri } }],
      funnels: [
        { r: 0, c: 0, side: 'left',   role: 'input'  },
        { r: 0, c: 0, side: 'bottom', role: 'output' },
      ],
      rotation: 0,
    },
  ],
};

export const SECTIONS = [
  { id: 's1', name: 'Section 1', levels: [LEVEL_1, LEVEL_2, LEVEL_3] },
];

export const LEVELS = SECTIONS.flatMap((s) => s.levels);

export function getLevelById(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

// First level not yet beaten, or null if everything is beaten. Used by the
// HomeScene's "Quick Play" button.
export function nextUnbeaten(beatenSet) {
  for (const l of LEVELS) if (!beatenSet.has(l.id)) return l;
  return null;
}

// The level immediately after `id` in the catalog, or null if it was the last.
export function nextLevelAfter(id) {
  const idx = LEVELS.findIndex((l) => l.id === id);
  if (idx < 0 || idx >= LEVELS.length - 1) return null;
  return LEVELS[idx + 1];
}
