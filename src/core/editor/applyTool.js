// Single dispatch point for "apply this armed tool at this target". Called
// by PaletteDragController on drag-end after the caller has hit-tested the
// drop point. Returns `{ mutated, persistKind }` so the caller can decide
// whether to snapshot for undo, persist, and re-render.
//
//   applyToolAt(scene, tool, target)
//
// `target` shapes (resolved by EditorScene._paletteHitTest):
//   { kind: 'boardCell',     r, c }                              — interior cell
//   { kind: 'composerCell',  r, c }                              — draft cell
//   { kind: 'factoryCell',   factoryId, r, c }                   — board factory cell
//   { kind: 'factoryEdge',   factoryId, r, c, side }             — board factory perimeter edge
//   { kind: 'borderEdge',    r, c, side }                        — buffer-ring border edge
//   { kind: 'composerEdge',  r, c, side }                        — draft perimeter edge
//
// This module is pointer-agnostic — it never reads scene.input. It mutates
// scene.level (and draft state, when relevant) and returns whether the
// mutation succeeded so the caller can run scene._persist + scene._renderAll.

import { genId } from '../model/level.js';
import { isBorderCell, isAdjacentToFactory, isPerimeterEdge, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SLOT } from './tools.js';

export function applyToolAt(scene, tool, target) {
  if (!tool || !target) return { mutated: false };

  // Factory blocks.
  if (tool.id === 'factory.block') return _applyFactoryBlock(scene, target);

  // Funnels (emitter / red / green) — drop on factory perimeter edge or
  // composer perimeter edge. Border edges are handled by the dedicated
  // Board pieces tools instead.
  if (tool.category === SLOT.FUNNEL)      return _applyFunnel(scene, tool, target);

  // Board pieces (acid pit + 4 border funnel variants).
  if (tool.category === SLOT.BOARD_PIECE) return _applyBoardPiece(scene, tool, target);

  // Labels (3x3 combos + eraser + bolt).
  if (tool.category === SLOT.LABEL)       return _applyLabel(scene, tool, target);

  // Trash — single-piece deletion at the resolved target.
  if (tool.category === SLOT.TRASH)       return _applyTrash(scene, target);

  return { mutated: false };
}

// ---------- Trash ----------
//
// Deletes ONE piece at `target`:
//   factoryEdge   → strip the matching funnel from factory.funnels
//   composerEdge  → strip from draftFunnels
//   borderEdge    → remove that border funnel + its typed entry
//   borderFunnel  → same as borderEdge (cell-style hit at a funnel)
//   factoryCell   → remove that one cell. If it was the last cell, drop
//                   the whole factory. Reject if removing the cell would
//                   split the factory (contiguity rule, same as today's
//                   draft-cell remove path).
//   composerCell  → remove from draftCells (same contiguity rule).
//   acidPit       → remove from level.acidPits.

function _applyTrash(scene, target) {
  if (!target) return { mutated: false };

  if (target.kind === 'factoryEdge') {
    const fac = scene.level.factories.find((f) => f.id === target.factoryId);
    if (!fac || !Array.isArray(fac.funnels)) return { mutated: false };
    const relR = target.r - fac.anchor.row;
    const relC = target.c - fac.anchor.col;
    const before = fac.funnels.length;
    fac.funnels = fac.funnels.filter((f) => !(f.r === relR && f.c === relC && f.side === target.side));
    return { mutated: fac.funnels.length !== before, persistKind: 'level' };
  }

  if (target.kind === 'composerEdge') {
    if (!Array.isArray(scene.draftFunnels)) return { mutated: false };
    const before = scene.draftFunnels.length;
    scene.draftFunnels = scene.draftFunnels.filter(
      (f) => !(f.r === target.r && f.c === target.c && f.side === target.side));
    return { mutated: scene.draftFunnels.length !== before, persistKind: 'level' };
  }

  if (target.kind === 'borderEdge' || target.kind === 'borderFunnel') {
    if (!scene.level.border || !Array.isArray(scene.level.border.funnels)) return { mutated: false };
    const before = scene.level.border.funnels.length;
    scene.level.border.funnels = scene.level.border.funnels.filter(
      (f) => !(f.r === target.r && f.c === target.c && f.side === target.side));
    if (scene.level.border.funnels.length === before) return { mutated: false };
    // Drop the typed sidecar entry too.
    for (const key of ['inputs', 'outputs']) {
      if (!Array.isArray(scene.level[key])) continue;
      scene.level[key] = scene.level[key].filter(
        (e) => !(e.r === target.r && e.c === target.c && e.side === target.side));
    }
    return { mutated: true, persistKind: 'level' };
  }

  if (target.kind === 'acidPit') {
    if (!Array.isArray(scene.level.acidPits)) return { mutated: false };
    const before = scene.level.acidPits.length;
    scene.level.acidPits = scene.level.acidPits.filter(
      (p) => !(p.r === target.r && p.c === target.c));
    return { mutated: scene.level.acidPits.length !== before, persistKind: 'level' };
  }

  if (target.kind === 'factoryCell') {
    const fac = scene.level.factories.find((f) => f.id === target.factoryId);
    if (!fac) return { mutated: false };
    const relR = target.r - fac.anchor.row;
    const relC = target.c - fac.anchor.col;
    const candidate = fac.cells.filter((cc) => !(cc.r === relR && cc.c === relC));
    if (candidate.length === 0) {
      // Last cell of the factory — drop the whole factory.
      scene.level.factories = scene.level.factories.filter((f) => f.id !== fac.id);
      return { mutated: true, persistKind: 'level' };
    }
    if (!_cellsContiguous(candidate)) return { mutated: false };
    fac.cells = candidate;
    fac.funnels = (fac.funnels || []).filter(
      (f) => !(f.r === relR && f.c === relC) && isPerimeterEdge(candidate, f.r, f.c, f.side));
    return { mutated: true, persistKind: 'level' };
  }

  if (target.kind === 'composerCell') {
    const candidate = scene.draftCells.filter((cc) => !(cc.r === target.r && cc.c === target.c));
    if (candidate.length === scene.draftCells.length) return { mutated: false };
    if (candidate.length > 0 && !_cellsContiguous(candidate)) return { mutated: false };
    scene.draftCells = candidate;
    scene.draftFunnels = (scene.draftFunnels || []).filter(
      (f) => !(f.r === target.r && f.c === target.c) && isPerimeterEdge(candidate, f.r, f.c, f.side));
    return { mutated: true, persistKind: 'level' };
  }

  return { mutated: false };
}

// 4-neighbor connectivity check for a cell list. Used by trash on
// factory / composer cells to reject removals that would split the
// shape into two pieces.
function _cellsContiguous(cells) {
  if (cells.length <= 1) return true;
  const key = (r, c) => `${r},${c}`;
  const set = new Set(cells.map((cc) => key(cc.r, cc.c)));
  const seen = new Set([key(cells[0].r, cells[0].c)]);
  const queue = [{ r: cells[0].r, c: cells[0].c }];
  while (queue.length) {
    const { r, c } = queue.shift();
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const k = key(r + dr, c + dc);
      if (set.has(k) && !seen.has(k)) { seen.add(k); queue.push({ r: r + dr, c: c + dc }); }
    }
  }
  return seen.size === set.size;
}

// ---------- Factory block ----------
//
// Drop on board interior cell:
//   - If cell empty AND adjacent to an existing factory → merge (extend
//     that factory by one cell). Adjacency is 4-neighbour (no diagonals).
//   - If cell empty AND not adjacent → create a fresh 1×1 factory.
//   - If cell occupied (existing factory cell, acid pit, or border) → no-op.

function _applyFactoryBlock(scene, target) {
  if (target.kind === 'boardCell') {
    const { r, c } = target;
    const board = scene.level.board;
    if (r < 0 || c < 0 || r >= board.rows || c >= board.cols) return { mutated: false };
    if (isBorderCell(board, r, c)) return { mutated: false };
    if (scene._factoryAtBoardCell(r, c)) return { mutated: false };
    if (scene._acidPitAt && scene._acidPitAt(r, c)) return { mutated: false };

    const adj = _findAdjacentFactory(scene.level, r, c);
    if (adj) {
      _mergeCellIntoFactory(adj, r, c);
    } else {
      scene.level.factories.push({
        id: genId(),
        anchor: { row: r, col: c },
        cells: [{ r: 0, c: 0 }],
        funnels: [],
      });
    }
    return { mutated: true, persistKind: 'level' };
  }

  // Composer drop: extend the draft. First cell goes anywhere; subsequent
  // cells must be 4-adjacent to existing draft cells (same rule as today's
  // click-to-add path so multi-cell draft shapes stay contiguous). Filter
  // draft funnels that are no longer on the perimeter after the add.
  if (target.kind === 'composerCell') {
    const { r, c } = target;
    if (scene.draftCells.some((cc) => cc.r === r && cc.c === c)) return { mutated: false };
    if (scene.draftCells.length > 0 && !isAdjacentToFactory(scene.draftCells, r, c)) {
      return { mutated: false };
    }
    scene.draftCells.push({ r, c });
    if (Array.isArray(scene.draftFunnels) && scene.draftFunnels.length > 0) {
      scene.draftFunnels = scene.draftFunnels.filter(
        (f) => isPerimeterEdge(scene.draftCells, f.r, f.c, f.side),
      );
    }
    return { mutated: true, persistKind: 'level' };
  }

  return { mutated: false };
}

// ---------- Funnels (factory + composer edges) ----------
//
// Tool payloads from tools.js:
//   funnel.emitter → { role: 'emitter' }
//   funnel.red     → { role: 'input' }   (red is the visual code for an
//                                          input-role factory funnel)
//   funnel.green   → { role: 'output' }
//
// A drop on an edge that already holds a funnel REPLACES that funnel's
// role (consistent with the Adobe-style "drag the new tool over to swap").

function _applyFunnel(scene, tool, target) {
  const role = tool.payload && tool.payload.role;
  if (!role) return { mutated: false };

  if (target.kind === 'factoryEdge') {
    const fac = scene.level.factories.find((f) => f.id === target.factoryId);
    if (!fac) return { mutated: false };
    const relR = target.r - fac.anchor.row;
    const relC = target.c - fac.anchor.col;
    if (!isPerimeterEdge(fac.cells, relR, relC, target.side)) return { mutated: false };
    fac.funnels = fac.funnels || [];
    const existing = fac.funnels.find((f) => f.r === relR && f.c === relC && f.side === target.side);
    if (existing) existing.role = role;
    else          fac.funnels.push({ r: relR, c: relC, side: target.side, role });
    return { mutated: true, persistKind: 'level' };
  }

  if (target.kind === 'composerEdge') {
    if (!isPerimeterEdge(scene.draftCells, target.r, target.c, target.side)) return { mutated: false };
    scene.draftFunnels = scene.draftFunnels || [];
    const existing = scene.draftFunnels.find((f) => f.r === target.r && f.c === target.c && f.side === target.side);
    if (existing) existing.role = role;
    else          scene.draftFunnels.push({ r: target.r, c: target.c, side: target.side, role });
    return { mutated: true, persistKind: 'level' };
  }

  return { mutated: false };
}

// ---------- Board pieces ----------
//
// Tool payloads:
//   board.acid           → { kind: 'acid' }
//   board.borderInput    → { kind: 'borderFunnel', role: 'input' }
//   board.borderOutput   → { kind: 'borderFunnel', role: 'output' }
//   board.borderEmitter  → { kind: 'borderFunnel', role: 'emitter' }
//   board.borderCatcher  → { kind: 'borderFunnel', role: 'collector' }
//
// Acid pits go on interior cells (not border, not on a factory). Border
// funnels go on border edges; for input/output we also seed a typed entry
// in level.inputs / level.outputs (see Simulation._collectFunnelTypes).

function _applyBoardPiece(scene, tool, target) {
  const payload = tool.payload || {};

  if (payload.kind === 'acid') {
    if (target.kind !== 'boardCell') return { mutated: false };
    const { r, c } = target;
    const board = scene.level.board;
    if (isBorderCell(board, r, c)) return { mutated: false };
    if (scene._factoryAtBoardCell(r, c)) return { mutated: false };
    if (scene._acidPitAt && scene._acidPitAt(r, c)) return { mutated: false };
    if (!Array.isArray(scene.level.acidPits)) scene.level.acidPits = [];
    scene.level.acidPits.push({ r, c });
    return { mutated: true, persistKind: 'level' };
  }

  if (payload.kind === 'borderFunnel') {
    if (target.kind !== 'borderEdge') return { mutated: false };
    const { r, c, side } = target;
    // Cross-round collision: in boss editor mode, reject placement when
    // another round already claims this (r,c,side) slot for any funnel
    // role. "You can't stack border items on top of each other" across
    // rounds — each slot is owned by exactly one stage.
    if (scene._bossMode && scene.level.boss && Array.isArray(scene.level.boss.rounds)) {
      const currentIdx = scene._bossStageIdx | 0;
      for (let i = 0; i < scene.level.boss.rounds.length; i++) {
        if (i === currentIdx) continue;
        const fs = (scene.level.boss.rounds[i].border && scene.level.boss.rounds[i].border.funnels) || [];
        if (fs.some((f) => f.r === r && f.c === c && f.side === side)) {
          return { mutated: false, rejectReason: 'borderSlotClaimed' };
        }
      }
    }
    if (!scene.level.border) scene.level.border = { funnels: [] };
    const arr = scene.level.border.funnels;
    const existingIdx = arr.findIndex((f) => f.r === r && f.c === c && f.side === side);
    const role = payload.role;
    if (existingIdx >= 0) arr[existingIdx].role = role;
    else                   arr.push({ r, c, side, role });

    // Maintain the typed-entry sidecar (level.inputs / level.outputs) so
    // the simulator picks up a default type. Switching role drops the old
    // typed entry and seeds a new one as appropriate.
    _removeBorderTypedEntry(scene.level, r, c, side);
    if (role === 'input' || role === 'output') {
      _upsertBorderTypedEntry(scene.level, role, r, c, side, { ...DEFAULT_SHAPE_TYPE });
    }
    return { mutated: true, persistKind: 'level' };
  }

  return { mutated: false };
}

function _upsertBorderTypedEntry(level, role, r, c, side, type) {
  const key = role === 'output' ? 'outputs' : 'inputs';
  if (!Array.isArray(level[key])) level[key] = [];
  const bucket = level[key];
  const idx = bucket.findIndex((e) => e.r === r && e.c === c && e.side === side);
  const entry = { r, c, side, type: { ...type } };
  if (idx < 0) bucket.push(entry);
  else         bucket[idx] = entry;
}

function _removeBorderTypedEntry(level, r, c, side) {
  for (const key of ['inputs', 'outputs']) {
    if (!Array.isArray(level[key])) continue;
    level[key] = level[key].filter((e) => !(e.r === r && e.c === c && e.side === side));
  }
}

// ---------- Labels ----------
//
// Tool payloads:
//   label.<form>.<color> → { kind: 'label', label: { form, color } }
//   label.eraser         → { kind: 'label', clear: true }
//   label.bolt           → { kind: 'bolt' }
//
// Drops on a board factory cell or a composer draft cell. Eraser clears
// label AND bolt on the cell. Bolt toggles the cell's `bolt` flag.

function _applyLabel(scene, tool, target) {
  const payload = tool.payload || {};

  // ---- Acid pits ----
  // Pits only honor the COLOR axis. Form-only labels are no-ops since a
  // pit has no form. Eraser clears the pit's color back to the default
  // (untyped) appearance. Bolt is a no-op (factory-cell-only).
  if (target.kind === 'acidPit') {
    const pit = scene._acidPitAt && scene._acidPitAt(target.r, target.c);
    if (!pit) return { mutated: false };
    if (payload.kind === 'label' && payload.clear) {
      if (!pit.label) return { mutated: false };
      delete pit.label;
      return { mutated: true, persistKind: 'level' };
    }
    if (payload.kind === 'label' && payload.label && payload.label.color) {
      pit.label = { color: payload.label.color };
      return { mutated: true, persistKind: 'level' };
    }
    return { mutated: false };
  }

  // ---- Border funnels ----
  // Labels mutate the typed sidecar entry (level.inputs / level.outputs).
  // Emitter / collector are laser entities and don't carry shape types.
  // Eraser drops the typed entry entirely (sim falls back to default).
  // Partial labels MERGE with the existing type — applying a color-only
  // label preserves the existing form, and applying a form-only label
  // preserves the existing color. Replacing only happens when the new
  // label specifies both axes.
  if (target.kind === 'borderFunnel') {
    if (target.role === 'emitter' || target.role === 'collector') return { mutated: false };
    const bucketKey = target.role === 'output' ? 'outputs' : 'inputs';
    if (!Array.isArray(scene.level[bucketKey])) scene.level[bucketKey] = [];
    const bucket = scene.level[bucketKey];
    const idx = bucket.findIndex((e) => e.r === target.r && e.c === target.c && e.side === target.side);
    if (payload.kind === 'label' && payload.clear) {
      if (idx < 0) return { mutated: false };
      bucket.splice(idx, 1);
      return { mutated: true, persistKind: 'level' };
    }
    if (payload.kind === 'label' && payload.label) {
      const existing = (idx >= 0 && bucket[idx].type) ? bucket[idx].type : null;
      const merged = { ...(existing || {}), ...payload.label };
      // Drop falsy keys from a partial overlay so leftover undefineds
      // don't pollute the entry.
      for (const k of Object.keys(merged)) if (!merged[k]) delete merged[k];
      const entry = { r: target.r, c: target.c, side: target.side, type: merged };
      if (idx < 0) bucket.push(entry); else bucket[idx] = entry;
      return { mutated: true, persistKind: 'level' };
    }
    return { mutated: false };
  }

  // ---- Factory cells / composer cells ----
  let cellRecord = null;
  if (target.kind === 'factoryCell') {
    const fac = scene.level.factories.find((f) => f.id === target.factoryId);
    if (!fac) return { mutated: false };
    const relR = target.r - fac.anchor.row;
    const relC = target.c - fac.anchor.col;
    cellRecord = fac.cells.find((cc) => cc.r === relR && cc.c === relC);
  } else if (target.kind === 'composerCell') {
    cellRecord = scene.draftCells.find((cc) => cc.r === target.r && cc.c === target.c);
  }
  if (!cellRecord) return { mutated: false };

  if (payload.kind === 'label' && payload.clear) {
    let changed = false;
    if (cellRecord.label) { delete cellRecord.label; changed = true; }
    if (cellRecord.bolt)  { delete cellRecord.bolt;  changed = true; }
    return { mutated: changed, persistKind: 'level' };
  }
  if (payload.kind === 'label' && payload.label) {
    cellRecord.label = { ...payload.label };
    return { mutated: true, persistKind: 'level' };
  }
  if (payload.kind === 'bolt') {
    cellRecord.bolt = !cellRecord.bolt;
    return { mutated: true, persistKind: 'level' };
  }
  return { mutated: false };
}

function _findAdjacentFactory(level, r, c) {
  for (const fac of level.factories) {
    for (const cc of fac.cells) {
      const cellR = fac.anchor.row + cc.r;
      const cellC = fac.anchor.col + cc.c;
      if (Math.abs(cellR - r) + Math.abs(cellC - c) === 1) return fac;
    }
  }
  return null;
}

// Add (r, c) — absolute board coords — to `factory`. If the new cell sits
// to the upper or left of the existing anchor, shift the anchor (and all
// existing relative cell + funnel coords) so cell coords stay non-negative.
// After the merge, any funnel whose edge is no longer on the perimeter
// (because the new cell now butts up against it) is dropped.
function _mergeCellIntoFactory(factory, r, c) {
  const relR = r - factory.anchor.row;
  const relC = c - factory.anchor.col;
  const shiftR = Math.min(0, relR);
  const shiftC = Math.min(0, relC);
  if (shiftR < 0 || shiftC < 0) {
    factory.anchor.row += shiftR;
    factory.anchor.col += shiftC;
    for (const cc of factory.cells)        { cc.r -= shiftR; cc.c -= shiftC; }
    for (const f  of factory.funnels || []) { f.r  -= shiftR; f.c  -= shiftC; }
  }
  factory.cells.push({ r: relR - shiftR, c: relC - shiftC });
  if (Array.isArray(factory.funnels) && factory.funnels.length > 0) {
    factory.funnels = factory.funnels.filter(
      (f) => isPerimeterEdge(factory.cells, f.r, f.c, f.side),
    );
  }
}
