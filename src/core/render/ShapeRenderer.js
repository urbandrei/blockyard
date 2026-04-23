import { COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_RADIUS_FRAC, outlineWidth } from '../constants.js';

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

  remove(shape, pop) {
    const gfx = this.handles.get(shape.id);
    if (!gfx) return;
    this.handles.delete(shape.id);
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
