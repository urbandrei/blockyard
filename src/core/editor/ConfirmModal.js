// Generic yes/no confirmation modal. Same shield + clamped panel pattern
// as HelpModal / PalettePopup. Caller passes title + body + button labels
// and gets back onConfirm / onCancel callbacks.

const PANEL_W = 380;
const PANEL_H = 200;
const PAD = 22;

export class ConfirmModal {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {string}   opts.title
   * @param {string}   opts.body
   * @param {string=}  opts.confirmLabel   (default 'YES')
   * @param {string=}  opts.cancelLabel    (default 'CANCEL')
   * @param {boolean=} opts.danger         (default false) — paints confirm button red
   * @param {()=>void} opts.onConfirm
   * @param {()=>void=} opts.onCancel
   * @param {()=>void=} opts.onClose
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
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
    const { scene, opts } = this;
    const sw = scene.scale.width;
    const sh = scene.scale.height;

    // Shield — tap-outside dismisses as CANCEL.
    this.shield = scene.add
      .rectangle(sw / 2, sh / 2, sw, sh, 0x000000, 0.45)
      .setDepth(9000)
      .setInteractive({ useHandCursor: false });
    this.shield.on('pointerdown', () => {
      this.opts.onCancel && this.opts.onCancel();
      this.close();
    });

    const px = Math.max(PANEL_W / 2 + 8, Math.min(sw - PANEL_W / 2 - 8, sw / 2));
    const py = Math.max(PANEL_H / 2 + 8, Math.min(sh - PANEL_H / 2 - 8, sh / 2));
    this.root = scene.add.container(px, py).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 1);
    bg.lineStyle(2, 0x1a2332, 1);
    bg.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 14);
    bg.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 14);
    this.root.add(bg);

    const panelHit = scene.add.rectangle(0, 0, PANEL_W, PANEL_H, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    const title = scene.add.text(0, -PANEL_H / 2 + PAD + 4, opts.title || '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#1a2332',
      align: 'center',
    }).setOrigin(0.5, 0);
    this.root.add(title);

    const body = scene.add.text(0, -PANEL_H / 2 + PAD + 40, opts.body || '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#1a2332',
      align: 'center', wordWrap: { width: PANEL_W - PAD * 2 - 16 }, lineSpacing: 4,
    }).setOrigin(0.5, 0);
    this.root.add(body);

    const danger = !!opts.danger;
    const confirmLabel = opts.confirmLabel || 'YES';
    const cancelLabel  = opts.cancelLabel  || 'CANCEL';
    this._makeBtn(-90, PANEL_H / 2 - PAD - 22, cancelLabel, false, () => {
      this.opts.onCancel && this.opts.onCancel();
      this.close();
    });
    this._makeBtn(90, PANEL_H / 2 - PAD - 22, confirmLabel, danger, () => {
      this.opts.onConfirm && this.opts.onConfirm();
      this.close();
    });
  }

  _makeBtn(cx, cy, text, danger, onTap) {
    const w = 130, h = 38;
    const fillCol = danger ? 0xb02525 : 0x1a2332;
    const btn = this.scene.add.container(cx, cy);
    const bg = this.scene.add.graphics();
    bg.fillStyle(fillCol, 1);
    bg.lineStyle(1, fillCol, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 8);
    const label = this.scene.add.text(0, 0, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5);
    btn.add([bg, label]);
    const hit = this.scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); onTap(); });
    btn.add(hit);
    this.root.add(btn);
    return btn;
  }
}
