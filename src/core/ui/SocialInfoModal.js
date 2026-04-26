// Generic title + body modal used by the home screen's social cards
// (Ethereum / Playables / Thank you cards). Visual vocabulary mirrors
// CreditsModal: shield + rounded white panel + dark stroke.
//
//   new SocialInfoModal(scene, { title, body, onClose });

import { addDomDim } from './DomDim.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';
const BODY_COLOR   = '#3a4555';

export class SocialInfoModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._closed = false;
    this._onClose = opts.onClose || null;

    const { width, height } = scene.scale;
    const panelW = Math.min(500, width - 60);

    // Layout chrome — header (title) and footer (close button + padding)
    // bracket a variable-height body. The panel sizes to fit the body
    // exactly so long copy (the Thank you / YouTube Playables blurbs) no
    // longer overflows. A floor keeps short modals from looking cramped,
    // and a ceiling keeps the panel inside the viewport on small screens.
    const TITLE_TOP   = 38;       // title baseline-ish from panel top
    const BODY_TOP    = 88;       // body top from panel top
    const BODY_BOTTOM_GAP = 26;   // body bottom → button center
    const BUTTON_BOTTOM_PAD = 22; // button center → panel bottom
    const BUTTON_H = 46;
    const PANEL_H_MIN = 280;
    const PANEL_H_MAX = height - 60;

    const bodyW = panelW - 56;
    const bodyStyle = {
      fontFamily: 'system-ui, sans-serif', fontSize: '19px',
      color: BODY_COLOR,
      wordWrap: { width: bodyW, useAdvancedWrap: true },
      align: 'left',
      lineSpacing: 6,
    };

    // Measurement pass — render the body off-screen to learn its wrapped
    // height, then destroy. Lets us size the panel before adding the real
    // body so the final scene-order is shield → panel → title → body →
    // button (no depth tricks). Phaser computes Text.height inside the
    // constructor, so this single off-screen text is enough.
    const measure = scene.add.text(-9999, -9999, opts.body || '', bodyStyle);
    const bodyH = Math.ceil(measure.height) || 0;
    measure.destroy();

    const desiredH = BODY_TOP + bodyH + BODY_BOTTOM_GAP + BUTTON_H / 2 + BUTTON_BOTTOM_PAD;
    const panelH = Math.max(PANEL_H_MIN, Math.min(PANEL_H_MAX, desiredH));
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this._domDim = addDomDim({ alpha: 0.55 });
    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerup', () => this._finish());

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + TITLE_TOP, opts.title || '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '26px', fontStyle: 'bold',
      color: TITLE_COLOR, align: 'center',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    this.body = scene.add.text(width / 2, py + BODY_TOP, opts.body || '', bodyStyle)
      .setOrigin(0.5, 0)
      .setDepth(PANEL_DEPTH);

    const buttonY = py + panelH - (BUTTON_H / 2 + BUTTON_BOTTOM_PAD);
    this.closeBtn = this._button(width / 2, buttonY, 150, BUTTON_H, 'CLOSE', () => this._finish());
  }

  _button(cx, cy, w, h, label, onTap) {
    const scene = this.scene;
    const container = scene.add.container(cx, cy).setDepth(PANEL_DEPTH);
    const bg = scene.add.graphics();
    const drawBg = (bgFill) => {
      bg.clear();
      bg.fillStyle(bgFill, 1);
      bg.lineStyle(2, PANEL_STROKE, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
    };
    drawBg(0x9aa6b2);
    container.add(bg);
    const text = scene.add.text(0, 0, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    container.add(text);
    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    container.add(hit);
    hit.on('pointerover', () => drawBg(0xacb7c2));
    hit.on('pointerout',  () => drawBg(0x9aa6b2));
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      onTap();
    });
    return { container, bg, text, hit };
  }

  _finish() {
    if (this._closed) return;
    this._closed = true;
    try { this.shield.destroy(); } catch (e) {}
    try { this.panel.destroy(); } catch (e) {}
    try { this.title.destroy(); } catch (e) {}
    try { this.body.destroy(); } catch (e) {}
    try { this.closeBtn.container.destroy(true); } catch (e) {}
    try { if (this._domDim) this._domDim(); } catch (e) {}
    if (this._onClose) try { this._onClose(); } catch (e) {}
  }

  destroy() { this._finish(); }
}
