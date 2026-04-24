// Credits modal — lists the guest designers / sound designers / QA
// testers, each with a tappable name that opens their itch.io page.
// Shares the visual vocabulary of SettingsModal (shield + rounded
// panel + 1a2332 stroke).
//
//   new CreditsModal(scene, { onClose });

import { platform } from '../../platform/index.js';
import { addDomDim } from './DomDim.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';
const LINK_COLOR   = '#2e6fb8';
const ROLE_COLOR   = '#485566';

const CREDITS = [
  {
    name: 'p4songer',
    url:  'https://p4songer.itch.io/',
    role: 'Level design, QA testing',
  },
  {
    name: 'JayTeaGibs',
    url:  'https://jayteagibs-gamejams.itch.io/',
    role: 'Level design, sound design, QA testing',
  },
];

export class CreditsModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._closed = false;
    this._onClose = opts.onClose || null;
    this._texts = [];
    this._hits  = [];

    const { width, height } = scene.scale;
    const panelW = Math.min(460, width - 60);
    const panelH = 400;
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

    this.title = scene.add.text(width / 2, py + 40, 'GUEST DESIGNERS', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    this._texts.push(this.title);

    // Each credit: a tappable name (underlined, link-colored) followed
    // by a role line in a softer grey directly below.
    const entryStartY = py + 100;
    const entryGapY   = 110;
    for (let i = 0; i < CREDITS.length; i++) {
      this._drawCredit(width / 2, entryStartY + i * entryGapY, CREDITS[i]);
    }

    const buttonY = py + panelH - 44;
    this.closeBtn = this._button(width / 2, buttonY, 150, 46, 'CLOSE', () => this._finish());
  }

  _drawCredit(cx, cy, entry) {
    const scene = this.scene;

    const name = scene.add.text(cx, cy, entry.name, {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: LINK_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    this._texts.push(name);

    // Phaser text doesn't underline directly — draw a thin rule under
    // the name to sell the link affordance.
    const under = scene.add.graphics().setDepth(PANEL_DEPTH);
    under.lineStyle(2, 0x2e6fb8, 1);
    const nameW = name.width;
    under.lineBetween(cx - nameW / 2, cy + name.height / 2 + 2, cx + nameW / 2, cy + name.height / 2 + 2);
    this._texts.push(under);

    const role = scene.add.text(cx, cy + 34, entry.role, {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px',
      color: ROLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    this._texts.push(role);

    const hitW = Math.max(nameW + 40, 180);
    const hitH = name.height + 12;
    const hit = scene.add.rectangle(cx, cy, hitW, hitH, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      try { platform.openExternal(entry.url); } catch (err) { console.warn('[credits] open failed', err); }
    });
    this._hits.push(hit);
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
    this.destroy();
    if (this._onClose) this._onClose();
  }

  destroy() {
    if (this._domDim) { try { this._domDim(); } catch (e) {} this._domDim = null; }
    if (this.shield)  { try { this.shield.destroy(); } catch (e) {} this.shield = null; }
    if (this.panel)   { try { this.panel.destroy();  } catch (e) {} this.panel  = null; }
    for (const t of this._texts) { try { t.destroy(); } catch (e) {} }
    this._texts = [];
    for (const h of this._hits)  { try { h.destroy(); } catch (e) {} }
    this._hits  = [];
    if (this.closeBtn) {
      try { this.closeBtn.container.destroy(true); } catch (e) {}
      this.closeBtn = null;
    }
  }
}
