import { COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_RADIUS_FRAC, outlineWidth } from '../constants.js';

// Electrocute-death palette — the shape flashes deep red with a darker
// outline, overlaid with a flickering electric pattern, then shatters.
const ELEC_FILL    = 0xb80000;
const ELEC_STROKE  = 0x2e0000;
const ELEC_ARC     = 0xfff0a0;   // light yellow electric current
const DEBRIS_FILL  = 0xd02020;
const DEBRIS_STROKE = 0x5a0000;

// Manages the visual for a simulation shape. Dispatches on `shape.form`
// (circle / square / triangle) and fills with `COLOR_HEX[shape.color]`.
// Each form is sized to roughly the same visual footprint (radius =
// `pxCell * SHAPE_RADIUS_FRAC`) so the buffer-label icon and the live
// shape read as the same object.

export class ShapeRenderer {
  constructor(scene, container, { pxCell }) {
    this.scene = scene;
    this.container = container;
    this.radius = Math.max(8, Math.round(pxCell * SHAPE_RADIUS_FRAC));
    this.strokeW = outlineWidth(pxCell);
    this.handles = new Map(); // shape.id → Graphics
  }

  spawn(shape) {
    const gfx = this.scene.make.graphics({ add: false });
    const color = COLOR_HEX[shape.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color];
    const form  = shape.form || DEFAULT_SHAPE_TYPE.form;
    gfx.fillStyle(color, 1);
    gfx.lineStyle(this.strokeW, 0x000000, 1);
    drawShapeForm(gfx, this.radius, form);
    gfx.x = shape.x;
    gfx.y = shape.y;
    gfx.setScale(0);
    gfx._tintHex = color;
    this.container.add(gfx);
    this.handles.set(shape.id, gfx);
  }

  // scaleX / scaleY can differ so callers can drive the motion-warp
  // (stretch along direction of motion during fast phases).
  update(shape, scaleX, scaleY) {
    const gfx = this.handles.get(shape.id);
    if (!gfx) return;
    gfx.x = shape.x;
    gfx.y = shape.y;

    // Electrocuted = mid-death: frozen in place, deep red + electric arcs
    // that flicker each frame. Shape SHRINKS as the death progresses so
    // the shatter feels like the shape imploding before breaking apart.
    if (shape.electrocuted) {
      const p = shape.electrocuteProgress || 0;
      const shrink = 1 - p * 0.65;   // 1.0 → 0.35 across the freeze
      gfx.scaleX = shrink;
      gfx.scaleY = shrink;
      this._drawElectrocuted(gfx, shape);
      return;
    }

    if (scaleY == null) scaleY = scaleX;
    gfx.scaleX = scaleX;
    gfx.scaleY = scaleY;

    // Acid-pit retint: while a transition is in flight, lerp the fill
    // color between the from/target hex values and redraw the shape.
    const targetName = shape._acidTargetName;
    const progress = shape._acidProgress || 0;
    let desiredHex;
    if (targetName && progress > 0 && progress < 1) {
      const fromHex = (shape._acidFromHex != null)
        ? shape._acidFromHex
        : (COLOR_HEX[shape.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color]);
      const toHex   = COLOR_HEX[targetName] || fromHex;
      desiredHex = lerpHex(fromHex, toHex, progress);
    } else {
      desiredHex = COLOR_HEX[shape.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color];
    }
    if (desiredHex !== gfx._tintHex) {
      const form = shape.form || DEFAULT_SHAPE_TYPE.form;
      gfx.clear();
      gfx.fillStyle(desiredHex, 1);
      gfx.lineStyle(this.strokeW, 0x000000, 1);
      drawShapeForm(gfx, this.radius, form);
      gfx._tintHex = desiredHex;
    }
  }

  _drawElectrocuted(gfx, shape) {
    const form = shape.form || DEFAULT_SHAPE_TYPE.form;
    const r = this.radius;
    gfx.clear();
    // Deep red body with a darker red border (chunkier than normal).
    gfx.fillStyle(ELEC_FILL, 1);
    gfx.lineStyle(this.strokeW + 2, ELEC_STROKE, 1);
    drawShapeForm(gfx, r, form);

    // Electric arcs ACROSS the interior — two jagged lines chord the shape,
    // re-rolled each frame so they read as live current.
    const arcW = Math.max(1.5, this.strokeW * 0.55);
    gfx.lineStyle(arcW, ELEC_ARC, 0.95);
    for (let k = 0; k < 2; k++) {
      const a0 = Math.random() * Math.PI * 2;
      const a1 = a0 + Math.PI + (Math.random() - 0.5) * 1.3;
      const x0 = Math.cos(a0) * r * 0.95;
      const y0 = Math.sin(a0) * r * 0.95;
      const x1 = Math.cos(a1) * r * 0.95;
      const y1 = Math.sin(a1) * r * 0.95;
      const steps = 5;
      gfx.beginPath();
      gfx.moveTo(x0, y0);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const lx = x0 + (x1 - x0) * t;
        const ly = y0 + (y1 - y0) * t;
        // Perpendicular jitter for the jagged lightning look.
        const perpX = -(y1 - y0);
        const perpY =  (x1 - x0);
        const plen = Math.hypot(perpX, perpY) || 1;
        const jitter = (Math.random() - 0.5) * r * 0.35;
        gfx.lineTo(lx + perpX / plen * jitter, ly + perpY / plen * jitter);
      }
      gfx.lineTo(x1, y1);
      gfx.strokePath();
    }

    // Short crackles along the border — a handful of radial tufts that
    // flicker on and off.
    const tufts = 5;
    for (let i = 0; i < tufts; i++) {
      if (Math.random() < 0.35) continue;   // occasional blink
      const ang = Math.random() * Math.PI * 2;
      const ix = Math.cos(ang) * r;
      const iy = Math.sin(ang) * r;
      const ox = Math.cos(ang) * r * (1.15 + Math.random() * 0.35);
      const oy = Math.sin(ang) * r * (1.15 + Math.random() * 0.35);
      const jitX = (Math.random() - 0.5) * r * 0.22;
      const jitY = (Math.random() - 0.5) * r * 0.22;
      gfx.lineStyle(arcW, ELEC_ARC, 0.9);
      gfx.beginPath();
      gfx.moveTo(ix, iy);
      gfx.lineTo((ix + ox) / 2 + jitX, (iy + oy) / 2 + jitY);
      gfx.lineTo(ox, oy);
      gfx.strokePath();
    }
    // Force redraw next frame regardless of cached hex.
    gfx._tintHex = null;
  }

  remove(shape, pop, cause) {
    const gfx = this.handles.get(shape.id);
    if (!gfx) return;
    this.handles.delete(shape.id);
    if (cause === 'laser') {
      // Shatter: spawn several smaller copies that fly outward + fade.
      this._spawnDebris(shape, gfx);
      gfx.destroy();
      return;
    }
    if (pop) {
      // Snap to at least full size before bursting. Without this, a shape
      // popped at a sink (typed-mismatch reject) would tween from its
      // already-near-zero "swallow" scale and the pop would be invisible —
      // indistinguishable from a normal accept.
      const base = Math.max(gfx.scaleX, gfx.scaleY, 1);
      gfx.setScale(base);
      this.scene.tweens.add({
        targets: gfx,
        scale: base * 1.9,
        alpha: 0,
        duration: 220,
        ease: 'Sine.easeOut',
        onComplete: () => gfx.destroy(),
      });
    } else {
      gfx.destroy();
    }
  }

  _spawnDebris(shape, origGfx) {
    const form = shape.form || DEFAULT_SHAPE_TYPE.form;
    const smallR = Math.max(3, Math.round(this.radius * 0.45));
    const sw     = Math.max(1, Math.round(this.strokeW * 0.7));
    const count  = 5;
    const cx = origGfx.x, cy = origGfx.y;
    for (let i = 0; i < count; i++) {
      const g = this.scene.make.graphics({ add: false });
      g.fillStyle(DEBRIS_FILL, 1);
      g.lineStyle(sw, DEBRIS_STROKE, 1);
      drawShapeForm(g, smallR, form);
      g.x = cx + (Math.random() - 0.5) * this.radius * 0.3;
      g.y = cy + (Math.random() - 0.5) * this.radius * 0.3;
      g.rotation = Math.random() * Math.PI * 2;
      g.setScale(1);
      this.container.add(g);

      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      const dist  = this.radius * (1.5 + Math.random() * 1.2);
      const tx = cx + Math.cos(angle) * dist;
      const ty = cy + Math.sin(angle) * dist;
      this.scene.tweens.add({
        targets: g,
        x: tx,
        y: ty,
        scale: 0.15,
        alpha: 0,
        rotation: g.rotation + (Math.random() - 0.5) * Math.PI * 1.4,
        duration: 520 + Math.random() * 180,
        ease: 'Sine.easeOut',
        onComplete: () => g.destroy(),
      });
    }
  }

  clearAll() {
    for (const gfx of this.handles.values()) gfx.destroy();
    this.handles.clear();
  }
}

// Axis-aligned form rendering, sized to fit a circumscribed circle of `r`.
// Square: side = r * 1.7 (matches BufferLabelRenderer.drawForm).
// Triangle: equilateral, point-up, height ≈ 2r (visual parity with the label).
function lerpHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function drawShapeForm(gfx, r, form) {
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(-s / 2, -s / 2, s, s);
      gfx.strokeRect(-s / 2, -s / 2, s, s);
      return;
    }
    case 'triangle': {
      const h = r * 2;
      const halfBase = r * 1.05;
      gfx.beginPath();
      gfx.moveTo(0,            -h * 0.6);
      gfx.lineTo(-halfBase,     h * 0.4);
      gfx.lineTo( halfBase,     h * 0.4);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      return;
    }
    case 'circle':
    default: {
      gfx.fillCircle(0, 0, r);
      gfx.strokeCircle(0, 0, r);
    }
  }
}
