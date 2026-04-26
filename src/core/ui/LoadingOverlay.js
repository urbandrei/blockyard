import { FORMS, COLORS, COLOR_HEX } from '../model/shape.js';

// Full-viewport DOM canvas overlay that fills the screen with shapes
// raining down from the top, stacking via simple gravity + circle-based
// collision, holding briefly, then dropping out the bottom on `triggerExit`
// to reveal whatever Phaser scene is rendered behind it.
//
// Lives as a fixed-position <canvas> element on the document body — *not*
// inside the Phaser canvas — so the animation actually covers the full
// viewport (including the letterbox bars Phaser's FIT mode leaves around
// its 720×1580 logical canvas). Drives itself via requestAnimationFrame
// so its lifetime is independent of any Phaser scene's shutdown cycle.
//
// Usage:
//   const overlay = new LoadingOverlay();
//   overlay.start();
//   // ...later, when ready to dismiss:
//   overlay.triggerExit(() => { /* shapes have all fallen offscreen */ });

const EXIT_GRAVITY         = 3000;   // px/sec² — only applied during exit
const VEL_DRAG             = 0.985;  // per-frame velocity scale (both axes)
const WALL_RESTITUTION     = 0.7;    // moderate bounce keeps shapes mixing
const FLOOR_RESTITUTION    = 0.55;   // floor bounce while contained (fill phase)
const COLLISION_RESTITUTION = 0.5;   // shape↔shape elastic factor
const POSITION_SLOP        = 1.0;    // ignore tiny overlaps to avoid oscillation
const POSITION_BIAS        = 0.5;    // fraction of overlap corrected per pass
const FREEZE_SPEED         = 16;     // |vx|+|vy| below this counts as "still"
const FREEZE_HOLD_MS       = 250;    // must stay still for this long → frozen

const SPAWN_FAST_MS        = 8;      // initial rapid fill — ~125 shapes/sec
const SPAWN_SLOW_MS        = 65;     // overfill trickle while waiting on signal
const HOLD_MS              = 500;    // settle pause once filled
const MAX_FILL_MS          = 9000;   // safety: never spend more than this filling
const MAX_SHAPES           = 450;    // hard cap so collision cost stays bounded
const PACK_DENSITY         = 0.82;   // % of viewport area we aim to cover
const OVERFILL_MIN_MULT    = 1.18;   // always over-pack at least this far past target
const OVERFILL_MAX_MULT    = 1.55;   // never over-pack past this (caps slow trickle)
const PHYSICS_SUBSTEPS     = 2;
const PAIRWISE_PASSES      = 6;

const STROKE_HEX           = '#000000';
const STROKE_WIDTH         = 3;

export class LoadingOverlay {
  constructor() {
    this._canvas       = null;
    this._ctx          = null;
    this._dpr          = 1;
    this._shapes       = [];
    this._raf          = null;
    this._lastTimeMs   = 0;
    this._spawnAccumMs = 0;
    this._phase        = 'idle'; // 'fill' | 'hold' | 'exit' | 'done'
    this._phaseStart   = 0;
    this._floorActive  = true;
    this._gravityScale = 0;          // zero-G during fill; flipped to 1 on exit
    this._exitCb       = null;
    this._onFilled     = null;
    this._readySignaled = false;
    this._onResize     = null;
  }

  // Callback fires once when the overlay has finished filling AND held
  // briefly (so the screen visually packs before any external code can
  // dismiss it). Fires at most once per overlay instance.
  setOnFilled(cb) { this._onFilled = cb; }

  // External "you can wrap up" signal from the load owner. Until this
  // fires, the overlay slows its spawn rate after the initial fast fill
  // so the screen keeps gradually overfilling while we wait. After it
  // fires, the spawn rate snaps back to fast so the remaining overfill
  // finishes quickly and we exit.
  signalReady() { this._readySignaled = true; }

  start() {
    if (this._canvas) return;
    const c = document.createElement('canvas');
    c.id = 'blockyard-loading-overlay';
    c.style.position      = 'fixed';
    c.style.left          = '0';
    c.style.top           = '0';
    c.style.zIndex        = '10000';
    c.style.pointerEvents = 'none';
    c.style.background    = 'transparent';
    document.body.appendChild(c);
    this._canvas = c;
    this._ctx = c.getContext('2d');

    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    this._phase = 'fill';
    this._phaseStart = performance.now();
    this._lastTimeMs = performance.now();
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  triggerExit(onDone) {
    this._exitCb = onDone || null;
    if (this._phase === 'fill' || this._phase === 'hold' || this._phase === 'idle') {
      this._phase = 'exit';
      this._phaseStart = performance.now();
      this._floorActive = false;
      // Flip gravity ON. Up until this moment the container was
      // zero-G — shapes only redistributed via collisions and damping.
      // Now the entire cloud accelerates downward as a unit.
      this._gravityScale = 1;
    }
    // Release every frozen shape and give it a tiny random kick so the
    // whole cloud starts falling immediately instead of waiting one
    // frame for gravity to integrate.
    for (const s of this._shapes) {
      if (s.frozen) {
        s.frozen = false;
        s.stillMs = 0;
        s.vy = 30 + Math.random() * 60;
        s.vx = (Math.random() - 0.5) * 30;
        s.angVel = (Math.random() - 0.5) * 3;
      }
    }
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._raf = null;
    this._canvas = null;
    this._ctx = null;
    this._phase = 'done';
  }

  _resize() {
    if (!this._canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    this._canvas.width  = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width  = w + 'px';
    this._canvas.style.height = h + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _baseRadius() {
    const w = window.innerWidth;
    // Radius scales with viewport so the screen fills with a similar
    // visual density on phones and desktops. Stays small enough that the
    // pile reads as "many small shapes" rather than a few big tiles.
    return Math.max(16, Math.min(34, w / 26));
  }

  // Adaptive target shape count: viewport-area × PACK_DENSITY divided by
  // average shape area, capped at MAX_SHAPES so collision cost stays
  // bounded. Recomputed each frame so a window resize during fill
  // updates the target on the fly.
  _targetCount() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = this._baseRadius();
    const avgArea = Math.PI * r * r;
    const wanted = Math.ceil((w * h * PACK_DENSITY) / avgArea);
    return Math.min(MAX_SHAPES, wanted);
  }

  _spawnShape() {
    const w = window.innerWidth;
    const baseR = this._baseRadius();
    const r = baseR * (0.85 + Math.random() * 0.45);
    const form  = FORMS[Math.floor(Math.random() * FORMS.length)];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    this._shapes.push({
      x: r + Math.random() * (w - 2 * r),
      y: -r * 1.5,
      // Shot in with high downward velocity — there's no gravity during
      // fill, so this is what carries the shape into the container.
      // Sideways jitter spreads the spawn cone so the pile doesn't
      // collapse into a single column.
      vx: (Math.random() - 0.5) * 320,
      vy: 320 + Math.random() * 240,
      r,
      form,
      colorHex: '#' + (COLOR_HEX[color] || 0x3e8ed0).toString(16).padStart(6, '0'),
      rotation: Math.random() * Math.PI * 2,
      angVel: (Math.random() - 0.5) * 7,
      // Freezing state — once a shape has been still for FREEZE_HOLD_MS
      // it locks in place as an immovable obstacle so subsequent shapes
      // bounce off it cleanly. Released in triggerExit so the whole
      // cloud falls together.
      frozen: false,
      stillMs: 0,
    });
  }

  // True once at least one settled shape's top edge is within FILL_TOP_PX
  // of the viewport top — i.e. the pile has reached the top of the
  // screen. We deliberately ignore shapes still falling in from above
  // (top < 0) and shapes that haven't had time to lose vertical velocity,
  // so we don't trigger the moment a new shape spawns above the viewport.
  _isScreenFull() {
    if (this._shapes.length === 0) return false;
    let minTop = Infinity;
    for (const s of this._shapes) {
      const top = s.y - s.r;
      if (top < 0) continue;                  // still entering from above
      if (Math.abs(s.vy) > 80) continue;      // still falling fast — not settled
      if (top < minTop) minTop = top;
    }
    return minTop <= FILL_TOP_PX;
  }

  _stepPhysics(dt) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // 1. Integrate velocity + (conditional) gravity. During fill the
    //    overlay is zero-G — `_gravityScale = 0` — and shapes only have
    //    the velocity they were spawned with plus whatever they trade
    //    in collisions. On triggerExit `_gravityScale` flips to 1 and
    //    every shape starts accelerating downward. Drag on both axes
    //    bleeds energy off so chaotic-bouncing shapes eventually settle
    //    and pack densely instead of pinging around forever. Frozen
    //    shapes skip integration (locked in place).
    for (const s of this._shapes) {
      if (s.frozen) continue;
      s.vy += EXIT_GRAVITY * this._gravityScale * dt;
      s.vx *= VEL_DRAG;
      s.vy *= VEL_DRAG;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rotation += s.angVel * dt;
      s.angVel *= 0.995;
    }

    // 2. World bounds — walls always, floor only when active.
    for (const s of this._shapes) {
      if (s.frozen) continue;
      if (s.x - s.r < 0) {
        s.x = s.r;
        s.vx = -s.vx * WALL_RESTITUTION;
      } else if (s.x + s.r > w) {
        s.x = w - s.r;
        s.vx = -s.vx * WALL_RESTITUTION;
      }
      if (this._floorActive && s.y + s.r > h) {
        s.y = h - s.r;
        s.vy = -s.vy * FLOOR_RESTITUTION;
        s.vx *= 0.9;
        s.angVel *= 0.7;
      }
    }

    // 3. Pairwise collision resolution. Sort shapes bottom-up first so
    //    the floor constraint resolves before the shapes resting on top
    //    of it — avoids the upper layers oscillating because the lower
    //    layers haven't been pinned yet. This is the single biggest fix
    //    for jitter on thin/dense piles. Multiple passes per substep so
    //    stacked piles converge to rest quickly. Each pass: correct
    //    position (with slop to ignore microscopic overlaps), then
    //    exchange velocity along the contact normal — but only when the
    //    pair is actually approaching, so settled stacks don't get
    //    re-energized by their own resting contacts.
    const ss = this._shapes;
    ss.sort((a, b) => b.y - a.y);
    for (let pass = 0; pass < PAIRWISE_PASSES; pass++) {
      for (let i = 0; i < ss.length; i++) {
        for (let j = i + 1; j < ss.length; j++) {
          const a = ss[i];
          const b = ss[j];
          if (a.frozen && b.frozen) continue; // both immovable — nothing to do
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy;
          const minDist = a.r + b.r;
          if (distSq >= minDist * minDist) continue;
          const dist = distSq > 0.0001 ? Math.sqrt(distSq) : 0.001;
          const nx = dx / dist;
          const ny = dy / dist;
          // Position correction with Baumgarte-style slop + bias so we
          // don't overshoot tiny overlaps and start oscillating. When
          // one side is frozen, all of the correction is applied to the
          // active side (frozen = infinite mass).
          const overlap = minDist - dist;
          if (overlap > POSITION_SLOP) {
            const correct = (overlap - POSITION_SLOP) * POSITION_BIAS;
            if (a.frozen) {
              b.x += nx * correct;
              b.y += ny * correct;
            } else if (b.frozen) {
              a.x -= nx * correct;
              a.y -= ny * correct;
            } else {
              a.x -= nx * correct * 0.5;
              a.y -= ny * correct * 0.5;
              b.x += nx * correct * 0.5;
              b.y += ny * correct * 0.5;
            }
          }

          // Closing speed along the contact normal. Positive = pair is
          // approaching → apply impulse. Negative = already separating
          // (or at rest under gravity) → leave it alone so the stack
          // can settle.
          const va = a.frozen ? 0 : (a.vx * nx + a.vy * ny);
          const vb = b.frozen ? 0 : (b.vx * nx + b.vy * ny);
          const closing = va - vb;
          if (closing <= 0) continue;
          if (a.frozen) {
            // All impulse goes into b (a is immovable).
            const impulse = closing * (1 + COLLISION_RESTITUTION);
            b.vx += impulse * nx;
            b.vy += impulse * ny;
          } else if (b.frozen) {
            const impulse = closing * (1 + COLLISION_RESTITUTION);
            a.vx -= impulse * nx;
            a.vy -= impulse * ny;
          } else {
            const impulse = closing * (1 + COLLISION_RESTITUTION) * 0.5;
            a.vx -= impulse * nx;
            a.vy -= impulse * ny;
            b.vx += impulse * nx;
            b.vy += impulse * ny;
          }
        }
      }
    }

    // 4. Settle detection — any active shape that has stayed slow for
    //    FREEZE_HOLD_MS gets locked in place. Frozen shapes act as
    //    immovable obstacles, so subsequent shots-in collide cleanly
    //    against a static structure instead of pushing the whole
    //    cluster around. Skipped during the exit phase (when
    //    `_gravityScale === 1`) so a slow-moving shape mid-fall isn't
    //    accidentally pinned mid-air.
    if (this._gravityScale === 0) {
      const dtMs = dt * 1000;
      for (const s of this._shapes) {
        if (s.frozen) continue;
        const speed = Math.abs(s.vx) + Math.abs(s.vy);
        if (speed < FREEZE_SPEED) {
          s.stillMs += dtMs;
          if (s.stillMs >= FREEZE_HOLD_MS) {
            s.frozen = true;
            s.vx = 0;
            s.vy = 0;
            s.angVel = 0;
          }
        } else {
          s.stillMs = 0;
        }
      }
    }
  }

  _drawShape(ctx, r, form) {
    if (form === 'square') {
      const s = r * 1.7;
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    } else if (form === 'triangle') {
      const halfBase = r * 1.05;
      const h = r * 2;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.6);
      ctx.lineTo(-halfBase, h * 0.4);
      ctx.lineTo( halfBase, h * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  _tick(t) {
    if (!this._canvas || !this._ctx) return;
    const dt = Math.min(0.033, (t - this._lastTimeMs) / 1000);
    this._lastTimeMs = t;
    const phaseDt = t - this._phaseStart;

    // Spawning + phase transitions.
    //   • Spawn FAST (SPAWN_FAST_MS) while we're still filling to the
    //     baseline target — this is the initial visible rain-down.
    //   • Once past the baseline target, switch to SLOW (SPAWN_SLOW_MS)
    //     while we wait for the load owner to call signalReady(). The
    //     pile keeps growing slowly above the visible viewport — over-
    //     filling — so we always have a deep stack to drop on exit.
    //   • As soon as signalReady() fires, snap back to FAST so the
    //     remaining overfill finishes quickly and we exit.
    //   • Transition to 'hold' once we've reached at least the OVERFILL_MIN
    //     mark AND the load owner is ready, OR we hit the OVERFILL_MAX
    //     cap, OR the safety timeout fires.
    if (this._phase === 'fill') {
      const target = this._targetCount();
      const minCount = Math.min(MAX_SHAPES, Math.floor(target * OVERFILL_MIN_MULT));
      const maxCount = Math.min(MAX_SHAPES, Math.floor(target * OVERFILL_MAX_MULT));

      let spawnInterval;
      if (this._shapes.length < target) {
        spawnInterval = SPAWN_FAST_MS;       // initial rapid fill
      } else if (this._readySignaled) {
        spawnInterval = SPAWN_FAST_MS;       // ready — finish fast
      } else {
        spawnInterval = SPAWN_SLOW_MS;       // waiting — overfill slowly
      }

      if (this._shapes.length < maxCount) {
        this._spawnAccumMs += dt * 1000;
        while (this._spawnAccumMs >= spawnInterval && this._shapes.length < maxCount) {
          this._spawnAccumMs -= spawnInterval;
          this._spawnShape();
        }
      }

      const overfillReady = this._readySignaled && this._shapes.length >= minCount;
      const overfillCapped = this._shapes.length >= maxCount;
      const timedOut       = phaseDt >= MAX_FILL_MS;
      if (overfillReady || overfillCapped || timedOut) {
        this._phase = 'hold';
        this._phaseStart = t;
      }
    } else if (this._phase === 'hold') {
      if (phaseDt >= HOLD_MS && this._onFilled) {
        const cb = this._onFilled;
        this._onFilled = null;
        cb();
      }
    } else if (this._phase === 'exit') {
      const h = window.innerHeight;
      if (this._shapes.length > 0 && this._shapes.every((s) => s.y - s.r > h)) {
        // All shapes have left the viewport — overlay's job is done.
        const cb = this._exitCb;
        this._exitCb = null;
        this.destroy();
        if (cb) cb();
        return;
      }
    }

    // Sub-step physics for stable stacks.
    const sub = dt / PHYSICS_SUBSTEPS;
    for (let i = 0; i < PHYSICS_SUBSTEPS; i++) this._stepPhysics(sub);

    // Render.
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = STROKE_WIDTH;
    ctx.strokeStyle = STROKE_HEX;
    for (const s of this._shapes) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rotation);
      ctx.fillStyle = s.colorHex;
      this._drawShape(ctx, s.r, s.form);
      ctx.restore();
    }

    this._raf = requestAnimationFrame((t2) => this._tick(t2));
  }
}
