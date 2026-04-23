// Top-of-blueprint white pill row holding 6 horizontally-arranged tool
// slots. Each slot shows the icon of the currently-armed tool for its
// category. The bar is purely a visual + hit-test surface — slot-tap and
// drag-from-slot are wired by EditorScene/PaletteDragController.
//
// Visual reference: matches the hint pill in PlayerScene.js:638-663
// (white fill, dark stroke, ~25% rounded corners). Six slot dividers are
// drawn as thin separators inside the single pill.

import { SLOT_COUNT, TOOLS_BY_SLOT, DEFAULT_ARMED_BY_SLOT, SLOT_LABELS, findTool } from './tools.js';

export class PaletteBar {
  // scene: Phaser scene
  // container: a Phaser container positioned at the palette band's origin
  // opts: { width, height } — outer pill dimensions in container-local coords
  constructor(scene, container, opts) {
    this.scene = scene;
    this.container = container;
    this.width = opts.width;
    this.height = opts.height;
    // armed[slotIdx] = tool id currently shown in that slot. Undo's id is
    // present as a no-op stand-in so SLOT_COUNT slots always render.
    this._armed = DEFAULT_ARMED_BY_SLOT.slice();
    this._gfx = scene.make.graphics({ add: false });
    this._labelTexts = [];   // Phaser.Text objects, one per slot
    this.container.add(this._gfx);
    this.redraw();
  }

  setArmed(slotIdx, toolId) {
    if (slotIdx < 0 || slotIdx >= SLOT_COUNT) return;
    if (!findTool(toolId)) return;
    this._armed[slotIdx] = toolId;
    this.redraw();
  }

  getArmed(slotIdx) {
    return this._armed[slotIdx];
  }

  // Hit-test a point in container-local coords. Returns the slot index, or
  // -1 if the point is outside the pill or in a separator gutter.
  slotAt(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return -1;
    const slotW = this.width / SLOT_COUNT;
    const idx = Math.floor(x / slotW);
    return idx >= 0 && idx < SLOT_COUNT ? idx : -1;
  }

  // Center of slot `idx` in container-local coords. Used by PalettePopup
  // to anchor itself to the tapped slot.
  slotCenter(idx) {
    const slotW = this.width / SLOT_COUNT;
    return { x: idx * slotW + slotW / 2, y: this.height / 2 };
  }

  // Per-slot pixel dimensions — used so the popup option cells can match
  // the palette slot size for visual continuity.
  slotSize() {
    return { w: this.width / SLOT_COUNT, h: this.height };
  }

  // Bottom-edge Y of the palette pill in container-local coords. Used so
  // the popup can drop down from the BOTTOM of the slot instead of from
  // its center.
  bottomY() {
    return this.height;
  }

  redraw() {
    const g = this._gfx;
    g.clear();
    // Tear down per-slot text objects from the previous redraw so we can
    // recreate them with the latest armed-tool labels.
    for (const t of this._labelTexts) t.destroy();
    this._labelTexts.length = 0;

    const w = this.width;
    const h = this.height;
    // Subtler rounding — small fixed-feel radius rather than a quarter of
    // the band height. Reads more as a panel than a pill.
    const radius = Math.max(4, Math.round(h * 0.12));

    // White pill background with dark hairline stroke (matches hint pill).
    g.fillStyle(0xffffff, 1);
    g.lineStyle(2, 0x1a2332, 1);
    g.fillRoundedRect(0, 0, w, h, radius);
    g.strokeRoundedRect(0, 0, w, h, radius);

    // Slot dividers — light grey vertical hairlines between slots.
    g.lineStyle(1, 0xc8ccd0, 1);
    const slotW = w / SLOT_COUNT;
    for (let i = 1; i < SLOT_COUNT; i++) {
      const x = Math.round(i * slotW);
      g.beginPath();
      g.moveTo(x, h * 0.10);
      g.lineTo(x, h * 0.90);
      g.strokePath();
    }

    // Vertical zoning per slot:
    //   top    ≈ 22% — small text label (the armed tool's name)
    //   middle ≈ 60% — square icon
    //   bottom ≈ 18% — dropdown chevron (only for multi-option slots)
    const labelH = Math.round(h * 0.22);
    const chevronH = Math.round(h * 0.18);
    const iconBandTop = labelH;
    const iconBandH = h - labelH - chevronH;
    const iconSize = Math.max(12, Math.round(Math.min(slotW * 0.85, iconBandH * 0.95)));
    const fontPx = Math.max(10, Math.round(labelH * 0.78));

    for (let i = 0; i < SLOT_COUNT; i++) {
      const tool = findTool(this._armed[i]);
      if (!tool) continue;
      const cx = i * slotW + slotW / 2;

      // Category label — same string regardless of which option is armed
      // in this slot. Stable anchor so the user always knows what the
      // slot does.
      const categoryLabel = SLOT_LABELS[i];
      if (categoryLabel) {
        const text = this.scene.add.text(cx, labelH / 2, categoryLabel, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: `${fontPx}px`,
          color: '#1a2332',
          align: 'center',
          wordWrap: { width: slotW - 6 },
        }).setOrigin(0.5);
        this.container.add(text);
        this._labelTexts.push(text);
      }

      if (tool.drawIcon) {
        const iconCy = iconBandTop + iconBandH / 2;
        tool.drawIcon(g, cx, iconCy, iconSize);
        // Help slot — overlay a "?" character inside the icon's circle to
        // match the canonical hint-button look. The icon glyph itself is
        // just the outlined circle (drawHelpIcon); the text sits on top.
        if (tool.id === 'help') {
          const qSize = Math.max(12, Math.round(iconSize * 0.7));
          const q = this.scene.add.text(cx, iconCy + 1, '?', {
            fontFamily: 'system-ui, sans-serif',
            fontSize: `${qSize}px`,
            fontStyle: 'bold',
            color: '#1a2332',
          }).setOrigin(0.5);
          this.container.add(q);
          this._labelTexts.push(q);
        }
      }

      // Chevron — only when this slot has more than one option (i.e.,
      // tapping it opens a dropdown). Single-option slots (Factory,
      // Trash, Undo, Help) skip the chevron.
      const optionCount = (TOOLS_BY_SLOT[i] || []).length;
      if (optionCount > 1) {
        const chevronCy = h - chevronH / 2;
        const cw2 = Math.round(chevronH * 0.55);
        const ch2 = Math.round(chevronH * 0.42);
        g.lineStyle(Math.max(1, Math.round(chevronH * 0.16)), 0x6a7480, 1);
        g.beginPath();
        g.moveTo(cx - cw2 / 2, chevronCy - ch2 / 2);
        g.lineTo(cx,           chevronCy + ch2 / 2);
        g.lineTo(cx + cw2 / 2, chevronCy - ch2 / 2);
        g.strokePath();
      }
    }
  }

  destroy() {
    for (const t of this._labelTexts) t.destroy();
    this._labelTexts.length = 0;
    if (this._gfx) { this._gfx.destroy(); this._gfx = null; }
  }
}
