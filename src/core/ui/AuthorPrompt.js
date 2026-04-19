// One-time modal that captures the author's display handle. Shown the
// first time a user saves or publishes a community level. Persisted via
// `community.setAuthorHandle` so subsequent saves skip this prompt.

import { TextInputOverlay } from './TextInputOverlay.js';
import { setAuthorHandle } from '../community.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;

export class AuthorPrompt {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {string} [opts.initial='']
   * @param {(handle:string)=>void} opts.onCommit  fires with persisted handle
   * @param {()=>void} [opts.onCancel]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;

    const { width, height } = scene.scale;
    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerdown', () => this._cancel());

    const panelW = Math.min(480, width - 80);
    const panelH = 240;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 16);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 16);

    this.title = scene.add.text(width / 2, py + 36, 'PICK A HANDLE', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    this.subtitle = scene.add.text(width / 2, py + 66,
      'Shown next to levels you publish. Stays on this device.', {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH).setAlpha(0.7);

    this.input = new TextInputOverlay(scene, {
      x: width / 2, y: py + 120, width: panelW - 60, height: 40,
      value: opts.initial || '',
      placeholder: 'your handle',
      maxLength: 24,
      onCommit: (v) => this._submit(v),
      onCancel: () => this._cancel(),
    });

    // Confirm button beneath the input — tapping commits the input value.
    const buttonW = 160, buttonH = 44;
    const buttonY = py + panelH - 50;
    this.button = scene.add.rectangle(width / 2, buttonY, buttonW, buttonH, 0x3b66b8, 1)
      .setStrokeStyle(2, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    this.buttonText = scene.add.text(width / 2, buttonY, 'CONFIRM', {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    this.button.on('pointerover', () => this.button.setFillStyle(0x4a76c8, 1));
    this.button.on('pointerout',  () => this.button.setFillStyle(0x3b66b8, 1));
    this.button.on('pointerup', () => {
      const v = this.input && this.input.input ? this.input.input.value : '';
      this._submit(v);
    });
  }

  async _submit(value) {
    const handle = (value || '').trim();
    if (!handle) { this._cancel(); return; }
    const saved = await setAuthorHandle(handle);
    this.destroy();
    if (this.opts.onCommit) this.opts.onCommit(saved);
  }

  _cancel() {
    this.destroy();
    if (this.opts.onCancel) this.opts.onCancel();
  }

  destroy() {
    if (this.input) { this.input.destroy(); this.input = null; }
    this.shield.destroy();
    this.panel.destroy();
    this.title.destroy();
    this.subtitle.destroy();
    this.button.destroy();
    this.buttonText.destroy();
  }
}
