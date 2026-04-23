import { LASER_CORE, LASER_BRIGHT, LASER_GLOW, CYCLE_MS, outlineWidth } from '../constants.js';

// Draws live laser beams + each emitter's charge flourish at its tip.
//
// Beam (fires when emitter power >= 1):
//   1. Two flanking sine-wave lines — CONSTANT color + width, no pulse.
//   2. Straight central beam — THICK, pulsing between dark/light red.
//
// Charge flourish — drawn ONLY during the 0 → 1 power transition:
//   • Solid red core circle (grows + lightens as power climbs).
//   • A couple of concentric rings collapsing inward toward the core.
//   • A small handful of thick radial streaks converging on the core.
//
// Fire effect — triggered the instant power reaches 1:
//   • Expanding "shockwave" ring that grows outward from the tip and fades.
//   • A cone burst of red particles flying out along the beam direction.
// After the transition the tip is CLEAN (no idle animation); the beam is
// the only visual until the charge state flips off.

const WAVE_AMP_FRAC     = 0.08;
const WAVE_WAVELEN_FRAC = 0.95;
const SEGMENTS_PER_CELL = 8;
// Charge geometry. Drawn ONLY during the 0 → 1 transition — a slow,
// dramatic power-up flourish. Counts kept low + cycles long so each
// ring/streak is legible on its own.
const CHARGE_MIN_R      = 0.05;
const CHARGE_MAX_R      = 0.18;
const STREAK_OUTER_MUL  = 3.6;
const STREAK_INNER_MUL  = 1.15;
const STREAK_COUNT_MIN  = 2;
const STREAK_COUNT_MAX  = 4;
const RING_COUNT        = 2;
const RING_OUTER_MUL    = 4.8;
// Shockwave when the charge completes and the beam fires. Duration tracks
// CYCLE_MS so the dramatic animation lives inside one full shape-motion
// cycle (slow-to-slow).
const EXPLOSION_MS      = CYCLE_MS;
const EXPLOSION_START_R = 0.18;   // fraction of pxCell (matches CHARGE_MAX_R)
const EXPLOSION_END_R   = 0.55;   // fraction of pxCell

export class LaserRenderer {
  constructor(scene, container, { pxCell }) {
    this.scene = scene;
    this.container = container;
    this.pxCell = pxCell;
    // Back-to-front: waves (below) → core (above) → charge (on top).
    this.waveGfx   = scene.make.graphics({ add: false });
    this.coreGfx   = scene.make.graphics({ add: false });
    this.chargeGfx = scene.make.graphics({ add: false });
    this.container.add(this.waveGfx);
    this.container.add(this.coreGfx);
    this.container.add(this.chargeGfx);
  }

  resize(pxCell) { this.pxCell = pxCell; }

  destroy() {
    this.waveGfx   && this.waveGfx.destroy();
    this.coreGfx   && this.coreGfx.destroy();
    this.chargeGfx && this.chargeGfx.destroy();
    this.waveGfx = this.coreGfx = this.chargeGfx = null;
  }

  update(simTime, beams, emitters) {
    if (!this.waveGfx || !this.coreGfx || !this.chargeGfx) return;
    this.waveGfx.clear();
    this.coreGfx.clear();
    this.chargeGfx.clear();
    this._drawCharges(simTime, emitters);
    if (!beams || beams.length === 0) return;

    const t = (simTime % CYCLE_MS) / CYCLE_MS;
    const pulse = 0.75 + 0.25 * Math.sin(t * Math.PI * 2);
    // Core color alternates between a dark red and a lighter red — never
    // goes all the way to white.
    const coreMix  = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    const coreColor = lerpHex(LASER_CORE, LASER_BRIGHT, coreMix);
    const baseW = outlineWidth(this.pxCell);
    const coreW = Math.max(8, baseW * 3.2);
    const waveW = Math.max(2, baseW * 1.1);
    const amp      = this.pxCell * WAVE_AMP_FRAC;
    const wavelen  = Math.max(14, this.pxCell * WAVE_WAVELEN_FRAC);
    // Phase moves FORWARD along the beam (source → terminator) at two
    // speeds: a 1x flow and a 2x flow so the waves read as moving currents.
    // The sign on `phase` flips the traveling direction from back-toward-
    // source to forward-toward-terminator.
    const phase1x = -simTime / 180;
    const phase2x = -simTime / 90;

    for (const beam of beams) {
      const pwr = Math.max(0, Math.min(1, beam.power || 0));
      if (pwr <= 0.01) continue;
      const dx = beam.x1 - beam.x0;
      const dy = beam.y1 - beam.y0;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      // Beam is INSTANT — always full length when power is on. No grow
      // animation from source toward terminator.
      const drawLen = len;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const steps = Math.max(8, Math.ceil(drawLen / (this.pxCell / SEGMENTS_PER_CELL)));

      // Sparks at the impact point when the beam terminates on a wall.
      // Emitter/collector/open terminations don't spawn sparks.
      if (beam.hitType === 'wall') {
        this._spawnWallSparks(simTime, beam.x1, beam.y1, -ux, -uy);
      }

      // Two flanking sine waves at DIFFERENT speeds (1x / 2x), constant
      // LASER_GLOW color + constant width — no pulse.
      this._drawWave(this.waveGfx, LASER_GLOW, waveW, 0.85 * pwr,
        beam.x0, beam.y0, ux, uy, nx, ny, drawLen, steps, amp, wavelen, phase1x);
      this._drawWave(this.waveGfx, LASER_GLOW, waveW, 0.85 * pwr,
        beam.x0, beam.y0, ux, uy, nx, ny, drawLen, steps, amp, wavelen * 0.7, phase2x + Math.PI);

      // Thick straight core — PULSES color + width.
      this.coreGfx.lineStyle(coreW * pulse, coreColor, Math.min(1, pwr));
      this.coreGfx.beginPath();
      this.coreGfx.moveTo(beam.x0, beam.y0);
      this.coreGfx.lineTo(beam.x0 + ux * drawLen, beam.y0 + uy * drawLen);
      this.coreGfx.strokePath();
    }
  }

  _drawCharges(simTime, emitters) {
    if (!emitters || emitters.length === 0) return;
    const gfx = this.chargeGfx;

    // One-time state for detecting fire transitions and driving the
    // post-fire shockwave + particle burst.
    if (!this._lastFiring) this._lastFiring = new Map();
    if (!this._explosions) this._explosions = new Map();
    if (!this._particles)  this._particles  = [];

    // Fire animation triggers on the `firing` latch going false → true.
    // Because `firing` is sticky (only clears when the emitter fully
    // drains to power 0), brief trigger flickers don't retrigger it and
    // re-firing an already-firing emitter is a no-op.
    for (const e of emitters) {
      const wasFiring = !!this._lastFiring.get(e.key);
      const isFiring  = !!e.firing;
      if (!wasFiring && isFiring) {
        this._explosions.set(e.key, {
          startTime: simTime, tipX: e.tipX, tipY: e.tipY,
        });
        this._spawnParticleBurst(simTime, e);
      }
      this._lastFiring.set(e.key, isFiring);
    }

    // 1. Shockwave rings (outward expand, fade out).
    for (const [key, exp] of this._explosions) {
      const elapsed = simTime - exp.startTime;
      // If simTime went backwards (sim reset), drop the explosion.
      if (elapsed < 0 || elapsed > EXPLOSION_MS) {
        this._explosions.delete(key);
        continue;
      }
      const t    = elapsed / EXPLOSION_MS;
      const ease = 1 - Math.pow(1 - t, 2.5);   // ease-out
      const r    = this.pxCell * (EXPLOSION_START_R + ease * (EXPLOSION_END_R - EXPLOSION_START_R));
      const w    = Math.max(2, this.pxCell * 0.055 * (1 - t * 0.7));
      const alpha = (1 - t) * 0.95;
      gfx.lineStyle(w, LASER_BRIGHT, alpha);
      gfx.strokeCircle(exp.tipX, exp.tipY, r);
    }

    // 2. Cone particles (red dots flying out from the tip).
    const parts = this._particles;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const age = simTime - p.birthTime;
      if (age < 0 || age > p.lifetime) { parts.splice(i, 1); continue; }
      const px = p.x + p.vx * age;
      const py = p.y + p.vy * age;
      const tNorm = age / p.lifetime;
      const alpha = 1 - tNorm;
      gfx.fillStyle(p.color, alpha);
      gfx.fillCircle(px, py, p.size * (1 - tNorm * 0.35));
    }

    // 3. Charge flourish — drawn ONLY while powering up (power climbing,
    //    beam not yet latched). If the emitter is already `firing` (or
    //    about to re-firing after a brief drop), skip it entirely.
    for (const e of emitters) {
      const pwr = e.power || 0;
      if (e.firing || pwr <= 0.02 || pwr >= 0.999) continue;

      const r = this.pxCell * (CHARGE_MIN_R + (CHARGE_MAX_R - CHARGE_MIN_R) * pwr);
      const coreColor = lerpHex(LASER_CORE, LASER_BRIGHT, pwr);
      const basePulse = 0.75 + 0.20 * Math.sin(simTime / 140);
      gfx.fillStyle(coreColor, basePulse);
      gfx.fillCircle(e.tipX, e.tipY, r);

      // Concentric rings collapsing inward — slow + dramatic. Cycle scales
      // with CYCLE_MS so the rhythm matches the shape-motion pulse.
      const ringOuterR = r * RING_OUTER_MUL;
      const ringCycleMs = (2.0 - 0.6 * pwr) * CYCLE_MS;
      const ringW = Math.max(2, this.pxCell * 0.030);
      for (let i = 0; i < RING_COUNT; i++) {
        const phase = ((simTime / ringCycleMs) + i / RING_COUNT) % 1;
        const ringR = ringOuterR - phase * (ringOuterR - r * 1.05);
        const alpha = 0.15 + phase * 0.8;
        gfx.lineStyle(ringW, coreColor, alpha);
        gfx.strokeCircle(e.tipX, e.tipY, ringR);
      }

      // Thick radial intake streaks — fewer, slower.
      const count = Math.round(STREAK_COUNT_MIN + (STREAK_COUNT_MAX - STREAK_COUNT_MIN) * pwr);
      const outerR = r * STREAK_OUTER_MUL;
      const innerR = r * STREAK_INNER_MUL;
      const cycleMs = (2.4 - 0.8 * pwr) * CYCLE_MS;
      const streakW = Math.max(3, this.pxCell * 0.050);
      gfx.lineStyle(streakW, lerpHex(0xff3030, 0xff8080, pwr), 0.7 + 0.25 * pwr);
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + simTime * 0.00008;
        const phase = ((simTime / cycleMs) + i * 0.27) % 1;
        const r1 = outerR - phase * (outerR - innerR);
        const tailLen = this.pxCell * 0.17 * (1 - phase * 0.55);
        const r2 = r1 + tailLen;
        const x1 = e.tipX + Math.cos(angle) * r1;
        const y1 = e.tipY + Math.sin(angle) * r1;
        const x2 = e.tipX + Math.cos(angle) * r2;
        const y2 = e.tipY + Math.sin(angle) * r2;
        gfx.beginPath();
        gfx.moveTo(x1, y1);
        gfx.lineTo(x2, y2);
        gfx.strokePath();
      }
    }
  }

  _spawnWallSparks(simTime, x, y, backDirX, backDirY) {
    // Continuous spark stream where a beam terminates on a wall. Rate-
    // limited, kept small + slow so it reads as tiny embers scattering,
    // not a particle explosion.
    if (!this._particles) this._particles = [];
    if (!this._wallSparkLast) this._wallSparkLast = new Map();
    const sparkKey = `${Math.round(x)},${Math.round(y)}`;
    const last = this._wallSparkLast.get(sparkKey) || 0;
    if (simTime - last < 90) return;   // ~11 spawns/sec per impact
    this._wallSparkLast.set(sparkKey, simTime);

    const baseAngle = Math.atan2(backDirY, backDirX);
    const count = 1 + Math.floor(Math.random() * 2);   // 1–2 sparks / spawn
    const pxCell = this.pxCell;
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() * 2 - 1) * 1.25;
      const ang    = baseAngle + spread;
      const speed  = (0.04 + Math.random() * 0.07) * (pxCell / 40);
      const life   = 220 + Math.random() * 220;
      const size   = pxCell * (0.012 + Math.random() * 0.014);
      const tint   = Math.random() < 0.35 ? LASER_BRIGHT : 0xff5050;
      this._particles.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        birthTime: simTime,
        lifetime: life,
        size,
        color: tint,
      });
    }
  }

  _spawnParticleBurst(simTime, emitter) {
    // Small cone of red dots fired out along the emitter's outward
    // direction. Fewer + smaller + slower than before so the burst feels
    // like a deliberate ember spray — not a splash.
    const count = 8;
    const baseAngle = Math.atan2(emitter.dy, emitter.dx);
    const halfCone  = 0.5;   // radians ≈ 29°
    const pxCell = this.pxCell;
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() * 2 - 1) * halfCone;
      const ang    = baseAngle + spread;
      const speed  = (0.035 + Math.random() * 0.055) * (pxCell / 40);
      const life   = CYCLE_MS * (0.75 + Math.random() * 0.45);
      const size   = pxCell * (0.018 + Math.random() * 0.018);
      const tint   = Math.random() < 0.35 ? LASER_BRIGHT : 0xff5050;
      this._particles.push({
        x: emitter.tipX,
        y: emitter.tipY,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        birthTime: simTime,
        lifetime: life,
        size,
        color: tint,
      });
    }
  }

  _drawWave(gfx, color, widthPx, alpha, x0, y0, ux, uy, nx, ny, drawLen, steps, amp, wavelen, phase0) {
    gfx.lineStyle(widthPx, color, alpha);
    gfx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * drawLen;
      const a = phase0 + (s / wavelen) * Math.PI * 2;
      // Taper amplitude to 0 at both ends so the wave cleanly meets the
      // source + terminator.
      const edge = Math.min(s, drawLen - s);
      const taper = Math.max(0, Math.min(1, edge / (wavelen * 0.5)));
      const w = Math.sin(a) * amp * taper;
      const x = x0 + ux * s + nx * w;
      const y = y0 + uy * s + ny * w;
      if (i === 0) gfx.moveTo(x, y);
      else         gfx.lineTo(x, y);
    }
    gfx.strokePath();
  }
}

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
