import { FORMS, COLORS, COLOR_HEX } from '../model/shape.js';

// Floating editor for a factory cell's label.
//
// The label is a partial shape type: `{form?, color?}`. Each axis is a
// toggle — tap a selected form/color to drop it and leave that axis
// wildcard. A cell with only `{form}` is a shape converter (white-fill
// glyph); one with only `{color}` is a color converter (puddle glyph);
// one with both is a full-type singleton. When both axes are dropped
// the picker emits onClear so the cell becomes pass-through again.
//
// Same shield + panel + clamp pattern as FunnelTypePicker so the visual
// language is consistent. Live commits each pick via opts.onChange.

const PANEL_W = 260;
const PANEL_H = 256;
const PANEL_H_NO_REMOVE = 200;
const ROW_H = 56;
const SWATCH = 44;

export class CellLabelPicker {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x   anchor x
   * @param {number} opts.y   anchor y
   * @param {{form?:string,color?:string}|null} opts.label  current label (null = no label)
   * @param {(label:{form:string,color:string})=>void} opts.onChange
   * @param {()=>void} opts.onClear
   * @param {()=>void} opts.onClose
   * @param {()=>void} [opts.onRemove]  if provided, picker shows a REMOVE CELL
   *                                    button (used by the draft composer to
   *                                    delete the underlying grid cell).
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    // Empty object = "no label yet" / "both axes cleared". Existing
    // labels may be partial (form-only or color-only) — preserve as-is.
    this.label = { ...(opts.label || {}) };
    this._showRemove = !!opts.onRemove;
    this._build();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.root && this.root.destroy();
    this.shield && this.shield.destroy();
    this.scene.time.delayedCall(0, () => {
      this.opts.onClose && this.opts.onClose();
    });
  }

  _build() {
    const { scene } = this;
    const sw = scene.scale.width, sh = scene.scale.height;
    this.shield = scene.add
      .rectangle(sw / 2, sh / 2, sw, sh, 0x000000, 0.001)
      .setDepth(9000)
      .setInteractive({ useHandCursor: false });
    this.shield.on('pointerdown', () => this.close());

    const panelH = this._showRemove ? PANEL_H : PANEL_H_NO_REMOVE;
    const px = Math.max(PANEL_W / 2 + 8, Math.min(sw - PANEL_W / 2 - 8, this.opts.x));
    const py = Math.max(panelH / 2 + 8, Math.min(sh - panelH / 2 - 8, this.opts.y));
    this.root = scene.add.container(px, py).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 0.98);
    bg.lineStyle(2, 0x000000, 1);
    bg.fillRoundedRect(-PANEL_W / 2, -panelH / 2, PANEL_W, panelH, 12);
    bg.strokeRoundedRect(-PANEL_W / 2, -panelH / 2, PANEL_W, panelH, 12);
    this.root.add(bg);

    const panelHit = scene.add.rectangle(0, 0, PANEL_W, panelH, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    const topY = -panelH / 2 + ROW_H / 2 + 6;
    this.formRow  = this._buildFormRow(0, topY);
    this.colorRow = this._buildColorRow(0, topY + ROW_H);
    this.clearBtn = this._buildClear(0, topY + ROW_H * 2);
    if (this._showRemove) {
      this.removeBtn = this._buildRemove(0, topY + ROW_H * 3);
    }
    // Paint initial selection rings so the picker opens showing the
    // cell's current label state (partial or full).
    this._refreshSelections();
  }

  _buildFormRow(cx, cy) {
    const buttons = [];
    const span = SWATCH * 1.2;
    FORMS.forEach((form, i) => {
      const x = cx + (i - 1) * span;
      const btn = this._iconBtn(x, cy, () => this._toggleForm(form));
      const gfx = this.scene.add.graphics();
      btn.add(gfx);
      btn._form = form;
      btn._iconGfx = gfx;
      buttons.push(btn);
    });
    this._repaintFormIcons(buttons);
    return buttons;
  }

  _buildColorRow(cx, cy) {
    const buttons = [];
    const span = SWATCH * 1.2;
    COLORS.forEach((color, i) => {
      const x = cx + (i - 1) * span;
      const btn = this._iconBtn(x, cy, () => this._toggleColor(color));
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

  _toggleForm(form) {
    if (this.label.form === form) delete this.label.form;
    else                          this.label.form = form;
    this._commit();
  }

  _toggleColor(color) {
    if (this.label.color === color) delete this.label.color;
    else                             this.label.color = color;
    this._commit();
  }

  // Repaint + fire the appropriate callback. A label with neither axis
  // set is semantically "no label" — we call onClear so the cell drops
  // back to pass-through pipe space instead of carrying an empty {}.
  _commit() {
    this._refreshSelections();
    if (this.formRow) this._repaintFormIcons(this.formRow);
    const hasAxis = !!this.label.form || !!this.label.color;
    if (hasAxis) {
      this.opts.onChange && this.opts.onChange({ ...this.label });
    } else {
      this.opts.onClear && this.opts.onClear();
    }
  }

  // Form-row icon reflects the current color axis:
  //   full label  → form glyph in label.color
  //   form only   → form glyph filled white (color axis is wildcard)
  // The color row button always shows its canonical color regardless of
  // selection state, so we don't repaint it here.
  _repaintFormIcons(buttons) {
    const colorKey = this.label.color;
    const fill = colorKey ? COLOR_HEX[colorKey] : 0xffffff;
    for (const b of buttons) {
      b._iconGfx.clear();
      drawFormIcon(b._iconGfx, 0, 0, SWATCH * 0.32, b._form, fill);
    }
  }

  _buildClear(cx, cy) {
    return this._buildActionRow(cx, cy, 'CLEAR LABEL', '#a01010', () => {
      this.opts.onClear && this.opts.onClear();
      this.close();
    });
  }

  _buildRemove(cx, cy) {
    return this._buildActionRow(cx, cy, 'REMOVE CELL', '#a01010', () => {
      this.opts.onRemove && this.opts.onRemove();
      this.close();
    });
  }

  _buildActionRow(cx, cy, label, color, onTap) {
    const w = SWATCH * 4.4;
    const btn = this.scene.add.container(cx, cy);
    const bg = this.scene.add.graphics();
    bg.fillStyle(0xeeeeee, 1);
    bg.lineStyle(2, 0x666666, 1);
    bg.fillRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
    bg.strokeRoundedRect(-w / 2, -SWATCH / 2 + 4, w, SWATCH - 8, 8);
    const txt = this.scene.add.text(0, 0, label, {
      fontFamily: 'monospace', fontSize: '14px', color,
    }).setOrigin(0.5);
    btn.add([bg, txt]);
    const hit = this.scene.add.rectangle(0, 0, w, SWATCH - 8, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', (_p, _lx, _ly, e) => {
      e.stopPropagation();
      onTap();
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
      if (b._form === this.label.form) {
        b._ring.lineStyle(3, 0x000000, 1);
        b._ring.strokeRoundedRect(-SWATCH / 2, -SWATCH / 2, SWATCH, SWATCH, 8);
      }
    }
    for (const b of this.colorRow || []) {
      b._ring.clear();
      if (b._color === this.label.color) {
        b._ring.lineStyle(3, 0x000000, 1);
        b._ring.strokeRoundedRect(-SWATCH / 2, -SWATCH / 2, SWATCH, SWATCH, 8);
      }
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
