// Shape-flow simulation. Port of v1 js/simulation.js, stripped of DOM
// coupling. The scene that owns a Simulation calls start() and then update(now)
// from its own update(). Shape visuals are created/destroyed by a
// ShapeRenderer the scene wires in via the `onSpawn` / `onRemove` callbacks.

import { SHAPE_SCALE, CYCLE_MS, SIDE_TO_EXIT, SIDE_OPPOSITE, cumulativeDistance, ACID_CROSS_CELLS } from '../constants.js';
import { borderCells, DEFAULT_SHAPE_TYPE, hasAnyLabel, cellLabelAt, COLOR_HEX } from '../model/shape.js';
import { emitterGapCenter, emitterTipOffset } from '../render/EmitterGlyph.js';

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// Current visible tint for a shape — mid-transition lerp, or the shape's
// committed color otherwise. Used by the sim on retarget so the new "from"
// picks up where the old one left off, avoiding a color snap.
function currentShapeHex(s) {
  const base = COLOR_HEX[s.color] || 0xffffff;
  if (!s._acidTargetName || !s._acidFromHex || !(s._acidProgress > 0 && s._acidProgress < 1)) return base;
  const toHex = COLOR_HEX[s._acidTargetName] || base;
  return lerpHex(s._acidFromHex, toHex, s._acidProgress);
}

// Small collision tolerance — the shape should visibly reach the factory edge
// before despawning, so the funnel appears to "swallow" it. Large enough that
// per-frame motion during the fast phase can't slip past undetected.
const HIT_RADIUS_FRAC = 0.05;

// How long a shape stays frozen mid-air after being struck by a laser,
// before it shatters into the fade-out debris burst (ms). Kept short so
// the dramatic beat doesn't overstay its welcome.
const ELECTROCUTE_MS = 400;

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
// Emitter / collector roles are outside this classification — they don't
// spawn or consume shapes, so they're neither sinks nor sources.
function isShapeFunnel(f) { return f.role === 'input' || f.role === 'output'; }
function isSink(f)   { return isShapeFunnel(f) && ((f.ownerId === 'border' && f.role === 'output') || (f.ownerId !== 'border' && f.role === 'input')); }
function isSource(f) { return isShapeFunnel(f) && ((f.ownerId === 'border' && f.role === 'input')  || (f.ownerId !== 'border' && f.role === 'output')); }

export class Simulation {
  constructor({ pxCell, pxGap, onSpawn, onRemove, onSinkResolve, onCollectorSatisfied }) {
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
    // Fires the first time a border laser collector is hit by any beam.
    // Win-condition plumbing reads `sim.satisfiedCollectors` directly; this
    // callback is the side-channel for scenes that want to mark the visual.
    this.onCollectorSatisfied = onCollectorSatisfied || (() => {});
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
    // Laser state — populated by start(), updated each tick.
    this.emitters = [];
    this.collectors = [];
    this.lasers = [];
    this.satisfiedCollectors = new Set();
    this.boltPowered = new Map();
    this._lastUpdateMs = null;
  }

  start(level, now) {
    this.stop();
    this.funnels = this._collectFunnels(level);
    this.walls = this._collectWalls(level);
    this.funnelTypes = this._collectFunnelTypes(level);
    this._collectLaserEntities(level);
    this.lasers = [];
    this.satisfiedCollectors = new Set();
    this.boltPowered = new Map();
    this._lastUpdateMs = now;
    this._boltCells = this._collectBoltCells(level);
    // Per-factory timestamp of when all bolts first became powered (used
    // by the "delay emitter trigger until the bolt glow is filled" gate).
    this._factoryBoltsPoweredSince = new Map();
    // Acid pits: shapes flow over them, but labeled pits gradually retint
    // a passing shape. Shapes aren't blocked — walls are unchanged.
    this.acidByCell = new Map();
    for (const pit of (level.acidPits || [])) {
      if (pit.label && pit.label.color) this.acidByCell.set(`${pit.r},${pit.c}`, pit.label.color);
    }
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
    // Border sinks sit at SHAPE_SCALE inside a buffer cell whose wall spans
    // the whole cell — so shapes aimed at the sink would trip the wall on
    // entry before reaching the funnel. Treat those cells as passable for
    // wall-collision; shapes still pop at the funnel via _funnelHit (which
    // runs first), or fall off via OOB kill if they miss.
    this._sinkPassableCells = new Set();
    for (const f of this.funnels) {
      if (f.ownerId === 'border' && isSink(f)) this._sinkPassableCells.add(`${f.absR},${f.absC}`);
    }
    this.firedThisCycle.clear();
    this.cycleStart = now;
    this.lastBoundary = 0;
    this._prevDNow = null;
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
    this.lasers = [];
    this.boltPowered = new Map();
    this._lastUpdateMs = null;
    // Reset laser entity state so a re-play starts from a clean idle.
    if (this.emitters) {
      for (const e of this.emitters) {
        e.power = 0;
        e.firing = false;
        e.triggered = false;
      }
    }
    this._factoryBoltsPoweredSince = new Map();
  }

  // Populate laser state (emitters/collectors/bolt cells) from the level
  // WITHOUT starting the sim. Lets scenes render the pre-play "idle charge"
  // animation at each emitter tip before the player presses Play.
  prepEntities(level) {
    this._collectLaserEntities(level);
    this._boltCells = this._collectBoltCells(level);
    this.boltPowered = new Map();
    this.lasers = [];
    this._factoryBoltsPoweredSince = new Map();
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
    // Force a fresh progressDelta baseline next frame so the paused gap
    // doesn't lurch any in-flight acid transitions.
    this._prevDNow = null;
    this.paused = false;
  }

  update(now) {
    if (!this.running || this.paused) return;

    const lastMs = this._lastUpdateMs == null ? now : this._lastUpdateMs;
    const dtMs = Math.max(0, now - lastMs);
    this._lastUpdateMs = now;

    // Laser field is updated BEFORE any cycle-boundary firing so bolt power
    // is current when we decide whether a factory's sources may spawn.
    this._updateLasers(dtMs);

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
    const progressDelta = this._prevDNow == null
      ? 0
      : Math.max(0, (dNow - this._prevDNow) / ACID_CROSS_CELLS);
    this._prevDNow = dNow;
    for (const s of this.shapes) {
      if (s.dead) continue;
      // Electrocuted shapes are frozen in place mid-death — their stored
      // prevX/Y stays pinned so swept collision tests don't mis-register
      // them against anything. They tick down their death timer in the
      // collision loop below.
      if (s.electrocuted) continue;
      s.prevX = s.x;
      s.prevY = s.y;
      const delta = (dNow - s.birthCycles) * this.cellStep;
      s.x = s.birthX + s.dx * delta;
      s.y = s.birthY + s.dy * delta;
    }

    // Acid-pit transitions: per shape, look up the acid label at the
    // current cell; start/retarget a color transition when entering a
    // labeled cell, advance progress each frame, and commit to shape.color
    // when the transition completes. Shapes that exit a pit mid-transition
    // keep advancing toward their last target — a shape dipping through a
    // red pit finishes red even if the next cell isn't acid.
    if (this.acidByCell.size > 0 || progressDelta > 0) {
      for (const s of this.shapes) {
        if (s.dead) continue;
        const cr = Math.floor(s.y / this.cellStep);
        const cc = Math.floor(s.x / this.cellStep);
        const label = this.acidByCell.get(`${cr},${cc}`) || null;
        if (label && label !== s.color && label !== s._acidTargetName) {
          // (Re)target. Start from the CURRENT visible tint, not the shape's
          // canonical color — so retargeting mid-transition doesn't snap.
          s._acidFromHex = currentShapeHex(s);
          s._acidTargetName = label;
          s._acidProgress = 0;
        }
        if (s._acidTargetName && (s._acidProgress || 0) < 1) {
          s._acidProgress = Math.min(1, (s._acidProgress || 0) + progressDelta);
          if (s._acidProgress >= 1) {
            // Commit: sink matching from this point on sees the new color.
            s.color = s._acidTargetName;
            s._acidFromHex = null;
            s._acidTargetName = null;
            s._acidProgress = 0;
          }
        }
      }
    }

    // Collisions.
    for (const s of this.shapes) {
      if (s.dead) continue;
      // Electrocuted shapes are dying — tick the freeze timer and skip
      // every other collision test until the death animation plays out.
      if (s.electrocuted) {
        const elapsed = now - s.electrocuteStart;
        s.electrocuteProgress = Math.min(1, elapsed / ELECTROCUTE_MS);
        if (elapsed >= ELECTROCUTE_MS) this._kill(s, true, 'laser');
        continue;
      }
      // Laser-pop test: a shape that crosses a live beam enters its
      // electrocute death sequence instead of an instant pop.
      if (this._laserPops(s)) {
        s.electrocuted = true;
        s.electrocuteStart = now;
        continue;
      }
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
        // Border funnels live at SHAPE_SCALE so their position matches the
        // centered buffer label tile — the triangle/emitter glyph visibly
        // attaches to the tile edge the same way a factory funnel attaches
        // to a factory body edge.
        add('border', f.r, f.c, f.side, f.role, SHAPE_SCALE);
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
      if (!isShapeFunnel(f)) continue;
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
    const key = `${r},${col}`;
    const wall = this.walls.get(key);
    if (!wall) return false;
    // Buffer cells that host a border sink are passable — see start() for
    // why. Funnel-hit resolution still pops shapes at the sink.
    if (this._sinkPassableCells && this._sinkPassableCells.has(key)) return false;
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
    // Lightning-bolt gate: a factory with one or more bolt cells cannot
    // spawn shapes from its outputs until every bolt on it is powered.
    if (!this._factoryBoltsPowered(ownerId)) return;
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
    // Shapes spawn INSET a little from the funnel in the outward direction
    // so the first-frame collision check doesn't snag them on the source's
    // own wall. Border sources additionally have to clear the full-cell
    // buffer wall, which the funnel sits INSIDE of (at SHAPE_SCALE).
    const base = 2;
    const wallClearance = funnel.ownerId === 'border'
      ? (this.pxCell * (1 - (funnel.scale || 1))) / 2
      : 0;
    const inset = base + wallClearance;
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

  _kill(s, pop, cause = null) {
    s.dead = true;
    this.onRemove(s, pop, cause);
  }

  // ---------- laser field ----------
  //
  // Emitters are a separate funnel species — they don't spawn or consume
  // shapes, they shoot straight-line beams. Border emitters are always on.
  // Factory emitters are dormant until a laser from ELSEWHERE strikes them;
  // once struck, every OTHER emitter on the same factory fires outward (the
  // hit one absorbs). Activation/deactivation animates over 1 CYCLE_MS via
  // the per-emitter `power` scalar.

  _collectLaserEntities(level) {
    const emitters = [];
    const collectors = [];
    const byKey = new Map();
    const tipOff = emitterTipOffset(this.pxCell);
    const makeEntity = (ownerId, absR, absC, side, scale) => {
      const [dx, dy] = outwardDir(side);
      const [x, y] = emitterGapCenter(absR, absC, side, this.pxCell, this.pxGap, scale);
      return {
        ownerId, absR, absC, side, dx, dy, x, y, scale,
        // Tip in board-local coords — where the charge animation is anchored.
        tipX: x + dx * tipOff,
        tipY: y + dy * tipOff,
        // Charge state: `power` ∈ [0, 1] lerps both directions over
        // CYCLE_MS. `firing` latches: flips true when power reaches 1,
        // flips false when power returns to 0. Beam fires iff `firing`,
        // so brief trigger drops don't cut the beam or retrigger the
        // fire animation.
        power: 0,
        firing: false,
        triggered: false,
        key: `${ownerId}:${absR},${absC},${side}`,
      };
    };
    if (level.border && Array.isArray(level.border.funnels)) {
      for (const f of level.border.funnels) {
        if (f.role === 'emitter') {
          const e = makeEntity('border', f.r, f.c, f.side, SHAPE_SCALE);
          emitters.push(e); byKey.set(e.key, e);
        } else if (f.role === 'collector') {
          const c = makeEntity('border', f.r, f.c, f.side, SHAPE_SCALE);
          collectors.push(c); byKey.set(c.key, c);
        }
      }
    }
    for (const fac of level.factories || []) {
      const boltedCells = new Set(
        (fac.cells || []).filter((c) => c.bolt).map((c) => `${c.r},${c.c}`)
      );
      for (const f of (fac.funnels || [])) {
        if (f.role !== 'emitter') continue;
        const absR = fac.anchor.row + f.r;
        const absC = fac.anchor.col + f.c;
        const e = makeEntity(fac.id, absR, absC, f.side, SHAPE_SCALE);
        e.bolted = boltedCells.has(`${f.r},${f.c}`);
        emitters.push(e); byKey.set(e.key, e);
      }
    }
    this.emitters = emitters;
    this.collectors = collectors;
    this._laserByKey = byKey;
  }

  _collectBoltCells(level) {
    // Map factoryId → Set of "absR,absC" carrying a lightning bolt. Absolute
    // coords match the scene's render-side lookup (factory.anchor + cell.r/c).
    const map = new Map();
    for (const fac of level.factories || []) {
      for (const cell of (fac.cells || [])) {
        if (!cell.bolt) continue;
        if (!map.has(fac.id)) map.set(fac.id, new Set());
        map.get(fac.id).add(`${fac.anchor.row + cell.r},${fac.anchor.col + cell.c}`);
      }
    }
    return map;
  }

  _factoryBoltsPowered(factoryId) {
    const bolts = this._boltCells && this._boltCells.get(factoryId);
    if (!bolts || bolts.size === 0) return true;
    for (const cellKey of bolts) {
      if (!this.boltPowered.get(`${factoryId}:${cellKey}`)) return false;
    }
    return true;
  }

  _updateLasers(dtMs) {
    const now = this._lastUpdateMs;

    // 1. Cast rays from emitters that are currently FIRING. `firing` is a
    //    latched flag (true once power reaches 1, false only once power
    //    returns to 0) so brief trigger drops don't flicker the beam.
    const beams = [];
    const hitEmitters = new Set();
    const hitCollectors = new Set();
    const boltLit = new Map();

    for (const src of this.emitters) {
      if (!src.firing) continue;
      const ray = this._castLaser(src);
      beams.push({
        x0: src.x, y0: src.y, x1: ray.endX, y1: ray.endY,
        power: src.power, sourceKey: src.key,
        hitType: ray.terminator || 'open',
      });
      if (ray.hitEmitterKey) {
        const target = this._laserByKey && this._laserByKey.get(ray.hitEmitterKey);
        if (target && target.ownerId !== src.ownerId) {
          hitEmitters.add(ray.hitEmitterKey);
          if (target.ownerId !== 'border') {
            boltLit.set(`${target.ownerId}:${target.absR},${target.absC}`, true);
          }
        }
      }
      if (ray.hitCollectorKey) hitCollectors.add(ray.hitCollectorKey);
    }

    this.lasers = beams;
    this.boltPowered = boltLit;

    // 2. Track how long each bolted factory has been fully powered. The
    //    emitter-charge animation only starts once the bolts have had a
    //    full CYCLE_MS to visually fill in — so "charge" follows "bolt
    //    fully lit" rather than racing it.
    if (this._boltCells) {
      for (const factoryId of this._boltCells.keys()) {
        if (this._factoryBoltsPowered(factoryId)) {
          if (!this._factoryBoltsPoweredSince.has(factoryId)) {
            this._factoryBoltsPoweredSince.set(factoryId, now);
          }
        } else {
          this._factoryBoltsPoweredSince.delete(factoryId);
        }
      }
    }

    // 3. Compute `triggered` per emitter.
    //    • Border: running.
    //    • Bolted factory: all bolts powered for ≥ CYCLE_MS.
    //    • Non-bolted factory: sibling-hit rule.
    const hitsByFactory = new Map();
    for (const key of hitEmitters) {
      const e = this._laserByKey.get(key);
      if (!e || e.ownerId === 'border') continue;
      hitsByFactory.set(e.ownerId, (hitsByFactory.get(e.ownerId) || 0) + 1);
    }
    for (const e of this.emitters) {
      if (e.ownerId === 'border') {
        e.triggered = !!this.running;
      } else {
        const factoryBolts = this._boltCells && this._boltCells.get(e.ownerId);
        const factoryHasBolts = !!(factoryBolts && factoryBolts.size > 0);
        if (factoryHasBolts) {
          const since = this._factoryBoltsPoweredSince.get(e.ownerId);
          e.triggered = since !== undefined && (now - since) >= CYCLE_MS;
        } else {
          const siblingHits =
            (hitsByFactory.get(e.ownerId) || 0) - (hitEmitters.has(e.key) ? 1 : 0);
          e.triggered = siblingHits > 0;
        }
      }
    }

    // 4. Lerp power toward the trigger state. Both directions take
    //    CYCLE_MS; `firing` latches on at power == 1 and off at power == 0
    //    so the beam stays steady through brief trigger flickers.
    const step = CYCLE_MS > 0 ? (dtMs / CYCLE_MS) : 1;
    for (const e of this.emitters) {
      const cur = e.power || 0;
      const next = e.triggered
        ? Math.min(1, cur + step)
        : Math.max(0, cur - step);
      e.power = next;
      if (!e.firing && next >= 1) e.firing = true;
      else if (e.firing && next <= 0.0001) e.firing = false;
    }

    // 5. Collector satisfaction (one-shot, latches on first hit).
    for (const key of hitCollectors) {
      if (this.satisfiedCollectors.has(key)) continue;
      this.satisfiedCollectors.add(key);
      const col = this._laserByKey.get(key);
      if (col) this.onCollectorSatisfied(col);
    }
  }

  _castLaser(src) {
    const { pxCell, pxGap } = this;
    const backSide = SIDE_OPPOSITE[src.side];
    let r = src.absR, c = src.absC;
    let endX = src.x, endY = src.y;
    for (let i = 0; i < 128; i++) {
      const nr = r + src.dy, nc = c + src.dx;
      // Terminator on the incoming edge of (nr,nc)?
      const tKey = this._terminatorKeyAt(nr, nc, backSide);
      if (tKey) {
        const t = this._laserByKey.get(tKey);
        if (t) {
          const res = { endX: t.x, endY: t.y };
          if (this._isCollectorKey(tKey)) { res.terminator = 'collector'; res.hitCollectorKey = tKey; }
          else                            { res.terminator = 'emitter';   res.hitEmitterKey   = tKey; }
          return res;
        }
      }
      // Wall blocker (factory body cell / buffer cell) — stop at its near edge.
      const wall = this.walls.get(`${nr},${nc}`);
      if (wall) {
        const [ex, ey] = edgeMidpointAbs(nr, nc, backSide, pxCell, pxGap, wall.scale || 1);
        return { endX: ex, endY: ey, terminator: 'wall' };
      }
      // Advance; fall-through out-of-range guard.
      r = nr; c = nc;
      endX = src.x + src.dx * this.cellStep * (i + 1);
      endY = src.y + src.dy * this.cellStep * (i + 1);
      if (nr < -1 || nc < -1 || nr > 64 || nc > 64) break;
    }
    return { endX, endY, terminator: 'open' };
  }

  _isCollectorKey(key) {
    if (!this.collectors) return false;
    for (const c of this.collectors) if (c.key === key) return true;
    return false;
  }

  _terminatorKeyAt(r, c, side) {
    if (!side || !this._laserByKey) return null;
    // Border terminator?
    const bk = `border:${r},${c},${side}`;
    if (this._laserByKey.has(bk)) return bk;
    // Factory emitter terminator? Scan keys — factory emitters are few so
    // this is cheap; avoids building an additional reverse index.
    for (const [key, ent] of this._laserByKey) {
      if (ent.ownerId === 'border') continue;
      if (ent.absR === r && ent.absC === c && ent.side === side) return key;
    }
    return null;
  }

  _laserPops(s) {
    // Point-vs-segment distance from the shape's CURRENT position to each
    // live beam, up to its drawn length. Cheap + good enough; shapes move
    // slowly relative to the pxCell-wide beam width.
    if (!this.lasers || this.lasers.length === 0) return false;
    const popR = this.pxCell * 0.22;   // shape radius ~SHAPE_RADIUS_FRAC
    const popR2 = popR * popR;
    for (const b of this.lasers) {
      if ((b.power || 0) < 0.5) continue;   // only fully-grown beams are lethal
      const dx = b.x1 - b.x0, dy = b.y1 - b.y0;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const drawLen = len * b.power;
      const ux = dx / len, uy = dy / len;
      const rx = s.x - b.x0, ry = s.y - b.y0;
      const along = rx * ux + ry * uy;
      if (along < 0 || along > drawLen) continue;
      const perp = rx * uy - ry * ux;
      if (perp * perp < popR2) return true;
    }
    return false;
  }
}

