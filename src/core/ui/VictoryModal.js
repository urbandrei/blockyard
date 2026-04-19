// Modal shown when every output funnel has been satisfied at least once.
// Three buttons — Next / Retry / Level Select — each fired via callbacks.
// Lives on a high depth above all gameplay; a translucent shield blocks taps
// from reaching the board behind it.

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';

export class VictoryModal {
  constructor(scene, { onNext, onRetry, onLevelSelect, hasNext = true }) {
    this.scene = scene;
    const { width, height } = scene.scale;

    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();

    const panelW = Math.min(520, width - 80);
    const panelH = 360;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + 60, 'VICTORY', {
      fontFamily: 'system-ui, sans-serif', fontSize: '48px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    this.subtitle = scene.add.text(width / 2, py + 110, 'all outputs satisfied', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH).setAlpha(0.7);

    this.buttons = [];
    const buttonY = py + panelH - 70;
    const buttonW = 140, buttonH = 56, gap = 16;
    const totalW = buttonW * 3 + gap * 2;
    const startX = width / 2 - totalW / 2;

    const cbs = [
      { label: 'NEXT',         onTap: onNext,        enabled: hasNext },
      { label: 'RETRY',        onTap: onRetry,       enabled: true },
      { label: 'LEVEL SELECT', onTap: onLevelSelect, enabled: true },
    ];
    cbs.forEach((c, i) => {
      const bx = startX + i * (buttonW + gap) + buttonW / 2;
      this.buttons.push(this._button(bx, buttonY, buttonW, buttonH, c.label, c.onTap, c.enabled));
    });
  }

  _button(cx, cy, w, h, label, onTap, enabled) {
    const fill = enabled ? 0x3b66b8 : 0x9aa6b2;
    const rect = this.scene.add.rectangle(cx, cy, w, h, fill, 1)
      .setStrokeStyle(2, PANEL_STROKE, 1)
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    if (enabled && onTap) {
      rect.setInteractive({ useHandCursor: true });
      rect.on('pointerup', onTap);
      rect.on('pointerover', () => rect.setFillStyle(0x4a76c8, 1));
      rect.on('pointerout',  () => rect.setFillStyle(fill, 1));
    }
    return { rect, text };
  }

  destroy() {
    this.shield.destroy();
    this.panel.destroy();
    this.title.destroy();
    this.subtitle.destroy();
    for (const b of this.buttons) { b.rect.destroy(); b.text.destroy(); }
  }
}
