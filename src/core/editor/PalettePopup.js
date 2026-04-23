// Floating popup for a palette category. Shows the category's options as
// a small panel anchored to (or near) the tapped slot. Picking an option
// fires onPick(toolId) — the caller arms that tool in the slot and the
// popup tears down.
//
// Pattern lifted from FunnelTypePicker.js:
//   - Shield rect at depth 9000 to capture taps outside (dismiss).
//   - Panel container at depth 9001 with a hit-test rect that swallows
//     pointerdown so taps INSIDE the panel don't dismiss it.
//   - close() defers onClose by one tick so the same pointerdown that
//     triggered the close doesn't ALSO get interpreted as a slot tap or
//     drag-start by the palette / scene listeners.
//
// Layout types:
//   'row'    — vertical stack of options dropping DOWN from the slot.
//              Used for Factory (1), Funnels (3), Board pieces (5), Trash (1).
//              Despite the name (kept for back-compat) the layout is now
//              column-oriented so the dropdown reads as Adobe-style.
//   'labels' — 4-col × 4-row grid:
//                  (0,0)=eraser  (0,1..3)=color headers (visual)
//                  (1..3,0)=form headers (visual)  (r,c)=combo (interactive)
//              Plus a 5th row holding the bolt option centered.

const PAD = 10;             // panel padding

import { FORMS, COLORS } from '../model/shape.js';

export class PalettePopup {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {{x:number,y:number}} opts.anchor    target screen point (popup will clamp inside scene)
   * @param {{w:number,h:number}} opts.slotSize  palette slot dimensions — popup option cells match this so visual continuity holds between the slot and its options
   * @param {'row'|'labels'} opts.layout
   * @param {Array} opts.options                 tool objects from tools.js
   * @param {(toolId:string)=>void} opts.onPick
   * @param {()=>void} opts.onClose
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    // Square option container — sized to match the icon size used by the
    // palette bar (≈ 0.7 of the slot's shorter dim) plus a small padding,
    // so dropdown options visually mirror the bar above without the cell
    // looking oversized. Cell ≈ 0.78 of the shorter slot dim.
    const ss = opts.slotSize || { w: 56, h: 56 };
    const square = Math.max(28, Math.round(Math.min(ss.w, ss.h) * 0.78));
    this._cellW = square;
    this._cellH = square;
    this._selectedId = opts.selectedId || null;
    this._build();
    this._playEntranceTween();
  }

  // Quick scale + fade entrance — a subtle "drop" from the slot above.
  // Tween targets the panel root container; the shield is left alone so
  // tap-to-dismiss is responsive even mid-animation.
  _playEntranceTween() {
    if (!this.root) return;
    const finalY = this.root.y;
    this.root.y = finalY - 12;
    this.root.alpha = 0;
    this.root.scaleX = 0.92;
    this.root.scaleY = 0.92;
    this.scene.tweens.add({
      targets: this.root,
      y: finalY,
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 160,
      ease: 'Back.easeOut',
    });
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
    const { scene, opts } = this;
    const sw = scene.scale.width;
    const sh = scene.scale.height;

    // Panel dimensions vary by layout.
    const dims = this._panelDims();
    const panelW = dims.width;
    const panelH = dims.height;

    // Fullscreen click-shield. Tapping outside the panel closes us.
    // The shield ALSO forwards the tap location to the optional
    // `onShieldTap(x, y)` callback so the caller can implement
    // "tap-origin-slot-to-cycle" semantics (caller checks if the tap is
    // inside the slot that opened this popup).
    this.shield = scene.add
      .rectangle(sw / 2, sh / 2, sw, sh, 0x000000, 0.001)
      .setDepth(9000)
      .setInteractive({ useHandCursor: false });
    this.shield.on('pointerdown', (pointer) => {
      if (this.opts.onShieldTap) this.opts.onShieldTap(pointer.x, pointer.y);
      this.close();
    });

    // Anchor: drop the panel DOWN from the slot the user tapped (Adobe-
    // style dropdown). Clamp into scene bounds with an 8px margin so the
    // panel never sits offscreen on small viewports.
    const ax = opts.anchor.x;
    const ay = opts.anchor.y;
    const desiredCx = ax;
    const desiredCy = ay + panelH / 2 + 8;     // BELOW the anchor
    const px = Math.max(panelW / 2 + 8, Math.min(sw - panelW / 2 - 8, desiredCx));
    const py = Math.max(panelH / 2 + 8, Math.min(sh - panelH / 2 - 8, desiredCy));
    this.root = scene.add.container(px, py).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 0.98);
    bg.lineStyle(2, 0x1a2332, 1);
    bg.fillRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 12);
    bg.strokeRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 12);
    this.root.add(bg);

    // Swallow pointerdown anywhere inside the panel so taps on background
    // (not on an option) don't trickle through to the shield.
    const panelHit = scene.add.rectangle(0, 0, panelW, panelH, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    if (opts.layout === 'labels') this._buildLabelsGrid(panelW, panelH);
    else                          this._buildColumn(panelW, panelH);
  }

  _panelDims() {
    const { layout, options } = this.opts;
    const cw = this._cellW;
    const ch = this._cellH;
    if (layout === 'labels') {
      // 4 cols (corner+eraser, 3 color headers/cols), 4 rows (header + 3 forms)
      // plus 1 extra row for the bolt option below.
      const cols = 4;
      const rows = 5;
      return {
        width:  PAD * 2 + cols * cw,
        height: PAD * 2 + rows * ch,
      };
    }
    // Vertical drop-down — N cells stacked top-to-bottom.
    const n = Math.max(1, options.length);
    return {
      width:  PAD * 2 + cw,
      height: PAD * 2 + n * ch,
    };
  }

  _buildColumn(panelW, panelH) {
    const { options } = this.opts;
    const cw = this._cellW;
    const ch = this._cellH;
    const startY = -panelH / 2 + PAD + ch / 2;
    for (let i = 0; i < options.length; i++) {
      const tool = options[i];
      const x = 0;
      const y = startY + i * ch;
      this._addOptionCell(tool, x, y, cw, ch, true);
    }
  }

  _buildLabelsGrid(panelW, panelH) {
    const { options } = this.opts;
    const cw = this._cellW;
    const ch = this._cellH;
    const startX = -panelW / 2 + PAD + cw / 2;
    const startY = -panelH / 2 + PAD + ch / 2;
    const eraser = options.find((t) => t.special === 'eraser');
    const bolt   = options.find((t) => t.special === 'bolt');
    const colorHeaderFor = (color) => options.find((t) => t.special === 'colorHeader' && t.color === color);
    const formHeaderFor  = (form)  => options.find((t) => t.special === 'formHeader'  && t.form  === form);

    // (0,0) corner = eraser (interactive).
    if (eraser) this._addOptionCell(eraser, startX, startY, cw, ch, true);

    // (0,1..3) = color-only labels (interactive — drag the puddle to apply
    // a color-only label to a cell / acid pit / border funnel).
    COLORS.forEach((color, i) => {
      const tool = colorHeaderFor(color);
      if (!tool) return;
      const cx = startX + (i + 1) * cw;
      const cy = startY;
      this._addOptionCell(tool, cx, cy, cw, ch, true);
    });

    // (1..3, 0) = form-only labels (interactive — drag the white-fill form
    // glyph to apply a form-only label).
    FORMS.forEach((form, i) => {
      const tool = formHeaderFor(form);
      if (!tool) return;
      const cx = startX;
      const cy = startY + (i + 1) * ch;
      this._addOptionCell(tool, cx, cy, cw, ch, true);
    });

    // (form, color) combo cells.
    FORMS.forEach((form, fi) => {
      COLORS.forEach((color, ci) => {
        const tool = options.find((t) => !t.special && t.form === form && t.color === color);
        if (!tool) return;
        const cx = startX + (ci + 1) * cw;
        const cy = startY + (fi + 1) * ch;
        this._addOptionCell(tool, cx, cy, cw, ch, true);
      });
    });

    // Bolt — last row, centered across the grid.
    if (bolt) {
      const cx = startX + (cw * 3) / 2 + cw / 2;   // center of cols 0..3
      const cy = startY + 4 * ch;
      this._addOptionCell(bolt, cx, cy, cw, ch, true);
    }
  }

  _addOptionCell(tool, cx, cy, cw, ch, interactive) {
    const { scene } = this;
    const cell = scene.add.container(cx, cy);
    const bg = scene.add.graphics();
    const isSelected = !!(tool && this._selectedId && tool.id === this._selectedId);
    bg.fillStyle(isSelected ? 0xfff8d9 : 0xf4f6f9, 1);
    // Thick black border for the currently-armed option; thin grey for
    // every other option.
    if (isSelected) bg.lineStyle(3, 0x000000, 1);
    else            bg.lineStyle(1, 0xb0b5bb, 1);
    const r = Math.round(Math.min(cw, ch) * 0.16);
    bg.fillRoundedRect(-cw / 2 + 3, -ch / 2 + 3, cw - 6, ch - 6, r);
    bg.strokeRoundedRect(-cw / 2 + 3, -ch / 2 + 3, cw - 6, ch - 6, r);
    cell.add(bg);
    if (tool && tool.drawIcon) {
      const iconG = scene.add.graphics();
      // Icon ≈ 90% of the cell so the glyph fills the small square. No
      // text label — the palette bar above shows the option name.
      tool.drawIcon(iconG, 0, 0, Math.min(cw, ch) * 0.9);
      cell.add(iconG);
    }
    if (interactive) {
      const hit = scene.add.rectangle(0, 0, cw - 4, ch - 4, 0xffffff, 0.001)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerdown', (_p, _lx, _ly, e) => {
        e.stopPropagation();
        this.opts.onPick && this.opts.onPick(tool.id);
        this.close();
      });
      cell.add(hit);
    }
    this.root.add(cell);
  }

}
