// Level data model + persistence via the platform adapter.
//
// Schema (post-milestone-A, with per-cell labels):
//   {
//     board: { cols, rows },                           // grid size (buffer+play)
//     name: string,                                    // display name
//     number: int,                                     // level # within section (0 = sandbox)
//     factories: [                                     // factories placed on the board (editor authoring)
//       { id, anchor:{row,col},
//         cells:[{r,c, label?: PartialShapeType, bolt?:true },...], // per-cell label + optional lightning-bolt gate
//         funnels:[{r,c,side,role}], locked?:bool }    // role: 'input'|'output'|'emitter'
//     ],
//     initialFactories: [                              // factories the player starts with in the blueprint
//       { id, slot:{row,col}, cells, funnels, rotation?, locked?:false }
//     ],
//     lockedFactories: [                               // factories anchored to the play area (cannot move)
//       { id, anchor:{row,col}, cells, funnels }
//     ],
//     border: { funnels: [{r,c,side,role}] },          // role: 'input'|'output'|'emitter'|'collector'
//     inputs:  [{r,c,side, type: ShapeType}],          // typed spawn points on the buffer
//     outputs: [{r,c,side, type: ShapeType}],          // typed expected drops on the buffer
//     instructionalText?: string,                       // optional one-liner pinned to the
//                                                      //   top row of the player's blueprint.
//                                                      //   When present, that row is reserved
//                                                      //   and rejects factory placements.
//     boss?: { rounds: BossRound[] },                  // optional N-round boss config (N=2..5)
//                                                      //   read at runtime by PlayerScene.bossRoundLevel().
//                                                      //   Each round has { border, inputs, outputs,
//                                                      //   initialFactories, instructionalText?,
//                                                      //   solution: { factories } }. `solution` is
//                                                      //   editor-only metadata (the authored canonical
//                                                      //   layout for review); PlayerScene ignores it.
//   }
//
// PartialShapeType:  { form } | { color } | { form, color }
//   • Shape-only (form, no color)  → input accepts any color of that form;
//     output (singleton) emits the form filled white. The sim fills the
//     missing color axis from the input stamp on multi-cell factories.
//   • Color-only (no form, color)  → input accepts any form of that color;
//     output (singleton) renders as a "puddle" blob in that color. Missing
//     form is filled from the input stamp on multi-cell factories.
//
// Funnel-typing rules (driven by per-cell labels):
//   • Single-cell labeled factory: input funnels are wildcard, output funnels
//     emit the label (which can be partial — see PartialShapeType).
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
    instructionalText: null,
    acidPits: [],
    boss: null,
  };
  seedDefaultFunnels(level);
  return level;
}

/** Default boss level with N stages (2..5). Board/name are shared across
 *  stages; per-stage border/inputs/outputs get the same default seed as a
 *  fresh sandbox so each stage has a ready input→output pair to edit. */
export function defaultBossLevel(stageCount) {
  const n = Math.max(2, Math.min(5, stageCount | 0));
  const dim = 6;
  const level = {
    board: { cols: dim, rows: dim },
    name: 'Sandbox Boss',
    number: 0,
    factories: [],
    initialFactories: [],
    lockedFactories: [],
    border: { funnels: [] },
    inputs: [],
    outputs: [],
    instructionalText: null,
    acidPits: [],
    boss: { rounds: [] },
  };
  for (let i = 0; i < n; i++) {
    level.boss.rounds.push(defaultBossRound(dim));
  }
  // Load round 0 into the active working slots so the editor opens on stage 1.
  applyBossRoundToWorking(level, 0);
  return level;
}

/** One empty boss round seeded with the default input/output pair. */
export function defaultBossRound(dim) {
  const mid = Math.floor(dim / 2);
  const lastRow = dim - 1;
  return {
    border: {
      funnels: [
        { r: 0,       c: mid, side: 'bottom', role: 'input'  },
        { r: lastRow, c: mid, side: 'top',    role: 'output' },
      ],
    },
    inputs:  [{ r: 0,       c: mid, side: 'bottom', type: { ...DEFAULT_SHAPE_TYPE } }],
    outputs: [{ r: lastRow, c: mid, side: 'top',    type: { ...DEFAULT_SHAPE_TYPE } }],
    initialFactories: [],
    instructionalText: null,
    solution: { factories: [] },
  };
}

/** Copy a boss round's data into the top-level working slots (border/inputs/
 *  outputs/initialFactories/factories/instructionalText) that the editor UI
 *  operates on. The factories on the active board are taken from the round's
 *  `solution.factories` (the stage's canonical authored layout). Cumulative
 *  lock carry from earlier stages' solutions is baked in as `locked:true`. */
export function applyBossRoundToWorking(level, roundIdx) {
  const rounds = (level.boss && level.boss.rounds) || [];
  const r = rounds[roundIdx];
  if (!r) return;
  // Deep clone so edits to working state don't mutate the stored round until
  // we explicitly snapshot back.
  const clone = (v) => JSON.parse(JSON.stringify(v || null));
  level.border = clone(r.border) || { funnels: [] };
  level.inputs = clone(r.inputs) || [];
  level.outputs = clone(r.outputs) || [];
  level.initialFactories = clone(r.initialFactories) || [];
  level.instructionalText = r.instructionalText || null;
  const cumulativeLocked = [];
  for (let i = 0; i < roundIdx; i++) {
    const prior = rounds[i];
    const sf = (prior && prior.solution && prior.solution.factories) || [];
    for (const f of sf) {
      const fc = clone(f);
      fc.locked = true;
      cumulativeLocked.push(fc);
    }
  }
  const ownFactories = clone((r.solution && r.solution.factories) || []);
  for (const f of ownFactories) f.locked = false;
  level.factories = [...cumulativeLocked, ...ownFactories];
  level.lockedFactories = []; // cumulative lock is on factories with locked:true
}

/** Snapshot the editor's active working slots back into boss.rounds[roundIdx].
 *  The `solution.factories` captures only the non-locked factories (the ones
 *  authored in THIS stage, not the cumulative carry). */
export function snapshotWorkingToBossRound(level, roundIdx) {
  const rounds = (level.boss && level.boss.rounds) || [];
  const r = rounds[roundIdx];
  if (!r) return;
  const clone = (v) => JSON.parse(JSON.stringify(v || null));
  r.border = clone(level.border) || { funnels: [] };
  r.inputs = clone(level.inputs) || [];
  r.outputs = clone(level.outputs) || [];
  r.initialFactories = clone(level.initialFactories) || [];
  r.instructionalText = level.instructionalText || null;
  const ownFactories = (level.factories || [])
    .filter((f) => !f.locked)
    .map((f) => {
      const c = clone(f);
      delete c.locked;
      return c;
    });
  r.solution = { factories: ownFactories };
}

// -----------------------------------------------------------------------
//   Boss round composition (shared by PlayerScene + EditorScene)
// -----------------------------------------------------------------------

function funnelKey(f) { return `${f.r},${f.c},${f.side}`; }

/** Build the level snapshot for boss round `roundIdx`. The shared `board`
 *  + `name` carry over; per-round `border / inputs / outputs /
 *  initialFactories / instructionalText` come from boss.rounds[roundIdx].
 *  `lockedCarry` is the array of factories the player placed in earlier
 *  rounds — they're appended to the level's `lockedFactories` so they
 *  render with the lock pin + darken tint and are immovable.
 *
 *  GREEN (input) funnels from earlier rounds are unioned into the active
 *  border + inputs list (they persist once introduced); RED (output)
 *  funnels come from the current round only (past reds are destroyed
 *  between rounds, per the boss spec). */
export function bossRoundLevel(srcLevel, roundIdx, lockedCarry) {
  const rounds = (srcLevel.boss && srcLevel.boss.rounds) || [];
  const r = rounds[roundIdx] || {};
  const roundFunnels = (r.border && r.border.funnels) || [];
  const roundInputs  = r.inputs  || [];
  // Carry forward every green (input) funnel from earlier rounds, deduped
  // by (r,c,side). Output funnels do NOT carry forward.
  const seen = new Set(roundFunnels.map(funnelKey));
  const priorGreens = [];
  const priorInputs = [];
  for (let i = 0; i < roundIdx; i++) {
    const pr = rounds[i];
    const pfs = (pr && pr.border && pr.border.funnels) || [];
    const pins = (pr && pr.inputs) || [];
    for (const f of pfs) {
      if (f.role !== 'input') continue;
      const k = funnelKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      priorGreens.push({ ...f });
    }
    for (const inp of pins) {
      const k = funnelKey(inp);
      if (priorInputs.some((q) => funnelKey(q) === k)) continue;
      // Don't re-add if the current round redefines this slot.
      if (roundInputs.some((q) => funnelKey(q) === k)) continue;
      priorInputs.push({ ...inp, type: { ...(inp.type || {}) } });
    }
  }
  return {
    ...srcLevel,
    border: { funnels: [...priorGreens, ...roundFunnels] },
    inputs: [...priorInputs, ...roundInputs],
    outputs: r.outputs || [],
    initialFactories: r.initialFactories || [],
    lockedFactories: [...(srcLevel.lockedFactories || []), ...(lockedCarry || [])],
    instructionalText: r.instructionalText || null,
    // Strip `boss` so the per-round snapshot can't trigger another boss
    // composition recursively.
    boss: null,
  };
}

/** Pure, read-only view of every stage in a boss level. Consumers use this
 *  to render the cross-stage blueprint / border overlay. `idx` is the
 *  0-based round index. When `currentIdx` is given, the returned specs also
 *  include an `isCurrent/isPast/isFuture` boolean for convenience. */
export function bossAllStageSpecs(level, currentIdx = -1) {
  const rounds = (level && level.boss && level.boss.rounds) || [];
  return rounds.map((r, idx) => ({
    idx,
    funnels:  ((r.border && r.border.funnels) || []).map((f) => ({ ...f })),
    greens:   ((r.border && r.border.funnels) || []).filter((f) => f.role === 'input' ).map((f) => ({ ...f })),
    reds:     ((r.border && r.border.funnels) || []).filter((f) => f.role === 'output').map((f) => ({ ...f })),
    inputs:   (r.inputs  || []).map((f) => ({ ...f, type: { ...(f.type || {}) } })),
    outputs:  (r.outputs || []).map((f) => ({ ...f, type: { ...(f.type || {}) } })),
    blueprint: (r.initialFactories || []).map((f) => JSON.parse(JSON.stringify(f))),
    solution:  ((r.solution && r.solution.factories) || []).map((f) => JSON.parse(JSON.stringify(f))),
    instructionalText: r.instructionalText || null,
    isCurrent: idx === currentIdx,
    isPast:    idx < currentIdx,
    isFuture:  idx > currentIdx,
  }));
}

/** Returns the set of funnel keys (r,c,side) that are "active" (participate
 *  in the simulation) for round `roundIdx`, plus convenience lists:
 *    - priorGreens: input funnels carried in from earlier rounds
 *    - currentReds: output funnels of the current round (they will be
 *      destroyed at transition)
 *    - priorReds:   output funnels from strictly earlier rounds (visually
 *      absent in the current round — already destroyed)
 */
export function bossActiveBorderSet(level, roundIdx) {
  const rounds = (level && level.boss && level.boss.rounds) || [];
  const active = new Set();
  const priorGreens = [];
  const priorReds = [];
  let currentReds = [];
  for (let i = 0; i < rounds.length; i++) {
    const fs = (rounds[i].border && rounds[i].border.funnels) || [];
    for (const f of fs) {
      if (i === roundIdx) {
        active.add(funnelKey(f));
        if (f.role === 'output') currentReds.push({ ...f });
      } else if (i < roundIdx && f.role === 'input') {
        active.add(funnelKey(f));
        priorGreens.push({ ...f });
      } else if (i < roundIdx && f.role === 'output') {
        priorReds.push({ ...f });
      }
    }
  }
  return { active, priorGreens, currentReds, priorReds };
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
  // New optional fields default to null so consumers can `level.instructionalText`
  // / `level.boss` without crashing on legacy saves.
  if (next.instructionalText === undefined) next.instructionalText = null;
  if (next.boss === undefined) next.boss = null;
  if (!Array.isArray(next.acidPits)) next.acidPits = [];
  return next;
}

/** Return the acid-pit label for the cell at (r, c) — `{color}` or null. */
export function pitLabelAt(level, r, c) {
  const pits = (level && level.acidPits) || [];
  for (const p of pits) {
    if (p.r === r && p.c === c) return p.label || null;
  }
  return null;
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
