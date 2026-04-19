// Level data model + persistence via the platform adapter.
//
// Schema (post-milestone-A, with per-cell labels):
//   {
//     board: { cols, rows },                           // grid size (buffer+play)
//     name: string,                                    // display name
//     number: int,                                     // level # within section (0 = sandbox)
//     factories: [                                     // factories placed on the board (editor authoring)
//       { id, anchor:{row,col},
//         cells:[{r,c, label?: ShapeType},...],        // per-cell label (form+color)
//         funnels:[{r,c,side,role}], locked?:bool }
//     ],
//     initialFactories: [                              // factories the player starts with in the blueprint
//       { id, slot:{row,col}, cells, funnels, rotation?, locked?:false }
//     ],
//     lockedFactories: [                               // factories anchored to the play area (cannot move)
//       { id, anchor:{row,col}, cells, funnels }
//     ],
//     border: { funnels: [{r,c,side,role}] },          // legacy: role-only funnels on buffer
//     inputs:  [{r,c,side, type: ShapeType}],          // typed spawn points on the buffer
//     outputs: [{r,c,side, type: ShapeType}],          // typed expected drops on the buffer
//   }
//
// Funnel-typing rules (driven by per-cell labels):
//   • Single-cell labeled factory: input funnels are wildcard, output funnels
//     emit the label.
//   • Multi-cell factory: a funnel on a labeled cell inherits that label
//     (input = only accepts that type; output = only emits it). A funnel on
//     an unlabeled cell is wildcard for INPUTS only — output funnels must
//     sit on a labeled cell or are treated as pass-through (forwarding the
//     stamped shape that satisfied the factory's sinks).
//   • Pass-through (no labels at all): the factory must have exactly ONE
//     input funnel; outputs all emit a copy of whatever shape entered.
//
// Migration is derive-in-place: an old save with `blocks`/`border.funnels`
// gets rewritten on load (same localStorage key) so subsequent sessions read
// the new schema cleanly. The legacy `factory.converter:{in,out}` is migrated
// to per-cell labels.

import { platform } from '../../platform/index.js';
import { DEFAULT_SHAPE_TYPE } from './shape.js';

const LEVEL_KEY = 'blockyard.level';

/** Default level. Seeds a typed input→output pair so the sim exercises the
 *  new shape-typing codepath from the moment the scene boots. Size is 6×6
 *  (interior 4×4) — closer in proportion to the blueprint so the two regions
 *  read as roughly equal chunks of the scene. */
export function defaultLevel() {
  const dim = 6;
  const level = {
    board: { cols: dim, rows: dim },
    name: 'Sandbox',
    number: 0,
    factories: [],
    initialFactories: [],
    lockedFactories: [],
    border: { funnels: [] },
    inputs: [],
    outputs: [],
  };
  seedDefaultFunnels(level);
  return level;
}

/** Reset the level's funnel/factory state to a single blue-circle input at
 *  the top-center buffer cell and a matching output at the bottom. Used on
 *  initial creation and after a board resize (for testing). */
export function seedDefaultFunnels(level) {
  const mid = Math.floor(level.board.cols / 2);
  const lastRow = level.board.rows - 1;
  level.factories = [];
  level.border = {
    funnels: [
      { r: 0,       c: mid, side: 'bottom', role: 'input'  },
      { r: lastRow, c: mid, side: 'top',    role: 'output' },
    ],
  };
  level.inputs  = [{ r: 0,       c: mid, side: 'bottom', type: { ...DEFAULT_SHAPE_TYPE } }];
  level.outputs = [{ r: lastRow, c: mid, side: 'top',    type: { ...DEFAULT_SHAPE_TYPE } }];
}

export async function loadLevel() {
  try {
    const parsed = await platform.loadData(LEVEL_KEY);
    if (!parsed || !parsed.board) return defaultLevel();
    const migrated = migrate(parsed);
    // Persist the migrated shape so subsequent reads skip the migration path.
    if (migrated !== parsed) await saveLevel(migrated);
    return migrated;
  } catch (e) {
    console.warn('[level] loadLevel failed, using default', e);
    return defaultLevel();
  }
}

export async function saveLevel(level) {
  try {
    await platform.saveData(LEVEL_KEY, level);
  } catch (e) {
    console.warn('[level] saveLevel failed', e);
  }
}

export function genId() {
  return 'f' + Math.random().toString(36).slice(2, 9);
}

// ---------- migration ----------

// Returns `parsed` unchanged if already current; otherwise returns a new
// object with the new-schema fields filled in. Idempotent on current saves.
function migrate(parsed) {
  const hasOld = Array.isArray(parsed.blocks);
  const hasNew = Array.isArray(parsed.factories);
  if (!hasOld && hasNew && parsed.inputs && parsed.outputs) {
    // Already on current schema — nothing to do.
    backfillRoles(parsed);
    return parsed;
  }

  // Promote `blocks` → `factories` and backfill new fields. Keep the same
  // object shape per-factory (id / anchor / cells / funnels are unchanged).
  const next = { ...parsed };
  const legacyFactories = hasNew ? parsed.factories : (parsed.blocks || []);
  next.factories = legacyFactories.map((fac) => ({ ...fac }));
  delete next.blocks;
  if (typeof next.name !== 'string')   next.name   = 'Sandbox';
  if (typeof next.number !== 'number') next.number = 0;
  if (!Array.isArray(next.initialFactories)) next.initialFactories = [];
  if (!Array.isArray(next.lockedFactories))  next.lockedFactories  = [];
  if (!next.border || !Array.isArray(next.border.funnels)) {
    next.border = { funnels: [] };
  }
  backfillRoles(next);
  // Derive typed inputs/outputs from the border funnels when absent. Missing
  // types default to the DEFAULT_SHAPE_TYPE so the sim has something to stamp.
  if (!Array.isArray(next.inputs)) {
    next.inputs = next.border.funnels
      .filter((f) => f.role === 'input')
      .map((f) => ({ r: f.r, c: f.c, side: f.side, type: { ...DEFAULT_SHAPE_TYPE } }));
  }
  if (!Array.isArray(next.outputs)) {
    next.outputs = next.border.funnels
      .filter((f) => f.role === 'output')
      .map((f) => ({ r: f.r, c: f.c, side: f.side, type: { ...DEFAULT_SHAPE_TYPE } }));
  }
  return next;
}

function backfillRoles(level) {
  for (const fac of level.factories || []) {
    if (Array.isArray(fac.funnels)) for (const f of fac.funnels) if (!f.role) f.role = 'input';
  }
  for (const f of level.border.funnels || []) if (!f.role) f.role = 'input';
  for (const fac of level.factories       || []) migrateConverterToLabels(fac);
  for (const fac of level.initialFactories|| []) migrateConverterToLabels(fac);
  for (const fac of level.lockedFactories || []) migrateConverterToLabels(fac);
}

// Translate the legacy `converter:{in,out}` field into per-cell `label`s.
//   • single-cell factory: cells[0].label = converter.out (input is wildcard
//     by the dual rule).
//   • multi-cell factory: stamp `in` on every cell that hosts an input funnel
//     and `out` on every cell that hosts an output funnel. Approximation good
//     enough for the existing handful of multi-cell levels in the catalog.
function migrateConverterToLabels(fac) {
  if (!fac || !Array.isArray(fac.cells)) return;
  if (!fac.converter || !fac.converter.in || !fac.converter.out) return;
  const inT  = { ...fac.converter.in  };
  const outT = { ...fac.converter.out };
  if (fac.cells.length === 1) {
    if (!fac.cells[0].label) fac.cells[0].label = outT;
  } else {
    const inputCells  = new Set();
    const outputCells = new Set();
    for (const f of (fac.funnels || [])) {
      const k = `${f.r},${f.c}`;
      if (f.role === 'output') outputCells.add(k); else inputCells.add(k);
    }
    for (const cell of fac.cells) {
      const k = `${cell.r},${cell.c}`;
      if (cell.label) continue;
      if (outputCells.has(k))      cell.label = outT;
      else if (inputCells.has(k))  cell.label = inT;
    }
  }
  delete fac.converter;
}
