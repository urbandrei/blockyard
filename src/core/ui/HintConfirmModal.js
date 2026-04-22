// Modal asking the player whether they want a hint. Cloned from the
// VictoryModal shape — shield + rounded panel with two buttons — so the
// visual vocabulary stays consistent with other in-game modals.

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';

export class HintConfirmModal {
  constructor(scene, { onConfirm, onCancel }) {
    this.scene = scene;
    this._closed = false;
    const { width, height } = scene.scale;

    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    // Tap outside = cancel.
    this.shield.on('pointerup', () => this._finish(onCancel));

    const panelW = Math.min(440, width - 80);
    const panelH = 180;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + 54, 'GET A HINT?', {
      fontFamily: 'system-ui, sans-serif', fontSize: '32px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    const buttonY = py + panelH - 48;
    const buttonW = 150, buttonH = 52, gap = 18;
    const totalW = buttonW * 2 + gap;
    const startX = width / 2 - totalW / 2;

    this.buttons = [];
    this.buttons.push(this._button(
      startX + buttonW / 2, buttonY, buttonW, buttonH,
      'CANCEL', 0x9aa6b2, 0xacb7c2, () => this._finish(onCancel),
    ));
    this.buttons.push(this._button(
      startX + buttonW + gap + buttonW / 2, buttonY, buttonW, buttonH,
      'YES', 0x3fa65a, 0x4fc072, () => this._finish(onConfirm),
    ));
  }

  _button(cx, cy, w, h, label, fill, hoverFill, onTap) {
    const scene = this.scene;
    const radius = Math.min(18, Math.floor(h / 2));
    // Container holds a rounded-rect Graphics + label. Scaling the
    // container gives us the hover/press juice without distorting the
    // stroke width (Graphics content is drawn at local 0,0).
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

    // Hover: fill lightens + subtle scale-up.
    hit.on('pointerover', () => {
      drawBg(hoverFill);
      scene.tweens.add({
        targets: container, scaleX: 1.06, scaleY: 1.06,
        duration: 120, ease: 'Sine.Out',
      });
    });
    hit.on('pointerout', () => {
      drawBg(fill);
      scene.tweens.add({
        targets: container, scaleX: 1, scaleY: 1,
        duration: 140, ease: 'Sine.Out',
      });
    });
    // Press: squeeze.
    hit.on('pointerdown', () => {
      scene.tweens.add({
        targets: container, scaleX: 0.92, scaleY: 0.92,
        duration: 70, ease: 'Sine.Out',
      });
    });
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      // Pop back, then fire the tap so the visual bounce is visible.
      scene.tweens.add({
        targets: container, scaleX: 1.06, scaleY: 1.06,
        duration: 90, ease: 'Back.Out',
        onComplete: () => onTap(),
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
    if (this.shield) this.shield.destroy();
    if (this.panel)  this.panel.destroy();
    if (this.title)  this.title.destroy();
    for (const b of (this.buttons || [])) { b.container.destroy(true); }
    this.buttons = null;
  }
}
