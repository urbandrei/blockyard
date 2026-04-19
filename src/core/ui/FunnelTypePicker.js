import { FORMS, COLORS, COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import {
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
} from '../constants.js';

// Floating editor for a buffer-region funnel: form (circle/square/triangle)
// × color (red/green/blue) × role (input/output) + delete.
//
// Construct with the current funnel state and a callback bag. The picker
// commits each user pick immediately (live edit) and tears itself down on
// `delete`, on tap outside, or when the consumer calls `close()`.
//
// The picker draws into a top-level Phaser container at scene-root depth
// (caller positions it via `x` / `y`). It blocks underlying input via a
// fullscreen transparent rect that swallows pointerdown.

const PANEL_W = 260;
const PANEL_H = 220;
const ROW_H = 56;
const SWATCH = 44;

export class FunnelTypePicker {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x  anchor x in scene coords (panel will clamp into scene)
   * @param {number} opts.y  anchor y
   * @param {{form:string,color:string}} opts.type   current type (defaults applied)
   * @param {'input'|'output'} opts.role             current role
   * @param {(patch:{type?:object,role?:string})=>void} opts.onChange
   * @param {()=>void} opts.onDelete
   * @param {()=>void} opts.onClose
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.type = { ...(opts.type || DEFAULT_SHAPE_TYPE) };
    this.role = opts.role === 'output' ? 'output' : 'input';
    this._build();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.root && this.root.destroy();
    this.shield && this.shield.destroy();
    // Defer onClose by one tick: scene-level pointer handlers (DragController)
    // for the SAME tap that closed us still need to see the picker as "open"
    // so they short-circuit. Without this, tapping a buffer edge to dismiss
    // would also open/create a funnel underneath.
    this.scene.time.delayedCall(0, () => {
      this.opts.onClose && this.opts.onClose();
    });
  }

  _build() {
    const { scene } = this;
    const sw = scene.scale.width, sh = scene.scale.height;
    // Fullscreen click-shield. Tapping it closes the picker.
    this.shield = scene.add
      .rectangle(sw / 2, sh / 2, sw, sh, 0x000000, 0.001)
      .setDepth(9000)
      .setInteractive({ useHandCursor: false });
    this.shield.on('pointerdown', () => this.close());

    // Clamp panel into the scene bounds so it never sits offscreen.
    const px = Math.max(PANEL_W / 2 + 8, Math.min(sw - PANEL_W / 2 - 8, this.opts.x));
    const py = Math.max(PANEL_H / 2 + 8, Math.min(sh - PANEL_H / 2 - 8, this.opts.y));
    this.root = scene.add.container(px, py).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 0.98);
    bg.lineStyle(2, 0x000000, 1);
    bg.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 12);
    bg.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 12);
    this.root.add(bg);

    // Swallow taps inside the panel so they don't fall through to the shield.
    const panelHit = scene.add.rectangle(0, 0, PANEL_W, PANEL_H, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    const topY = -PANEL_H / 2 + ROW_H / 2 + 6;
    this.formRow  = this._buildFormRow(0, topY);
    this.colorRow = this._buildColorRow(0, topY + ROW_H);
    this.roleRow  = this._buildRoleRow(0, topY + ROW_H * 2);
    this.deleteBtn = this._buildDelete(0, topY + ROW_H * 3 - 6);
  }

  _buildFormRow(cx, cy) {
    const buttons = [];
    const span = SWATCH * 1.2;
    FORMS.forEach((form, i) => {
      const x = cx + (i - 1) * span;
      const btn = this._iconBtn(x, cy, () => {
        this.type = { ...this.type, form };
        this._refreshSelections();
        this.opts.onChange && this.opts.onChange({ type: this.type });
      });
      const gfx = this.scene.add.graphics();
      drawFormIcon(gfx, 0, 0, SWATCH * 0.32, form, COLOR_HEX[this.type.color]);
      btn.add(gfx);
      btn._form = form;
      btn._iconGfx = gfx;
      buttons.push(btn);
    });
    return buttons;
  }

  _buildColorRow(cx, cy) {
    const buttons = [];
    const span = SWATCH * 1.2;
    COLORS.forEach((color, i) => {
      const x = cx + (i - 1) * span;
      const btn = this._iconBtn(x, cy, () => {
        this.type = { ...this.type, color };
        this._refreshSelections();
        // Color row affects only the color; refresh form-row icon tint.
        for (const b of this.formRow) {
          b._iconGfx.clear();
          drawFormIcon(b._iconGfx, 0, 0, SWATCH * 0.32, b._form, COLOR_HEX[this.type.color]);
        }
        this.opts.onChange && this.opts.onChange({ type: this.type });
      });
      const gfx = this.scene.add.graphics();
      gfx.fillStyle(COLOR_HEX[color], 1);
      gfx.lineStyle(2, 0x000000, 1);
      gfx.fillCircle(0, 0, SWATCH * 0.3);
      gfx.strokeCircle(0, 0, SWATCH * 0.3);
      btn.add(gfx);
      btn._color = color;
      buttons.push(btn);
    });
    return buttons;
  }

  _buildRoleRow(cx, cy) {
    const buttons = [];
    const w = SWATCH * 2.2;
    // Role-picker colors in the modal are INVERTED from the board triangles:
    // here INPUT reads red, OUTPUT reads green. This is per-user-preference
    // for the picker only — FunnelRenderer + BufferLabelRenderer on the
    // board stay at their green-in / red-out convention.
    const opts = [
      { role: 'input',  label: 'INPUT',  fill: FUNNEL_OUTPUT_FILL, stroke: FUNNEL_OUTPUT_STROKE },
      { role: 'output', label: 'OUTPUT', fill: FUNNEL_INPUT_FILL,  stroke: FUNNEL_INPUT_STROKE  },
    ];
    opts.forEach((o, i) => {
      const x = cx + (i === 0 ? -w / 2 - 2 : w / 2 + 2);
      const btn = this.scene.add.container(x, cy);
      const bg = this.scene.add.graphics();
      bg.fillStyle(o.fill, 1);
      bg.lineStyle(2, o.stroke, 1);
      bg.fillRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
      bg.strokeRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
      const txt = this.scene.add.text(0, 0, o.label, {
        fontFamily: 'monospace', fontSize: '14px', color: '#ffffff',
      }).setOrigin(0.5);
      btn.add([bg, txt]);
      const hit = this.scene.add.rectangle(0, 0, w, SWATCH - 8, 0xffffff, 0.001)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerdown', (_p, _lx, _ly, e) => {
        e.stopPropagation();
        this.role = o.role;
        this._refreshSelections();
        this.opts.onChange && this.opts.onChange({ role: this.role });
      });
      btn.add(hit);
      btn._role = o.role;
      btn._bg = bg;
      btn._txtFill = o.fill;
      btn._txtStroke = o.stroke;
      btn._w = w;
      this.root.add(btn);
      buttons.push(btn);
    });
    this._refreshSelections();
    return buttons;
  }

  _buildDelete(cx, cy) {
    const w = SWATCH * 4.4;
    const btn = this.scene.add.container(cx, cy);
    const bg = this.scene.add.graphics();
    bg.fillStyle(0xeeeeee, 1);
    bg.lineStyle(2, 0x666666, 1);
    bg.fillRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
    bg.strokeRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
    const txt = this.scene.add.text(0, 0, 'DELETE FUNNEL', {
      fontFamily: 'monospace', fontSize: '14px', color: '#a01010',
    }).setOrigin(0.5);
    btn.add([bg, txt]);
    const hit = this.scene.add.rectangle(0, 0, w, SWATCH - 8, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', (_p, _lx, _ly, e) => {
      e.stopPropagation();
      this.opts.onDelete && this.opts.onDelete();
      this.close();
    });
    btn.add(hit);
    this.root.add(btn);
    return btn;
  }

  _iconBtn(x, y, onTap) {
    const btn = this.scene.add.container(x, y);
    const ring = this.scene.add.graphics();
    btn.add(ring);
    btn._ring = ring;
    const hit = this.scene.add.rectangle(0, 0, SWATCH, SWATCH, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); onTap(); });
    btn.add(hit);
    this.root.add(btn);
    return btn;
  }

  _refreshSelections() {
    for (const b of this.formRow || []) {
      b._ring.clear();
      if (b._form === this.type.form) {
        b._ring.lineStyle(3, 0x000000, 1);
        b._ring.strokeRoundedRect(-SWATCH / 2, -SWATCH / 2, SWATCH, SWATCH, 8);
      }
    }
    for (const b of this.colorRow || []) {
      b._ring.clear();
      if (b._color === this.type.color) {
        b._ring.lineStyle(3, 0x000000, 1);
        b._ring.strokeRoundedRect(-SWATCH / 2, -SWATCH / 2, SWATCH, SWATCH, 8);
      }
    }
    for (const b of this.roleRow || []) {
      b._bg.clear();
      const selected = b._role === this.role;
      const alpha = selected ? 1 : 0.45;
      b._bg.fillStyle(b._txtFill, alpha);
      b._bg.lineStyle(selected ? 3 : 2, b._txtStroke, 1);
      b._bg.fillRoundedRect(-b._w / 2, -SWATCH / 2 + 4, b._w, SWATCH - 8, 8);
      b._bg.strokeRoundedRect(-b._w / 2, -SWATCH / 2 + 4, b._w, SWATCH - 8, 8);
    }
  }
}

function drawFormIcon(gfx, cx, cy, r, form, color) {
  gfx.fillStyle(color, 1);
  gfx.lineStyle(2, 0x000000, 1);
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(cx - s / 2, cy - s / 2, s, s);
      gfx.strokeRect(cx - s / 2, cy - s / 2, s, s);
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
      gfx.strokePath();
      return;
    }
    case 'circle':
    default: {
      gfx.fillCircle(cx, cy, r);
      gfx.strokeCircle(cx, cy, r);
    }
  }
}
