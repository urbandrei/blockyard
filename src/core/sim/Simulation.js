// Shape-flow simulation. Port of v1 js/simulation.js, stripped of DOM
// coupling. The scene that owns a Simulation calls start() and then update(now)
// from its own update(). Shape visuals are created/destroyed by a
// ShapeRenderer the scene wires in via the `onSpawn` / `onRemove` callbacks.

import { SHAPE_SCALE, CYCLE_MS, SIDE_TO_EXIT, cumulativeDistance } from '../constants.js';
import { borderCells, DEFAULT_SHAPE_TYPE, hasAnyLabel, cellLabelAt } from '../model/shape.js';

// Small collision tolerance — the shape should visibly reach the factory edge
// before despawning, so the funnel appears to "swallow" it. Large enough that
// per-frame motion during the fast phase can't slip past undetected.
const HIT_RADIUS_FRAC = 0.05;

function outwardDir(side) {
  // Direction AWAY from the cell through the given edge. For border cells
  // this points into the play area; for interior factories away from the factory.
  switch (side) {
    case 'top':    return [0, -1];
    case 'bottom': return [0,  1];
    case 'left':   return [-1, 0];
    case 'right':  return [ 1, 0];
  }
  return [0, 0];
}

function edgeMidpointAbs(r, c, side, pxCell, pxGap, scale) {
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

// From the player's (inside) perspective: sinks consume circles, sources emit.
// Border is inverted because we view it from inside the play area.
function isSink(f)   { return (f.ownerId === 'border' && f.role === 'output') || (f.ownerId !== 'border' && f.role === 'input'); }
function isSource(f) { return (f.ownerId === 'border' && f.role === 'input')  || (f.ownerId !== 'border' && f.role === 'output'); }

export class Simulation {
  constructor({ pxCell, pxGap, onSpawn, onRemove, onSinkResolve }) {
    this.pxCell = pxCell;
    this.pxGap = pxGap;
    this.cellStep = pxCell + pxGap;
    this.hitRadius = pxCell * HIT_RADIUS_FRAC;
    this.onSpawn = onSpawn || (() => {});
    this.onRemove = onRemove || (() => {});
    // Fires when a TYPED border sink resolves a shape — accepted=true for a
    // form/color match, false for a mismatch (the sim still pops the shape
    // either way; this is purely the side-channel the scene listens on for
    // ✓/X markers). Untyped sinks are wildcards and don't fire this.
    this.onSinkResolve = onSinkResolve || (() => {});
    this.shapes = [];
    this.funnels = [];
    this.walls = new Map();
    this.hitsThisCycle = new Map();
    this.firedThisCycle = new Set();
    this.sinksByOwner = new Map();
    this.cycleStart = 0;
    this.lastBoundary = 0;
    this.nextId = 1;
    this.running = false;
  }

  start(level, now) {
    this.stop();
    this.funnels = this._collectFunnels(level);
    this.walls = this._collectWalls(level);
    this.funnelTypes = this._collectFunnelTypes(level);
    // Pre-compute the required sink set per interior factory. Used each sink
    // hit to check "have all sinks on this factory been hit this cycle?" so we
    // can fire sources immediately (no cycle-boundary wait).
    this.sinksByOwner = new Map();
    for (const f of this.funnels) {
      if (!isSink(f)) continue;
      if (f.ownerId === 'border') continue;
      if (!this.sinksByOwner.has(f.ownerId)) this.sinksByOwner.set(f.ownerId, new Set());
      this.sinksByOwner.get(f.ownerId).add(f.key);
    }
    this.firedThisCycle.clear();
    this.cycleStart = now;
    this.lastBoundary = 0;
    this.hitsThisCycle.clear();
    this.shapes.length = 0;
    // Per-owner pass-through stamp: when a factory's input funnel has no
    // declared type (pass-through or unlabeled-input cell), the shape that
    // satisfied the sink is recorded here and reused as the form/color for
    // any output funnel that ALSO has no declared type. Cleared each cycle.
    this.inputStamps = new Map();
    this.running = true;
    // Initial emission — border sources fire once at t=0.
    this._fireBorderSources(now);
  }

  stop() {
    for (const s of this.shapes) if (!s.dead) this.onRemove(s, /*pop*/false);
    this.shapes.length = 0;
    this.running = false;
    this.paused = false;
  }

  // Freeze/unfreeze the sim without dropping live shapes. The scene calls
  // this when the player taps to pause an in-progress run. Time-shift on
  // resume keeps cycle math + per-shape phases consistent.
  pause(now) {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.pauseTime = now;
  }
  resume(now) {
    if (!this.paused) return;
    const dt = now - this.pauseTime;
    this.cycleStart += dt;
    for (const s of this.shapes) {
      if (s.dead) continue;
      s.birthTime += dt;
      s.birthCycles = cumulativeDistance(s.birthTime / CYCLE_MS);
    }
    this.paused = false;
  }

  update(now) {
    if (!this.running || this.paused) return;

    // Fire any cycle boundaries we crossed during the last frame BEFORE
    // advancing positions — so newly-spawned shapes get positioned against
    // their correct birth time in this frame's advance pass. Under severe
    // lag we may cross multiple boundaries in a single frame; fire once per
    // crossed boundary with its own timestamp so each spawn cohort's math
    // stays accurate. (Pre-fix: only ever fired once even across multi-
    // boundary skips, which silently dropped border emissions on mobile.)
    const boundary = Math.floor((now - this.cycleStart) / CYCLE_MS);
    // Cap catch-up at 10 boundaries to avoid runaway spawning if the tab
    // was backgrounded for a long time without going through pause/resume
    // (e.g. when the platform adapter can't wire Page Visibility hooks).
    if (boundary - this.lastBoundary > 10) this.lastBoundary = boundary - 10;
    while (this.lastBoundary < boundary) {
      this.lastBoundary += 1;
      this.hitsThisCycle.clear();
      this.firedThisCycle.clear();
      this.inputStamps.clear();
      const boundaryTime = this.cycleStart + this.lastBoundary * CYCLE_MS;
      this._fireBorderSources(boundaryTime);
    }

    // Position each live shape on the absolute phase curve so motion stays
    // aligned with the pulse / dash cycle. Stash prevX/prevY first so the
    // collision pass can test the full segment the shape traversed this
    // frame (swept collision) — a single-point hit test can't catch funnel
    // entries when a long frame moves the shape more than hitRadius.
    const dNow = cumulativeDistance(now / CYCLE_MS);
    for (const s of this.shapes) {
      if (s.dead) continue;
      s.prevX = s.x;
      s.prevY = s.y;
      const delta = (dNow - s.birthCycles) * this.cellStep;
      s.x = s.birthX + s.dx * delta;
      s.y = s.birthY + s.dy * delta;
    }

    // Collisions.
    for (const s of this.shapes) {
      if (s.dead) continue;
      const f = this._funnelHit(s);
      if (f) {
        if (isSink(f)) {
          // Typed sinks reject mismatched shapes with a POP and DO NOT count
          // toward the per-cycle hit set. Untyped sinks accept anything.
          // Partial labels (form-only or color-only) compare on the declared
          // axis only — the other axis is wildcard.
          const expected = this.funnelTypes && this.funnelTypes.get(f.key);
          const accepted =
            !expected ||
            ((!expected.form  || s.form  === expected.form) &&
             (!expected.color || s.color === expected.color));
          if (accepted) {
            this._recordSinkHit(f, now, s);
            this._kill(s, false);
          } else {
            this._kill(s, true);
          }
          // Side-channel for the scene's ✓/X markers — typed border sinks only.
          if (expected && f.ownerId === 'border') this.onSinkResolve(f, accepted);
        } else {
          this._kill(s, true);
        }
        continue;
      }
      if (this._wallHit(s)) { this._kill(s, true); continue; }
      if (s.x < -200 || s.y < -200 || s.x > 5000 || s.y > 5000) this._kill(s, false);
    }

    // Sweep dead shapes.
    if (this.shapes.some((s) => s.dead)) {
      this.shapes = this.shapes.filter((s) => !s.dead);
    }
  }

  // Grow/shrink scale for a shape. Called by the renderer each frame.
  //
  // Shrink window = final fast phase of the motion curve (0.85 → 1.0 of a
  // cycle = the last 0.35 of a cell). Staying at full size during the slow
  // plateau feels right because the shape isn't really moving then; the
  // shrink only kicks in once it's sliding fast into the funnel.
  //
  // Grow uses an ease-out curve (1 - (1-t)²) so it's a visual mirror of the
  // shrink: shape pops out of the funnel fast, then settles toward full
  // size. Fast-at-start, slow-at-end matches the fast→slow pacing felt on
  // the shrink side (scale drops quickly at first, then eases to zero).
  shapeScale(s, now) {
    const GROW_MS = CYCLE_MS * 0.5;
    const SHRINK_DIST = this.cellStep * 0.35;
    const age = now - s.birthTime;
    const gT = Math.max(0, Math.min(1, age / GROW_MS));
    const growScale = 1 - (1 - gT) * (1 - gT);
    // sinkDist is the along-axis distance from birth to the nearest sink in
    // the direction of motion, precomputed at spawn. We recover the current
    // distance-ahead via traveled = axial displacement from birth (shapes
    // move strictly along dx/dy so this is exact). Swapping the former
    // per-frame O(funnels) scan for O(1) arithmetic is a mobile-hot win.
    let distAhead;
    if (!Number.isFinite(s.sinkDist)) {
      distAhead = Infinity;
    } else {
      const traveled = (s.x - s.birthX) * s.dx + (s.y - s.birthY) * s.dy;
      distAhead = s.sinkDist - traveled;
    }
    let shrinkScale = 1;
    if (distAhead < SHRINK_DIST) {
      shrinkScale = Math.max(0, distAhead / SHRINK_DIST);
    }
    return growScale * shrinkScale;
  }

  // ---------- internals ----------

  _collectFunnels(level) {
    const list = [];
    const add = (ownerId, absR, absC, side, role, scale) => {
      const [x, y] = edgeMidpointAbs(absR, absC, side, this.pxCell, this.pxGap, scale);
      const [dx, dy] = outwardDir(side);
      list.push({
        ownerId, role, side, absR, absC, scale,
        x, y, dx, dy,
        key: `${ownerId}:${absR},${absC},${side}`,
      });
    };
    for (const fac of level.factories || []) {
      for (const f of (fac.funnels || [])) {
        add(fac.id, fac.anchor.row + f.r, fac.anchor.col + f.c, f.side, f.role, SHAPE_SCALE);
      }
    }
    if (level.border && Array.isArray(level.border.funnels)) {
      for (const f of level.border.funnels) {
        add('border', f.r, f.c, f.side, f.role, 1);
      }
    }
    return list;
  }

  _collectWalls(level) {
    // Buffer cells are invisible walls — they don't render a ring body (that
    // was dropped in Milestone B) but they DO pop shapes that escape the
    // interior anywhere other than a funnel. Interior factories continue to
    // act as walls at their own scale.
    const map = new Map();
    for (const cell of borderCells(level.board)) {
      map.set(`${cell.r},${cell.c}`, { scale: 1 });
    }
    for (const fac of level.factories || []) {
      for (const cell of fac.cells) {
        map.set(`${fac.anchor.row + cell.r},${fac.anchor.col + cell.c}`, { scale: SHAPE_SCALE });
      }
    }
    return map;
  }

  // Map funnel.key → ShapeType. Two roles share this map:
  //   • SOURCE keys (border inputs, factory outputs on a labeled cell) — read
  //     by _spawn to stamp emitted shapes with the declared form+color.
  //   • SINK keys   (border outputs, factory inputs on a labeled cell)  — read
  //     by _recordSinkHit to enforce the `expects` contract (mismatch → POP).
  // Border types come from level.inputs / level.outputs.
  // Factory types come from per-cell labels:
  //   • Single-cell labeled factory: INPUTS are wildcard (no entry), OUTPUTS
  //     emit the label.
  //   • Multi-cell factory: a funnel on a labeled cell inherits the label —
  //     enforced for both INPUT and OUTPUT roles. Funnels on unlabeled cells
  //     have no entry (input wildcard, output forwards from sink — see
  //     _spawn for forwarding semantics).
  _collectFunnelTypes(level) {
    const map = new Map();
    const fill = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const e of entries) {
        if (!e || !e.type) continue;
        map.set(`border:${e.r},${e.c},${e.side}`, { ...e.type });
      }
    };
    fill(level.inputs);
    fill(level.outputs);
    for (const fac of level.factories || []) {
      if (!hasAnyLabel(fac.cells)) continue;
      const isSingleCell = fac.cells.length === 1;
      for (const f of (fac.funnels || [])) {
        const key = `${fac.id}:${fac.anchor.row + f.r},${fac.anchor.col + f.c},${f.side}`;
        const cellLabel = cellLabelAt(fac.cells, f.r, f.c);
        if (isSingleCell) {
          // Single-cell: input wildcard (skip), output emits the cell's label.
          if (f.role === 'output' && cellLabel) map.set(key, { ...cellLabel });
        } else {
          // Multi-cell: funnel on labeled cell takes that cell's label.
          if (cellLabel) map.set(key, { ...cellLabel });
        }
      }
    }
    return map;
  }

  // Swept funnel hit — tests whether the shape's motion this frame (segment
  // from prevX/prevY to x/y) passes within `hitRadius` of any funnel center.
  // Returns the EARLIEST hit along the segment so the shape enters the first
  // funnel it crosses, not an arbitrary one. A point-only test misses
  // tunneling: at low mobile frame rates the shape can jump past a funnel
  // entirely in one frame, which is the root cause of "factories don't
  // output" under lag.
  _funnelHit(s) {
    const R2 = this.hitRadius * this.hitRadius;
    const ax = s.prevX != null ? s.prevX : s.x;
    const ay = s.prevY != null ? s.prevY : s.y;
    const bx = s.x, by = s.y;
    const abx = bx - ax, aby = by - ay;
    const abLen2 = abx * abx + aby * aby;
    let bestT = Infinity;
    let bestF = null;
    for (const f of this.funnels) {
      if (s.sourceKey === f.key) continue;
      let t, px, py;
      if (abLen2 < 1e-6) {
        t = 0; px = ax; py = ay;
      } else {
        t = ((f.x - ax) * abx + (f.y - ay) * aby) / abLen2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        px = ax + abx * t;
        py = ay + aby * t;
      }
      const dx = px - f.x, dy = py - f.y;
      if (dx * dx + dy * dy < R2 && t < bestT) {
        bestT = t; bestF = f;
      }
    }
    return bestF;
  }

  _wallHit(s) {
    // Swept wall test — sample the prev→curr segment at half-cell steps so
    // fast shapes under mobile lag can't tunnel straight through a factory
    // body. Shapes move axis-aligned so half-cell sampling is sufficient to
    // land at least once inside any wall cell the segment traverses.
    const ax = s.prevX != null ? s.prevX : s.x;
    const ay = s.prevY != null ? s.prevY : s.y;
    const dx = s.x - ax, dy = s.y - ay;
    const dist = Math.abs(dx) + Math.abs(dy);
    const stepSize = this.pxCell * 0.5;
    const steps = Math.max(1, Math.ceil(dist / stepSize));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this._wallHitAt(ax + dx * t, ay + dy * t)) return true;
    }
    return false;
  }

  _wallHitAt(x, y) {
    const step = this.cellStep;
    const r = Math.floor(y / step);
    const col = Math.floor(x / step);
    const wall = this.walls.get(`${r},${col}`);
    if (!wall) return false;
    const inner = this.pxCell * wall.scale;
    const m = (this.pxCell - inner) / 2;
    const lx = x - col * step, ly = y - r * step;
    return lx >= m && ly >= m && lx <= m + inner && ly <= m + inner;
  }

  // Record a sink hit and, if this was the LAST required sink for the factory
  // this cycle, fire the factory's sources immediately. No cycle-boundary wait.
  // `consumed` is the shape that satisfied the sink — its form+color is the
  // pass-through stamp used by `_spawn` when the source funnel has no typed
  // entry of its own.
  _recordSinkHit(funnel, now, consumed) {
    const ownerId = funnel.ownerId;
    let set = this.hitsThisCycle.get(ownerId);
    if (!set) { set = new Set(); this.hitsThisCycle.set(ownerId, set); }
    set.add(funnel.key);
    // Track the latest consumed shape per owner — pass-through outputs read
    // this in _spawn. Border owners track too (cheap, harmless).
    if (consumed) this.inputStamps.set(ownerId, { form: consumed.form, color: consumed.color });
    if (ownerId === 'border') return;                  // border sinks don't trigger firing
    if (this.firedThisCycle.has(ownerId)) return;      // already fired this cycle
    const required = this.sinksByOwner.get(ownerId);
    if (!required) return;
    for (const k of required) if (!set.has(k)) return; // still waiting on a sink
    this.firedThisCycle.add(ownerId);
    for (const f of this.funnels) {
      if (f.ownerId === ownerId && isSource(f)) this._spawn(f, now);
    }
  }

  _fireBorderSources(now) {
    for (const f of this.funnels) {
      if (f.ownerId === 'border' && f.role === 'input') this._spawn(f, now);
    }
  }

  _spawn(funnel, now) {
    const inset = 2;
    const sx = funnel.x + funnel.dx * inset;
    const sy = funnel.y + funnel.dy * inset;
    // Stamp the spawned shape with the funnel's declared type (form+color).
    // Resolution is per-axis so partial labels (form-only or color-only)
    // still produce a fully-typed shape: declared axis → owner's input
    // stamp → default. The stamp is consulted even when declared exists,
    // because declared may only specify ONE axis.
    const declared = this.funnelTypes && this.funnelTypes.get(funnel.key);
    const stamp = this.inputStamps && this.inputStamps.get(funnel.ownerId);
    const form  = (declared && declared.form)  || (stamp && stamp.form)  || DEFAULT_SHAPE_TYPE.form;
    const color = (declared && declared.color) || (stamp && stamp.color) || DEFAULT_SHAPE_TYPE.color;
    // Precompute the axial distance from birth to the nearest sink ahead in
    // the shape's direction of motion. shapeScale() uses this every frame
    // to drive the shrink animation; caching here saves an O(funnels) scan
    // per live shape per frame. Valid because dx/dy and the funnel set are
    // both constant for the life of the shape.
    let sinkDist = Infinity;
    const R = this.hitRadius;
    for (const f of this.funnels) {
      if (!isSink(f)) continue;
      if (f.key === funnel.key) continue;
      const toFx = f.x - sx, toFy = f.y - sy;
      const along = toFx * funnel.dx + toFy * funnel.dy;
      if (along <= 0) continue;
      const perp = toFx * funnel.dy - toFy * funnel.dx;
      if ((perp < 0 ? -perp : perp) > R) continue;
      if (along < sinkDist) sinkDist = along;
    }
    const shape = {
      id: this.nextId++,
      x: sx, y: sy,
      // Swept-collision reads prevX/prevY; seed to birth position so the
      // first post-spawn frame tests the segment from birth → new position.
      prevX: sx, prevY: sy,
      birthX: sx, birthY: sy,
      birthTime: now,
      birthCycles: cumulativeDistance(now / CYCLE_MS),
      dx: funnel.dx, dy: funnel.dy,
      sourceKey: funnel.key,
      sinkDist,
      form, color,
      scale: 0,
      dead: false,
    };
    this.shapes.push(shape);
    this.onSpawn(shape);
  }

  _kill(s, pop) {
    s.dead = true;
    this.onRemove(s, pop);
  }
}
