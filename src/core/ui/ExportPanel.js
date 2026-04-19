// Final export step. Shown after the user has set up the blueprint (every
// solution factory is placed in a unique slot). Lets them name the level,
// see the author handle, copy a compact share-string, download a JSON file,
// save to the in-app community library, or publish (status -> 'pending').

import { TextInputOverlay } from './TextInputOverlay.js';
import { saveLocal, getAuthorHandle, setStatus, setAuthorHandle } from '../community.js';
import { AuthorPrompt } from './AuthorPrompt.js';
import { platform } from '../../platform/index.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;

export class ExportPanel {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {object} opts.level   the level snapshot to export (already includes
   *                              initialFactories + solution + border + io)
   * @param {(stamped:object)=>void} [opts.onSaved]  fires after a save / publish
   * @param {()=>void} [opts.onClose]
   * @param {()=>void} [opts.onEditMore]  returns the user to design mode — the
   *                                      caller should exit blueprint-setup.
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.level = opts.level;
    this._labels = [];  // every _addText gets tracked here for destroy()
    this._build();
    this._refreshAuthor();
  }

  _build() {
    const { width, height } = this.scene.scale;

    this.shield = this.scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();

    const panelW = Math.min(560, width - 60);
    const panelH = 460;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;
    this._panel = { px, py, panelW, panelH };

    this.bg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.bg.fillStyle(PANEL_FILL, 1);
    this.bg.lineStyle(3, PANEL_STROKE, 1);
    this.bg.fillRoundedRect(px, py, panelW, panelH, 16);
    this.bg.strokeRoundedRect(px, py, panelW, panelH, 16);

    this._addText(width / 2, py + 30, 'EXPORT LEVEL', '24px', 'bold', '#1a2332');

    // Name row.
    this._addText(px + 20, py + 78, 'NAME', '12px', 'bold', '#1a2332', 0, 0.5);
    this.nameDisplay = this.scene.add.text(px + 90, py + 78, this.level.name || 'untitled', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0, 0.5).setDepth(PANEL_DEPTH);
    this.nameEdit = this._smallButton(px + panelW - 90, py + 78, 60, 28, 'EDIT', () => this._editName());

    // Author row.
    this._addText(px + 20, py + 118, 'AUTHOR', '12px', 'bold', '#1a2332', 0, 0.5);
    this.authorDisplay = this.scene.add.text(px + 90, py + 118, '\u2014', {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', color: '#1a2332',
    }).setOrigin(0, 0.5).setDepth(PANEL_DEPTH);
    this.authorEdit = this._smallButton(px + panelW - 90, py + 118, 60, 28, 'EDIT', () => this._editAuthor());

    // Share string row.
    this._addText(px + 20, py + 158, 'SHARE STRING', '12px', 'bold', '#1a2332', 0, 0.5);
    const shareBoxX = px + 20, shareBoxY = py + 178, shareBoxW = panelW - 40, shareBoxH = 80;
    this.shareBg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.shareBg.fillStyle(0xeef3fb, 1);
    this.shareBg.lineStyle(1, PANEL_STROKE, 0.6);
    this.shareBg.fillRoundedRect(shareBoxX, shareBoxY, shareBoxW, shareBoxH, 8);
    this.shareBg.strokeRoundedRect(shareBoxX, shareBoxY, shareBoxW, shareBoxH, 8);
    const shareText = this._encodeShareString(this.level);
    this.shareLabel = this.scene.add.text(shareBoxX + 8, shareBoxY + 8,
      truncate(shareText, 220), {
      fontFamily: 'monospace', fontSize: '11px', color: '#1a2332',
      wordWrap: { width: shareBoxW - 16 },
    }).setOrigin(0, 0).setDepth(PANEL_DEPTH);
    this._shareString = shareText;
    this.copyBtn = this._smallButton(px + panelW - 70, shareBoxY + shareBoxH - 18, 100, 28, 'COPY', () => this._copyShare());

    // Action row. Export actions (Download/Save/Publish) sit in the main
    // row, EDIT MORE sits just above in a dimmer style so it's clearly a
    // "rewind" option rather than an export destination.
    const actionY = py + panelH - 90;
    const actionW = 130, actionH = 40, gap = 12;
    const totalW = actionW * 3 + gap * 2;
    const startX = px + (panelW - totalW) / 2;
    this._actions = [
      this._actionButton(startX + actionW / 2,                       actionY, actionW, actionH, 'DOWNLOAD JSON', () => this._downloadJson()),
      this._actionButton(startX + actionW + gap + actionW / 2,       actionY, actionW, actionH, 'SAVE TO LIBRARY', () => this._saveToLibrary()),
      this._actionButton(startX + (actionW + gap) * 2 + actionW / 2, actionY, actionW, actionH, 'PUBLISH',         () => this._publish()),
    ];
    // EDIT MORE — returns to pre-blueprint design mode. Only shown when a
    // handler is provided (exit logic lives in EditorScene).
    if (this.opts.onEditMore) {
      this._editMoreBtn = this._secondaryButton(
        px + 100, actionY - 54, 160, 34, '\u2190 EDIT MORE',
        () => { const cb = this.opts.onEditMore; this._close(); cb(); },
      );
    }

    this._closeButton = this._smallButton(px + panelW - 28, py + 28, 36, 28, 'X', () => this._close());

    // Status text shown after save/publish.
    this.status = this.scene.add.text(width / 2, py + panelH - 32, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
  }

  _addText(x, y, text, size, weight, color, ox = 0.5, oy = 0.5) {
    const t = this.scene.add.text(x, y, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: size, fontStyle: weight,
      color,
    }).setOrigin(ox, oy).setDepth(PANEL_DEPTH);
    this._labels.push(t);
    return t;
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
    rect.on('pointerover', () => rect.setFillStyle(0x2a3b55, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0x223047, 1));
    rect.on('pointerup', onTap);
    return { rect, text };
  }

  _actionButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, 0x3b66b8, 1)
      .setStrokeStyle(2, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerover', () => rect.setFillStyle(0x4a76c8, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0x3b66b8, 1));
    rect.on('pointerup', onTap);
    return { rect, text };
  }

  // Muted button style — used for EDIT MORE which rewinds the flow rather
  // than committing an export action.
  _secondaryButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, 0xe6edf5, 1)
      .setStrokeStyle(1, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerover', () => rect.setFillStyle(0xd6dfea, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0xe6edf5, 1));
    rect.on('pointerup', onTap);
    return { rect, text };
  }

  async _refreshAuthor() {
    const handle = await getAuthorHandle();
    if (this.authorDisplay) this.authorDisplay.setText(handle || 'anonymous');
    if (handle && !this.level.author) this.level.author = handle;
  }

  _editName() {
    if (this._nameInput) { this._nameInput.destroy(); this._nameInput = null; }
    const lx = this.nameDisplay.x + 80;
    const ly = this.nameDisplay.y;
    this._nameInput = new TextInputOverlay(this.scene, {
      x: lx, y: ly, width: 280, height: 30,
      value: this.level.name || '',
      placeholder: 'level name',
      maxLength: 32,
      onCommit: (v) => {
        const name = (v || '').trim() || 'untitled';
        this.level.name = name;
        this.nameDisplay.setText(name);
        this._refreshShareString();
        this._nameInput = null;
      },
      onCancel: () => { this._nameInput = null; },
    });
  }

  _editAuthor() {
    if (this._authorPrompt) { this._authorPrompt.destroy(); this._authorPrompt = null; }
    this._authorPrompt = new AuthorPrompt(this.scene, {
      onCommit: async (handle) => {
        await setAuthorHandle(handle);
        this.level.author = handle;
        if (this.authorDisplay) this.authorDisplay.setText(handle || 'anonymous');
        this._refreshShareString();
        this._authorPrompt = null;
      },
      onCancel: () => { this._authorPrompt = null; },
    });
  }

  _refreshShareString() {
    const s = this._encodeShareString(this.level);
    this._shareString = s;
    if (this.shareLabel) this.shareLabel.setText(truncate(s, 220));
  }

  _encodeShareString(level) {
    // Compact: minified JSON minus the local-only `likes` field, base64-encoded.
    // The receiving side decodes, reassigns id, and calls saveImported.
    const stripped = { ...level };
    delete stripped.likes;
    delete stripped.updatedAt;
    delete stripped.importedAt;
    const json = JSON.stringify(stripped);
    let b64;
    try {
      // btoa needs ASCII; encode UTF-8 first.
      // eslint-disable-next-line no-undef
      const utf8 = unescape(encodeURIComponent(json));
      // eslint-disable-next-line no-undef
      b64 = btoa(utf8);
    } catch (e) {
      b64 = json;            // fallback to raw JSON in non-browser hosts
    }
    // Chunk every 60 chars so the base64 wraps inside the share-box. Both
    // Phaser's text and an HTML textarea render the embedded newlines as
    // real line breaks. ImportModal's decoder strips whitespace before b64
    // decoding, so the newlines round-trip cleanly.
    return chunk(b64, 60);
  }

  _copyShare() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this._shareString);
      } else {
        const ta = document.createElement('textarea');
        ta.value = this._shareString;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      this._setStatus('Copied share string to clipboard');
    } catch (e) {
      this._setStatus('Copy failed: ' + e.message);
    }
  }

  _downloadJson() {
    if (!this._boardSizeOk()) return;
    try {
      // File export INCLUDES likes (for backend) but starts at 0 locally.
      const exportLevel = { ...this.level, likes: this.level.likes || 0 };
      const blob = new Blob([JSON.stringify(exportLevel, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = ((this.level.name || 'level') + '').replace(/[^a-z0-9-_]+/gi, '_');
      a.href = url;
      a.download = `${safe}.blockyard.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._setStatus('Downloaded ' + a.download);
    } catch (e) {
      this._setStatus('Download failed: ' + e.message);
    }
  }

  async _saveToLibrary() {
    if (!this._boardSizeOk()) return;
    const handle = await getAuthorHandle();
    if (!handle) { this._editAuthor(); return; }
    const stamped = await saveLocal(this.level);
    Object.assign(this.level, { id: stamped.id, status: stamped.status, author: stamped.author });
    this._setStatus(`Saved to library (status: ${stamped.status})`);
    if (this.opts.onSaved) this.opts.onSaved(stamped);
  }

  async _publish() {
    if (!this._boardSizeOk()) return;
    const handle = await getAuthorHandle();
    if (!handle) { this._editAuthor(); return; }
    const stamped = await saveLocal(this.level);
    const accepted = await platform.publishLevel(stamped);
    let final = stamped;
    if (accepted) final = (await setStatus(stamped.id, 'pending')) || stamped;
    Object.assign(this.level, { id: final.id, status: final.status, author: final.author });
    this._setStatus(accepted ? 'Submitted \u2014 status: pending mod review' : 'Saved (publish stub returned false)');
    if (this.opts.onSaved) this.opts.onSaved(final);
  }

  _setStatus(msg) {
    if (this.status) this.status.setText(msg);
  }

  // Guard every save/publish/download path — the share string has to round-
  // trip the level size, so refuse to write anything when `board.{cols,rows}`
  // is missing or garbage. Falls through (returns true) in the healthy case.
  _boardSizeOk() {
    const b = this.level && this.level.board;
    const cols = b && b.cols;
    const rows = b && b.rows;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      this._setStatus('Refusing to save \u2014 level is missing board size.');
      return false;
    }
    return true;
  }

  _close() {
    this.destroy();
    if (this.opts.onClose) this.opts.onClose();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._nameInput)   { this._nameInput.destroy(); this._nameInput = null; }
    if (this._authorPrompt) { this._authorPrompt.destroy(); this._authorPrompt = null; }
    this.shield.destroy();
    this.bg.destroy();
    this.nameDisplay.destroy();
    this.authorDisplay.destroy();
    this.shareBg.destroy();
    this.shareLabel.destroy();
    this.status.destroy();
    // Headings / section labels added via _addText aren't tracked per-field
    // — they accumulate in `this._labels`. Without this loop they'd stick
    // around on the scene after close as ghost text.
    for (const t of this._labels) { if (t) t.destroy(); }
    this._labels.length = 0;
    const all = [this.nameEdit, this.authorEdit, this.copyBtn, this._closeButton, this._editMoreBtn, ...(this._actions || [])];
    for (const b of all) {
      if (b) { b.rect.destroy(); b.text.destroy(); }
    }
  }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + '...';
}

function chunk(s, size) {
  if (!s) return s;
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.join('\n');
}
