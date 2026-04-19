// Designer-mode SAVE dropdown. Anchored beneath the title-bar SAVE button;
// shield + clamped panel pattern borrowed from FunnelTypePicker.
//
// Three rows:
//   • Save Locally   — writes to community.local.<id>; prompts for an
//                      author handle the first time.
//   • Save Publicly  — saves locally + flips status to 'pending' via the
//                      adapter's publishLevel hook (real upload lands in H).
//   • Download JSON  — downloads a Blob of the current level via <a download>.

import { saveLocal, getAuthorHandle, setStatus } from '../community.js';
import { platform } from '../../platform/index.js';
import { AuthorPrompt } from './AuthorPrompt.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const ROW_FILL     = 0xffffff;
const ROW_HOVER    = 0xeef3fb;
const ROW_TEXT     = '#1a2332';

const ROWS = [
  { key: 'local',    label: 'Save Locally'  },
  { key: 'public',   label: 'Save Publicly' },
  { key: 'download', label: 'Download JSON' },
];

export class SaveMenu {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x   anchor x (top-left of dropdown)
   * @param {number} opts.y   anchor y (top of dropdown — drops downward)
   * @param {object} opts.level   live level object to save (mutated id/status reflected back via onAfterSave)
   * @param {(stamped:object)=>void} [opts.onAfterSave]
   * @param {()=>void} [opts.onClose]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;

    const { width, height } = scene.scale;
    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerdown', () => this.close());

    const panelW = 220, rowH = 44, pad = 8;
    const panelH = ROWS.length * rowH + pad * 2;
    // Clamp so the panel never falls off-canvas.
    const px = Math.max(8, Math.min(width - panelW - 8, opts.x));
    const py = Math.max(8, Math.min(height - panelH - 8, opts.y));
    this._panelRect = { px, py, panelW, panelH };

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(2, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 12);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 12);

    this.rows = [];
    ROWS.forEach((row, i) => {
      const cy = py + pad + rowH / 2 + i * rowH;
      const rect = scene.add.rectangle(px + panelW / 2, cy, panelW - pad * 2, rowH - 4, ROW_FILL, 1)
        .setStrokeStyle(1, PANEL_STROKE, 0.4)
        .setInteractive({ useHandCursor: true })
        .setDepth(PANEL_DEPTH);
      const text = scene.add.text(px + panelW / 2, cy, row.label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
        color: ROW_TEXT,
      }).setOrigin(0.5).setDepth(PANEL_DEPTH);
      rect.on('pointerover', () => rect.setFillStyle(ROW_HOVER, 1));
      rect.on('pointerout',  () => rect.setFillStyle(ROW_FILL, 1));
      rect.on('pointerup', () => this._handle(row.key));
      this.rows.push({ rect, text });
    });
  }

  async _handle(key) {
    switch (key) {
      case 'local':    await this._saveLocally(); break;
      case 'public':   await this._savePublicly(); break;
      case 'download': this._downloadJson(); break;
    }
    this.close();
  }

  async _saveLocally() {
    const handle = await getAuthorHandle();
    if (!handle) {
      this._authorPrompt = new AuthorPrompt(this.scene, {
        onCommit: async () => {
          this._authorPrompt = null;
          await this._doLocalSave();
        },
        onCancel: () => { this._authorPrompt = null; },
      });
    } else {
      await this._doLocalSave();
    }
  }

  async _doLocalSave() {
    const stamped = await saveLocal(this.opts.level);
    if (this.opts.onAfterSave) this.opts.onAfterSave(stamped);
  }

  async _savePublicly() {
    const handle = await getAuthorHandle();
    if (!handle) {
      this._authorPrompt = new AuthorPrompt(this.scene, {
        onCommit: async () => {
          this._authorPrompt = null;
          await this._doPublicSave();
        },
        onCancel: () => { this._authorPrompt = null; },
      });
    } else {
      await this._doPublicSave();
    }
  }

  async _doPublicSave() {
    const stamped = await saveLocal(this.opts.level);
    const accepted = await platform.publishLevel(stamped);
    if (accepted) {
      const updated = await setStatus(stamped.id, 'pending');
      if (this.opts.onAfterSave) this.opts.onAfterSave(updated || stamped);
    } else if (this.opts.onAfterSave) {
      this.opts.onAfterSave(stamped);
    }
  }

  _downloadJson() {
    try {
      const blob = new Blob([JSON.stringify(this.opts.level, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = ((this.opts.level.name || 'level') + '').replace(/[^a-z0-9-_]+/gi, '_');
      a.href = url;
      a.download = `${safeName}.blockyard.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn('[SaveMenu] download failed', e);
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._authorPrompt) { this._authorPrompt.destroy(); this._authorPrompt = null; }
    this.shield.destroy();
    this.panel.destroy();
    for (const { rect, text } of this.rows) { rect.destroy(); text.destroy(); }
    if (this.opts.onClose) this.opts.onClose();
  }
}
