import { COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { SHAPE_RADIUS_FRAC, outlineWidth } from '../constants.js';
import { shapeKey, SHAPE_REF_RADIUS } from './textures/atlas.js';
import { drawShapeForm } from './shapes.js';

export { drawShapeForm };

// Electrocute-death palette — the shape flashes deep red with a darker
// outline, overlaid with a flickering electric pattern, then shatters.
const ELEC_FILL    = 0xb80000;
const ELEC_STROKE  = 0x2e0000;
const ELEC_ARC     = 0xfff0a0;   // light yellow electric current
const DEBRIS_FILL  = 0xd02020;
const DEBRIS_STROKE = 0x5a0000;

// Manages the visual for a simulation shape. The base sprite is a baked
// texture (`shapeKey(form, color)` — 9 form×color combos pre-rendered at
// PreloadScene); per-frame work is just position + scale on a sprite.
//
// Two animated states fall back to a Graphics override (lazily created):
//   • acid color-morph — shape lerps between colors during a pit transition
//   • electrocute      — shape flashes red with random arcs each frame
//
// Both wipe the override and return to sprite mode once the state ends, so
// only shapes currently in those states pay the redraw cost.

export class ShapeRenderer {
  constructor(scene, container, { pxCell }) {
    this.scene = scene;
    this.container = container;
    this.radius = Math.max(8, Math.round(pxCell * SHAPE_RADIUS_FRAC));
    this.strokeW = outlineWidth(pxCell);
    // Sprite scale that produces the same on-screen radius as the legacy
    // Graphics path. The bake reference radius is 42 — see atlas.js.
    this.spriteScale = this.radius / SHAPE_REF_RADIUS;
    this.handles = new Map(); // shape.id → { root, sprite, gfx|null, color }
  }

  spawn(shape) {
    const color = shape.color || DEFAULT_SHAPE_TYPE.color;
    const form  = shape.form  || DEFAULT_SHAPE_TYPE.form;
    const root = this.scene.add.container(shape.x, shape.y);
    const sprite = this._addSprite(root, form, color);
    root.setScale(0);
    this.container.add(root);
    this.handles.set(shape.id, { root, sprite, gfx: null, color, form });
  }

  _addSprite(root, form, color) {
    const key = shapeKey(form, color);
    if (this.scene.textures.exists(key)) {
      const img = this.scene.add.image(0, 0, key).setOrigin(0.5);
      img.setScale(this.spriteScale);
      root.add(img);
      return img;
    }
    // Fallback: bake missed (e.g. preload race / dev hot-reload). Draw the
    // shape with Graphics so the visual is correct even without the atlas.
    const g = this.scene.make.graphics({ add: false });
    g.fillStyle(COLOR_HEX[color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color], 1);
    g.lineStyle(this.strokeW, 0x000000, 1);
    drawShapeForm(g, this.radius, form);
    root.add(g);
    return g;
  }

  // scaleX / scaleY can differ so callers can drive the motion-warp
  // (stretch along direction of motion during fast phases).
  update(shape, scaleX, scaleY) {
    const h = this.handles.get(shape.id);
    if (!h) return;
    h.root.x = shape.x;
    h.root.y = shape.y;

    // Electrocuted = mid-death: frozen in place, deep red + electric arcs
    // that flicker each frame. Shape SHRINKS as the death progresses so
    // the shatter feels like the shape imploding before breaking apart.
    if (shape.electrocuted) {
      const p = shape.electrocuteProgress || 0;
      const shrink = 1 - p * 0.65;   // 1.0 → 0.35 across the freeze
      h.root.setScale(shrink);
      this._ensureOverrideGfx(h);
      this._drawElectrocuted(h.gfx, shape);
      return;
    }

    if (scaleY == null) scaleY = scaleX;
    h.root.setScale(scaleX, scaleY);

    // Acid-pit retint: while a transition is in flight, lerp the fill
    // color between the from/target hex values and redraw via a Graphics
    // overlay (sprite tint can't faithfully blend between two arbitrary
    // colors). Most shapes never enter this state — they keep using the
    // baked sprite directly.
    const targetName = shape._acidTargetName;
    const progress = shape._acidProgress || 0;
    if (targetName && progress > 0 && progress < 1) {
      const fromHex = (shape._acidFromHex != null)
        ? shape._acidFromHex
        : (COLOR_HEX[h.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color]);
      const toHex   = COLOR_HEX[targetName] || fromHex;
      const lerped  = lerpHex(fromHex, toHex, progress);
      this._ensureOverrideGfx(h);
      h.gfx.clear();
      h.gfx.fillStyle(lerped, 1);
      h.gfx.lineStyle(this.strokeW, 0x000000, 1);
      drawShapeForm(h.gfx, this.radius, shape.form || DEFAULT_SHAPE_TYPE.form);
      return;
    }

    // No override needed — drop any leftover Graphics and ensure the
    // base sprite is visible + on the right color texture.
    this._dropOverrideGfx(h);
    const desiredColor = shape.color || DEFAULT_SHAPE_TYPE.color;
    const desiredForm  = shape.form  || DEFAULT_SHAPE_TYPE.form;
    if (h.color !== desiredColor || h.form !== desiredForm) {
      const key = shapeKey(desiredForm, desiredColor);
      if (h.sprite && typeof h.sprite.setTexture === 'function' && this.scene.textures.exists(key)) {
        h.sprite.setTexture(key);
      }
      h.color = desiredColor;
      h.form  = desiredForm;
    }
  }

  _ensureOverrideGfx(h) {
    if (!h.gfx) {
      h.gfx = this.scene.make.graphics({ add: false });
      h.root.add(h.gfx);
    }
    if (h.sprite && typeof h.sprite.setVisible === 'function') h.sprite.setVisible(false);
  }

  _dropOverrideGfx(h) {
    if (h.gfx) { h.gfx.destroy(); h.gfx = null; }
    if (h.sprite && typeof h.sprite.setVisible === 'function') h.sprite.setVisible(true);
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
  }

  remove(shape, pop, cause) {
    const h = this.handles.get(shape.id);
    if (!h) return;
    this.handles.delete(shape.id);
    if (cause === 'laser') {
      // Shatter: spawn several smaller copies that fly outward + fade.
      this._spawnDebris(shape, h.root);
      h.root.destroy();
      return;
    }
    if (pop) {
      // Snap to at least full size before bursting. Without this, a shape
      // popped at a sink (typed-mismatch reject) would tween from its
      // already-near-zero "swallow" scale and the pop would be invisible —
      // indistinguishable from a normal accept.
      const base = Math.max(h.root.scaleX, h.root.scaleY, 1);
      h.root.setScale(base);
      this.scene.tweens.add({
        targets: h.root,
        scale: base * 1.9,
        alpha: 0,
        duration: 220,
        ease: 'Sine.easeOut',
        onComplete: () => h.root.destroy(),
      });
    } else {
      h.root.destroy();
    }
  }

  _spawnDebris(shape, origRoot) {
    // Debris keeps using Graphics: it's transient (one-shot fade in ~520ms),
    // uses a fixed shatter-red palette regardless of shape color, and
    // doesn't justify a separate texture per form.
    const form = shape.form || DEFAULT_SHAPE_TYPE.form;
    const smallR = Math.max(3, Math.round(this.radius * 0.45));
    const sw     = Math.max(1, Math.round(this.strokeW * 0.7));
    const count  = 5;
    const cx = origRoot.x, cy = origRoot.y;
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
    for (const h of this.handles.values()) h.root.destroy();
    this.handles.clear();
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
