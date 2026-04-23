import { COLOR_HEX } from '../model/shape.js';
import { ACID_WHITE } from '../constants.js';

// Floating editor for a single acid-pit cell. Four swatches in a row —
// "white" (unlabeled) plus the three shape colors — and a DELETE button.
// Construct with the current cell's label (or null) and a callback bag;
// edits commit live and close on tap-outside.

const PANEL_W = 260;
const PANEL_H = 160;
const SWATCH = 44;

export class AcidPitTypePicker {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x
   * @param {number} opts.y
   * @param {null|{color:string}} opts.label   current label (null = unlabeled / white)
   * @param {(label: null|{color:string}) => void} opts.onChange
   * @param {() => void} opts.onDelete
   * @param {() => void} opts.onClose
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.label = opts.label ? { color: opts.label.color } : null;
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

    const px = Math.max(PANEL_W / 2 + 8, Math.min(sw - PANEL_W / 2 - 8, this.opts.x));
    const py = Math.max(PANEL_H / 2 + 8, Math.min(sh - PANEL_H / 2 - 8, this.opts.y));
    this.root = scene.add.container(px, py).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 0.98);
    bg.lineStyle(2, 0x000000, 1);
    bg.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 12);
    bg.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 12);
    this.root.add(bg);

    const panelHit = scene.add.rectangle(0, 0, PANEL_W, PANEL_H, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    const swatchRowY = -PANEL_H / 2 + SWATCH / 2 + 24;
    this.colorRow = this._buildColorRow(0, swatchRowY);
    this.deleteBtn = this._buildDelete(0, PANEL_H / 2 - 34);
  }

  _buildColorRow(cx, cy) {
    const entries = [
      { color: null,    hex: ACID_WHITE         },
      { color: 'red',   hex: COLOR_HEX.red      },
      { color: 'green', hex: COLOR_HEX.green    },
      { color: 'blue',  hex: COLOR_HEX.blue     },
    ];
    const buttons = [];
    const span = SWATCH * 1.2;
    entries.forEach((e, i) => {
      const x = cx + (i - (entries.length - 1) / 2) * span;
      const btn = this._iconBtn(x, cy, () => {
        this.label = e.color ? { color: e.color } : null;
        this._refreshSelections();
        this.opts.onChange && this.opts.onChange(this.label);
      });
      const gfx = this.scene.add.graphics();
      gfx.fillStyle(e.hex, 1);
      gfx.lineStyle(2, 0x000000, 1);
      gfx.fillRoundedRect(-SWATCH / 2 + 4, -SWATCH / 2 + 4, SWATCH - 8, SWATCH - 8, 6);
      gfx.strokeRoundedRect(-SWATCH / 2 + 4, -SWATCH / 2 + 4, SWATCH - 8, SWATCH - 8, 6);
      btn.add(gfx);
      btn._color = e.color;
      buttons.push(btn);
    });
    this._refreshSelections = () => {
      for (const b of buttons) {
        b._ring.clear();
        const selected = (b._color || null) === (this.label ? this.label.color : null);
        if (selected) {
          b._ring.lineStyle(3, 0x000000, 1);
          b._ring.strokeRoundedRect(-SWATCH / 2, -SWATCH / 2, SWATCH, SWATCH, 8);
        }
      }
    };
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
    const txt = this.scene.add.text(0, 0, 'DELETE PIT', {
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
}

