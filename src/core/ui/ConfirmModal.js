// Reusable confirm-vs-cancel modal. Shares the visual vocabulary of
// HintConfirmModal / VictoryModal (shield + rounded panel + two buttons)
// so any destructive-action flow reads the same as the rest of the UI.
//
// new ConfirmModal(scene, {
//   title: 'DELETE LEVEL?',
//   message: 'This cannot be undone.',
//   confirmLabel: 'DELETE',
//   cancelLabel:  'CANCEL',
//   destructive:  true,           // confirm button becomes red
//   onConfirm, onCancel,
// });

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';
const MSG_COLOR    = '#485566';

const CANCEL_FILL    = 0x9aa6b2;
const CANCEL_HOVER   = 0xacb7c2;
const CONFIRM_FILL   = 0x3fa65a;
const CONFIRM_HOVER  = 0x4fc072;
const DESTRUCTIVE    = 0xd94c4c;
const DESTRUCTIVE_H  = 0xe46060;

export class ConfirmModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._closed = false;
    const title        = opts.title        || 'ARE YOU SURE?';
    const message      = opts.message      || '';
    const confirmLabel = opts.confirmLabel || 'CONFIRM';
    const cancelLabel  = opts.cancelLabel  || 'CANCEL';
    const destructive  = !!opts.destructive;
    const { width, height } = scene.scale;

    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerup', () => this._finish(opts.onCancel));

    const panelW = Math.min(460, width - 60);
    const panelH = message ? 220 : 180;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + 44, title, {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    if (message) {
      this.message = scene.add.text(width / 2, py + 92, message, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px',
        color: MSG_COLOR, align: 'center', wordWrap: { width: panelW - 48 },
      }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    }

    const buttonY = py + panelH - 48;
    const buttonW = 150, buttonH = 50, gap = 18;
    const totalW = buttonW * 2 + gap;
    const startX = width / 2 - totalW / 2;

    const confirmFill = destructive ? DESTRUCTIVE : CONFIRM_FILL;
    const confirmHover = destructive ? DESTRUCTIVE_H : CONFIRM_HOVER;

    this.buttons = [
      this._button(startX + buttonW / 2, buttonY, buttonW, buttonH,
        cancelLabel, CANCEL_FILL, CANCEL_HOVER, () => this._finish(opts.onCancel)),
      this._button(startX + buttonW + gap + buttonW / 2, buttonY, buttonW, buttonH,
        confirmLabel, confirmFill, confirmHover, () => this._finish(opts.onConfirm)),
    ];
  }

  _button(cx, cy, w, h, label, fill, hoverFill, onTap) {
    const scene = this.scene;
    const radius = Math.min(16, Math.floor(h / 2));
    const container = scene.add.container(cx, cy).setDepth(PANEL_DEPTH);
    const drawBg = (bgFill) => {
      bg.clear();
      bg.fillStyle(bgFill, 1);
      bg.lineStyle(2, PANEL_STROKE, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, radius);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, radius);
    };
    const bg = scene.add.graphics();
    drawBg(fill);
    container.add(bg);
    const text = scene.add.text(0, 0, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    container.add(text);

    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    container.add(hit);

    hit.on('pointerover', () => {
      drawBg(hoverFill);
      scene.tweens.add({ targets: container, scaleX: 1.06, scaleY: 1.06, duration: 120, ease: 'Sine.Out' });
    });
    hit.on('pointerout', () => {
      drawBg(fill);
      scene.tweens.add({ targets: container, scaleX: 1, scaleY: 1, duration: 140, ease: 'Sine.Out' });
    });
    hit.on('pointerdown', () => {
      scene.tweens.add({ targets: container, scaleX: 0.92, scaleY: 0.92, duration: 70, ease: 'Sine.Out' });
    });
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      scene.tweens.add({
        targets: container, scaleX: 1.06, scaleY: 1.06,
        duration: 90, ease: 'Back.Out', onComplete: () => onTap(),
      });
    });
    return { container, bg, text, hit };
  }

  _finish(cb) {
    if (this._closed) return;
    this._closed = true;
    this.destroy();
    if (cb) cb();
  }

  destroy() {
    if (this.shield)  this.shield.destroy();
    if (this.panel)   this.panel.destroy();
    if (this.title)   this.title.destroy();
    if (this.message) this.message.destroy();
    for (const b of (this.buttons || [])) { b.container.destroy(true); }
    this.buttons = null;
  }
}
