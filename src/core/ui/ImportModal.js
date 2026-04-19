// Level import dialog. Two input paths:
//
//   • Paste a share-string (base64 of the minified JSON; this is what
//     ExportPanel's COPY button produces) into the textarea, then tap
//     IMPORT FROM STRING.
//   • Tap IMPORT FROM FILE to open a file picker and load a `.json` export.
//
// On success, the caller's `onImport(level)` fires with the stamped level
// so CommunityScene can refresh its list. Errors render inline as a short
// status line at the bottom of the modal; the modal stays open so the user
// can retry or correct the input.

import { saveImported } from '../community.js';
import { TextInputOverlay } from './TextInputOverlay.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;

export class ImportModal {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {(level:object)=>void} [opts.onImport]
   * @param {()=>void} [opts.onClose]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts || {};
    this._build();
  }

  _build() {
    const { width, height } = this.scene.scale;
    this.shield = this.scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();

    const panelW = Math.min(520, width - 60);
    const panelH = 380;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.bg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.bg.fillStyle(PANEL_FILL, 1);
    this.bg.lineStyle(3, PANEL_STROKE, 1);
    this.bg.fillRoundedRect(px, py, panelW, panelH, 16);
    this.bg.strokeRoundedRect(px, py, panelW, panelH, 16);

    this.title = this.scene.add.text(width / 2, py + 30, 'IMPORT LEVEL', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    this.hint = this.scene.add.text(width / 2, py + 60,
      'Paste a share string or pick a JSON file.', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH).setAlpha(0.7);

    // Textarea for pasting share strings. `commitOnBlur:false` so clicking
    // the IMPORT FROM STRING button — which takes focus from the textarea
    // — doesn't fire a stale commit before we read the current value.
    const taX = px + 20;
    const taY = py + 90;
    const taW = panelW - 40;
    const taH = 110;
    this.textarea = new TextInputOverlay(this.scene, {
      x: taX + taW / 2, y: taY + taH / 2, width: taW, height: taH,
      value: '',
      placeholder: 'paste share string here (base64)',
      multiline: true,
      commitOnBlur: false,
      onCommit: () => {},
      onCancel: () => {},
    });

    const rowY = py + 230;
    this._stringBtn = this._actionButton(width / 2, rowY, 240, 40, 'IMPORT FROM STRING', () => this._importFromString());
    this._fileBtn   = this._actionButton(width / 2, rowY + 56, 240, 40, 'IMPORT FROM FILE', () => this._pickFile());

    this._closeButton = this._smallButton(px + panelW - 28, py + 28, 36, 28, 'X', () => this._close());

    this.status = this.scene.add.text(width / 2, py + panelH - 26, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
  }

  _actionButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, 0x3b66b8, 1)
      .setStrokeStyle(2, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerover', () => rect.setFillStyle(0x4a76c8, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0x3b66b8, 1));
    rect.on('pointerup', onTap);
    return { rect, text };
  }

  _smallButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, 0x223047, 1)
      .setStrokeStyle(1, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerup', onTap);
    return { rect, text };
  }

  async _importFromString() {
    const raw = (this.textarea && this.textarea.input) ? this.textarea.input.value : '';
    const trimmed = (raw || '').trim();
    if (!trimmed) { this._setStatus('Paste a share string first.'); return; }
    let parsed;
    try {
      parsed = decodeShareString(trimmed);
    } catch (e) {
      this._setStatus('Share string is not valid (not base64 or not JSON).');
      return;
    }
    if (!isValidLevelShape(parsed)) {
      this._setStatus('Decoded payload is not a Blockyard level.');
      return;
    }
    const stamped = await saveImported(parsed);
    this._setStatus(`Imported "${stamped.name || 'untitled'}"`);
    if (this.opts.onImport) this.opts.onImport(stamped);
    this._close();
  }

  _pickFile() {
    if (this._fileInput && this._fileInput.parentNode) {
      this._fileInput.parentNode.removeChild(this._fileInput);
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.addEventListener('change', () => this._onFileChosen(input));
    document.body.appendChild(input);
    this._fileInput = input;
    input.click();
  }

  async _onFileChosen(input) {
    const file = input.files && input.files[0];
    if (input.parentNode) input.parentNode.removeChild(input);
    this._fileInput = null;
    if (!file) return;
    const text = await file.text().catch(() => null);
    if (!text) { this._setStatus('Could not read file.'); return; }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { this._setStatus('Invalid JSON file.'); return; }
    if (!isValidLevelShape(parsed)) { this._setStatus('Not a Blockyard level.'); return; }
    const stamped = await saveImported(parsed);
    this._setStatus(`Imported "${stamped.name || 'untitled'}"`);
    if (this.opts.onImport) this.opts.onImport(stamped);
    this._close();
  }

  _setStatus(msg) {
    if (this.status) this.status.setText(msg);
  }

  _close() {
    this.destroy();
    if (this.opts.onClose) this.opts.onClose();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.textarea) { this.textarea.destroy(); this.textarea = null; }
    if (this._fileInput && this._fileInput.parentNode) {
      this._fileInput.parentNode.removeChild(this._fileInput);
      this._fileInput = null;
    }
    this.shield.destroy();
    this.bg.destroy();
    this.title.destroy();
    this.hint.destroy();
    this.status.destroy();
    for (const b of [this._stringBtn, this._fileBtn, this._closeButton]) {
      if (b) { b.rect.destroy(); b.text.destroy(); }
    }
  }
}

// Accepts both raw JSON (for users who paste the full file contents) and
// base64-encoded JSON (what ExportPanel's COPY button produces). The b64
// payload is chunked across multiple lines for readability in the share
// box — we strip whitespace here so the round-trip works transparently.
function decodeShareString(s) {
  const trimmed = s.trim();
  // Heuristic: JSON objects start with `{`; anything else is treated as b64.
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const b64 = trimmed.replace(/\s+/g, '');
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const utf8 = decodeURIComponent(escape(bin));
  return JSON.parse(utf8);
}

function isValidLevelShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.board || typeof obj.board.cols !== 'number' || typeof obj.board.rows !== 'number') return false;
  if (!Array.isArray(obj.inputs)  && !Array.isArray(obj.outputs) && !obj.border) return false;
  return true;
}
