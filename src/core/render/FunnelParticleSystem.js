// Ambient particle effect for funnels. Periodically spawns tiny shape-form
// dots (circle / square / triangle) colored by each funnel's typed label:
//
//   • role=input  → particles drift in from the outward side and fade out
//     as they reach the funnel (drawn INTO the funnel).
//   • role=output → particles emerge at the funnel and fade out as they
//     fly outward.
//
// Typing rules (per funnel):
//   • { form, color }  → all particles use that form+color.
//   • { form }         → form fixed, color randomized per particle.
//   • { color }        → color fixed, form randomized per particle.
//   • null / missing   → both randomized per particle.
//
// Each particle's curve has a scattered start/end point offset perpendicular
// to the funnel axis, with the control point positioned on the funnel's
// outward ray so the path's tangent AT the funnel is aligned with the
// outward normal — particles enter/leave perpendicular to the funnel face.
//
// Rendering is a single Graphics (one clear + many fills per frame). Place
// the system's container at a depth BELOW the funnel triangles so the
// particles read as drifting behind the funnel.

import { FORMS, COLORS, COLOR_HEX } from '../model/shape.js';

const DEFAULT_SPAWN_RATE_MS = 440;   // ~2-3 active particles per funnel
const DEFAULT_LIFE_MS        = 1100;
const PEAK_ALPHA             = 0.7;
// Windlines — thin streaks aligned with the funnel axis, sliding inward
// (input) or outward (output) over their life. Slower cadence than the
// particles so they read as a sparse atmospheric layer rather than a
// parallel stream.
const WIND_SPAWN_RATE_MS     = 900;
const WIND_LIFE_MS           = 1000;
const WIND_PEAK_ALPHA        = 0.28;
const WIND_COLOR             = 0xffffff;
const WIND_SEGMENTS          = 8;      // sample count along the streak (more → smoother taper)
const WIND_SPAN_T            = 0.32;   // streak length as a fraction of the bezier (0..1)

export class FunnelParticleSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {Phaser.GameObjects.Container} container
   * @param {object} opts
   * @param {number} opts.pxCell
   * @param {number} [opts.spawnRateMs]
   * @param {number} [opts.lifeMs]
   * @param {number} [opts.travelFactor]  travel distance as multiple of pxCell (default 0.9)
   */
  constructor(scene, container, opts = {}) {
    this.scene = scene;
    this.pxCell = opts.pxCell;
    this.spawnRateMs = opts.spawnRateMs || DEFAULT_SPAWN_RATE_MS;
    this.lifeMs = opts.lifeMs || DEFAULT_LIFE_MS;
    this.travel = (opts.travelFactor || 0.55) * this.pxCell;
    this.radius = Math.max(3.5, this.pxCell * 0.11);
    this.gfx = scene.make.graphics({ add: false });
    container.add(this.gfx);
    this.funnels = [];
    this.particles = [];
    this.winds = [];
    this._seeded = false;
  }

  /** Set or replace the tracked funnel list. Accepts an array of
   *  `{ x, y, dx, dy, role, type? }` where type is `{ form?, color? }` or
   *  null/undefined for a fully-random particle. */
  setFunnels(funnels) {
    this.funnels = (funnels || []).map((f) => ({
      x: f.x, y: f.y, dx: f.dx, dy: f.dy, role: f.role, type: f.type || null,
      _nextSpawn: 0,
      _nextWindSpawn: 0,
    }));
    this._seeded = false;
  }

  update(time) {
    // Stagger initial spawn times so all funnels aren't in phase on the
    // first tick after setFunnels().
    if (!this._seeded) {
      for (const f of this.funnels) {
        f._nextSpawn = time + Math.random() * this.spawnRateMs;
        f._nextWindSpawn = time + Math.random() * WIND_SPAWN_RATE_MS;
      }
      this._seeded = true;
    }

    for (const f of this.funnels) {
      while (time >= f._nextSpawn) {
        this._spawnParticle(f, f._nextSpawn);
        f._nextSpawn += this.spawnRateMs * (0.7 + Math.random() * 0.6);
      }
      while (time >= f._nextWindSpawn) {
        this._spawnWindline(f, f._nextWindSpawn);
        f._nextWindSpawn += WIND_SPAWN_RATE_MS * (0.7 + Math.random() * 0.6);
      }
    }

    this.gfx.clear();
    // Windlines first so particles render on top of them (the dots are the
    // focal element; wind is the atmospheric layer).
    this._drawWindlines(time);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const age = time - p.birthTime;
      if (age >= p.life) { this.particles.splice(i, 1); continue; }
      const t = age / p.life;
      const u = 1 - t;
      const x = u * u * p.p0x + 2 * u * t * p.p1x + t * t * p.p2x;
      const y = u * u * p.p0y + 2 * u * t * p.p1y + t * t * p.p2y;
      let alpha;
      if (t < 0.25)      alpha = t / 0.25;
      else if (t > 0.75) alpha = (1 - t) / 0.25;
      else               alpha = 1;
      const colorHex = COLOR_HEX[p.color] != null ? COLOR_HEX[p.color] : 0xffffff;
      this.gfx.fillStyle(colorHex, alpha * PEAK_ALPHA);
      drawMiniForm(this.gfx, x, y, this.radius, p.form);
    }
  }

  _spawnParticle(f, birthTime) {
    // Resolve typing → concrete (form, color). Partial labels randomize
    // only the missing axis so e.g. a shape-only funnel emits multi-color
    // particles all of the same form.
    const typeForm  = f.type && f.type.form  ? f.type.form  : null;
    const typeColor = f.type && f.type.color ? f.type.color : null;
    const form  = typeForm  || FORMS[Math.floor(Math.random() * FORMS.length)];
    const color = typeColor || COLORS[Math.floor(Math.random() * COLORS.length)];
    // Perpendicular scatter axis (unit vector 90° from outward).
    const px = -f.dy, py = f.dx;
    const scatter = (Math.random() - 0.5) * this.pxCell * 0.28;
    const travel = this.travel * (0.8 + Math.random() * 0.4);
    const midDist = travel * 0.5;
    const p1x = f.x + f.dx * midDist;
    const p1y = f.y + f.dy * midDist;
    const farX = f.x + f.dx * travel + px * scatter;
    const farY = f.y + f.dy * travel + py * scatter;
    let p0x, p0y, p2x, p2y;
    if (f.role === 'output') {
      p0x = f.x;  p0y = f.y;
      p2x = farX; p2y = farY;
    } else {
      p0x = farX; p0y = farY;
      p2x = f.x;  p2y = f.y;
    }
    this.particles.push({
      p0x, p0y, p1x, p1y, p2x, p2y,
      form, color,
      birthTime,
      life: this.lifeMs * (0.8 + Math.random() * 0.4),
    });
  }

  _spawnWindline(f, birthTime) {
    // Build a quadratic bezier that matches the particle path shape: the
    // control point P1 sits on the funnel's outward ray so the path's
    // tangent at the funnel end is aligned with the funnel normal. P0 / P2
    // are swapped by role so the streak flows INTO a sink (input-role at
    // factory funnel / output-role at border funnel) or OUT of a source.
    const px = -f.dy, py = f.dx;
    const scatter = (Math.random() - 0.5) * this.pxCell * 0.22;
    const travel = this.travel * (0.85 + Math.random() * 0.3);
    const midDist = travel * 0.5;
    const p1x = f.x + f.dx * midDist;
    const p1y = f.y + f.dy * midDist;
    const farX = f.x + f.dx * travel + px * scatter;
    const farY = f.y + f.dy * travel + py * scatter;
    let p0x, p0y, p2x, p2y;
    if (f.role === 'output') {
      p0x = f.x;  p0y = f.y;
      p2x = farX; p2y = farY;
    } else {
      p0x = farX; p0y = farY;
      p2x = f.x;  p2y = f.y;
    }
    this.winds.push({
      p0x, p0y, p1x, p1y, p2x, p2y,
      birthTime,
      life: WIND_LIFE_MS * (0.8 + Math.random() * 0.4),
    });
  }

  _drawWindlines(time) {
    // Thin, transparent stroke. Each streak is drawn as a short polyline
    // along a segment of the bezier path, with triangular alpha fade to
    // taper both ends of the streak. Streak slides from head near P0 to
    // head near P2 over its life, so the curve reads as "flowing into" an
    // input (P2 = funnel) or "flowing out of" an output (P0 = funnel).
    const strokeW = Math.max(1, Math.round(this.pxCell * 0.025));
    const span = WIND_SPAN_T;
    const half = span * 0.5;
    for (let i = this.winds.length - 1; i >= 0; i--) {
      const w = this.winds[i];
      const age = time - w.birthTime;
      if (age >= w.life) { this.winds.splice(i, 1); continue; }
      const t = age / w.life;
      let globalAlpha;
      if (t < 0.25)      globalAlpha = t / 0.25;
      else if (t > 0.75) globalAlpha = (1 - t) / 0.25;
      else               globalAlpha = 1;
      // Streak midpoint on the bezier advances from half..(1-half) so the
      // full streak always sits inside the curve.
      const midT = half + (1 - span) * t;
      const tailT = midT - half;
      const headT = midT + half;
      // Walk the bezier from tail to head in small steps, drawing each
      // segment with its own alpha for the taper effect.
      let prevX = null, prevY = null;
      for (let s = 0; s <= WIND_SEGMENTS; s++) {
        const u = s / WIND_SEGMENTS;                   // 0..1 along streak
        const bt = tailT + (headT - tailT) * u;
        const bu = 1 - bt;
        const x = bu * bu * w.p0x + 2 * bu * bt * w.p1x + bt * bt * w.p2x;
        const y = bu * bu * w.p0y + 2 * bu * bt * w.p1y + bt * bt * w.p2y;
        if (prevX != null) {
          // Triangular taper: alpha peaks at u=0.5, falls to ~0 at ends.
          const segU = (s - 0.5) / WIND_SEGMENTS;
          const taper = 1 - Math.abs(2 * segU - 1);
          const a = globalAlpha * WIND_PEAK_ALPHA * taper;
          if (a > 0.01) {
            this.gfx.lineStyle(strokeW, WIND_COLOR, a);
            this.gfx.beginPath();
            this.gfx.moveTo(prevX, prevY);
            this.gfx.lineTo(x, y);
            this.gfx.strokePath();
          }
        }
        prevX = x; prevY = y;
      }
    }
  }

  resize(pxCell) {
    this.pxCell = pxCell;
    this.travel = 0.55 * pxCell;
    this.radius = Math.max(3.5, pxCell * 0.11);
  }

  destroy() {
    if (this.gfx) { this.gfx.destroy(); this.gfx = null; }
    this.particles = [];
    this.winds = [];
    this.funnels = [];
  }
}

// Mini shape primitive. Matches the in-game shape forms at a small size so
// particles read as tiny versions of the real shapes.
function drawMiniForm(gfx, cx, cy, r, form) {
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(cx - s / 2, cy - s / 2, s, s);
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
      return;
    }
    case 'circle':
    default:
      gfx.fillCircle(cx, cy, r);
  }
}

// ---------- Funnel collection helpers ----------

// Build { factory, border } arrays of { x, y, dx, dy, role, type } for a
// live board level. `type` is resolved per-funnel: factory funnels take
// their cell's label; border funnels match against level.inputs/outputs.
// Missing labels → type=null → random-type particles.
export function collectFunnelsForParticles(level, pxCell, pxGap, scale) {
  const factory = [];
  const border  = [];

  for (const fac of (level.factories || [])) {
    const cellLabelAt = (r, c) => {
      const cell = (fac.cells || []).find((cc) => cc.r === r && cc.c === c);
      return cell && cell.label ? cell.label : null;
    };
    for (const f of (fac.funnels || [])) {
      const absR = fac.anchor.row + f.r;
      const absC = fac.anchor.col + f.c;
      const obj = buildFunnelPoint(absR, absC, f.side, f.role, cellLabelAt(f.r, f.c), pxCell, pxGap, scale);
      if (obj) factory.push(obj);
    }
  }

  const inputMap  = indexBorderTypes(level.inputs);
  const outputMap = indexBorderTypes(level.outputs);
  for (const f of ((level.border && level.border.funnels) || [])) {
    const key = `${f.r},${f.c},${f.side}`;
    const type = f.role === 'output' ? outputMap.get(key) : inputMap.get(key);
    // Border funnels invert sink/source relative to the sim — a border
    // role=input is actually a SOURCE (spawns shapes into the play area)
    // and a border role=output is a SINK. Particle direction follows sim
    // direction, so swap the role we feed the particle system.
    const particleRole = f.role === 'input' ? 'output' : 'input';
    const obj = buildFunnelPoint(f.r, f.c, f.side, particleRole, type || null, pxCell, pxGap, scale);
    if (obj) border.push(obj);
  }
  return { factory, border };
}

// Build a funnel-particle list for a factory-like shape drawn in isolation
// (ghost during drag, draft composer, blueprint slot preview, home decor).
// `cells` + `funnels` use the target render's local coord system (already
// offset if the caller wants absolute coords). No border concept.
export function collectFactoryFunnelsForParticles(cells, funnels, pxCell, pxGap, scale) {
  const out = [];
  const cellLabelAt = (r, c) => {
    const cell = (cells || []).find((cc) => cc.r === r && cc.c === c);
    return cell && cell.label ? cell.label : null;
  };
  for (const f of (funnels || [])) {
    const obj = buildFunnelPoint(f.r, f.c, f.side, f.role, cellLabelAt(f.r, f.c), pxCell, pxGap, scale);
    if (obj) out.push(obj);
  }
  return out;
}

function indexBorderTypes(arr) {
  const map = new Map();
  for (const e of (arr || [])) {
    if (!e || !e.type) continue;
    map.set(`${e.r},${e.c},${e.side}`, e.type);
  }
  return map;
}

function buildFunnelPoint(r, c, side, role, type, pxCell, pxGap, scale) {
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const x0 = c * step + m, y0 = r * step + m;
  const cx = x0 + inner / 2, cy = y0 + inner / 2;
  switch (side) {
    case 'top':    return { x: cx,         y: y0,         dx:  0, dy: -1, role, type };
    case 'bottom': return { x: cx,         y: y0 + inner, dx:  0, dy:  1, role, type };
    case 'left':   return { x: x0,         y: cy,         dx: -1, dy:  0, role, type };
    case 'right':  return { x: x0 + inner, y: cy,         dx:  1, dy:  0, role, type };
    default:       return null;
  }
}
