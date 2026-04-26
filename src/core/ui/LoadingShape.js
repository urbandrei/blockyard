import Phaser from 'phaser';
import { drawShapeForm } from '../render/ShapeRenderer.js';
import { FORMS, COLORS, COLOR_HEX } from '../model/shape.js';

// A small spinner widget: a single shape that alternates between SLOW
// continuous rotation and a quick FAST burst. At each transition into a
// fast burst the shape's form + color are randomized, so the spinner
// reads as cycling through every shape/color combination as it spins.
//
// Usage:
//   const loader = new LoadingShape(scene, container, { x, y, size: 48 });
//   // ...later, when done loading...
//   loader.destroy();

const SLOW_DEG_PER_SEC = 90;     // ~4s per full rotation
const FAST_DEG_PER_SEC = 1080;   // ~0.33s per full rotation
const SLOW_PHASE_MS    = 700;
const FAST_PHASE_MS    = 350;

// Scale grows as the spin accelerates and shrinks as it slows, so the
// spinner reads as "winding up + powering down" instead of a flat
// rotation. Smoothed each frame toward the phase's target — exponential-
// style lerp so the transition is perceptually smooth without a tween.
const SCALE_SLOW   = 0.85;
const SCALE_FAST   = 1.35;
const SCALE_SMOOTH = 9;

export class LoadingShape {
  constructor(scene, container, { x = 0, y = 0, size = 48 } = {}) {
    this.scene = scene;
    this._dead = false;
    this._radius = Math.max(8, Math.round(size / 2));
    this._strokeW = Math.max(2, Math.round(size * 0.06));
    this._gfx = scene.make.graphics({ add: false });
    this._gfx.x = x;
    this._gfx.y = y;
    this._gfx.setDepth(20);
    if (container && typeof container.add === 'function') container.add(this._gfx);
    else scene.add.existing(this._gfx);

    this._form  = 'circle';
    this._color = 'blue';
    this._scale = SCALE_SLOW;
    this._gfx.setScale(this._scale);
    this._redraw();

    // The phase loop is driven by a single repeating timer that flips the
    // current rotation rate and triggers a form/color shuffle on each
    // entry into a fast phase.
    this._phase = 'slow';
    this._lastTickMs = scene.time.now;
    this._sinceMs = 0;
    this._update = (time, delta) => this._tick(time, delta);
    scene.events.on(Phaser.Scenes.Events.UPDATE, this._update);
    this._shutdownHandler = () => this.destroy();
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this._shutdownHandler);
  }

  _tick(time, delta) {
    if (this._dead || !this._gfx || !this._gfx.scene) return;
    this._sinceMs += delta;
    const phaseDur = this._phase === 'slow' ? SLOW_PHASE_MS : FAST_PHASE_MS;
    if (this._sinceMs >= phaseDur) {
      this._sinceMs = 0;
      // Flip phase. Entering a fast burst is the moment the spinner
      // reshuffles its identity — a new form + color combination so each
      // burst reads as a discrete "tick" of progress.
      if (this._phase === 'slow') {
        this._phase = 'fast';
        this._shuffleShape();
      } else {
        this._phase = 'slow';
      }
    }
    const sec = delta / 1000;
    const degPerSec = this._phase === 'slow' ? SLOW_DEG_PER_SEC : FAST_DEG_PER_SEC;
    this._gfx.rotation += Phaser.Math.DegToRad(degPerSec) * sec;

    // Smooth scale toward the phase's target. The smoothing factor is
    // clamped to 1 so a long-frame pause (tab switch) doesn't overshoot.
    const targetScale = this._phase === 'fast' ? SCALE_FAST : SCALE_SLOW;
    const k = Math.min(1, sec * SCALE_SMOOTH);
    this._scale += (targetScale - this._scale) * k;
    this._gfx.setScale(this._scale);
  }

  _shuffleShape() {
    // Avoid repeating the same form+color combination two bursts in a row
    // — keeps the spinner visibly "moving" through the palette.
    let nextForm  = this._form;
    let nextColor = this._color;
    while (nextForm === this._form && nextColor === this._color) {
      nextForm  = FORMS[Math.floor(Math.random() * FORMS.length)];
      nextColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    }
    this._form = nextForm;
    this._color = nextColor;
    this._redraw();
  }

  _redraw() {
    if (!this._gfx) return;
    const fill = COLOR_HEX[this._color] || COLOR_HEX.blue;
    this._gfx.clear();
    this._gfx.fillStyle(fill, 1);
    this._gfx.lineStyle(this._strokeW, 0x000000, 1);
    drawShapeForm(this._gfx, this._radius, this._form);
  }

  setPosition(x, y) {
    if (this._gfx) { this._gfx.x = x; this._gfx.y = y; }
  }

  destroy() {
    if (this._dead) return;
    this._dead = true;
    if (this.scene && this.scene.events) {
      this.scene.events.off(Phaser.Scenes.Events.UPDATE, this._update);
      if (this._shutdownHandler) this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this._shutdownHandler);
    }
    if (this._gfx) { try { this._gfx.destroy(); } catch (e) {} this._gfx = null; }
  }
}
