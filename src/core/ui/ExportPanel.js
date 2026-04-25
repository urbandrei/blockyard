// Final export step. Shown after the user has set up the blueprint (every
// solution factory is placed in a unique slot). Lets them name the level,
// see the author handle, copy a compact share-string, download a JSON file,
// save to the in-app community library, or publish (status -> 'pending').

import { TextInputOverlay } from './TextInputOverlay.js';
import { saveLocal, getAuthorHandle, setStatus, setAuthorHandle } from '../community.js';
import { AuthorPrompt } from './AuthorPrompt.js';
import { platform } from '../../platform/index.js';
import { copyText } from './clipboard.js';
import { shareLevel, canNativeShare, shareBaseForCurrentOrigin } from './socialShare.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;

// Layout constants — keeping everything aligned to a simple grid so rows
// stack predictably and the modal matches ImportModal's visual rhythm.
const PANEL_PAD       = 24;
const FIELD_ROW_H     = 44;
const FIELD_LABEL_X   = 0;    // relative to content-left
const FIELD_VALUE_X   = 88;
const EDIT_BTN_W      = 60;
const EDIT_BTN_H      = 28;
const SHARE_BOX_H     = 90;
const ACTION_BTN_W    = 150;
const ACTION_BTN_H    = 40;
const ACTION_GAP      = 12;
const SECONDARY_BTN_W = 280;
const SECONDARY_BTN_H = 34;
const DIVIDER_COLOR   = 0xdbe3ee;

// Append `?s=<code>` (or `?play=<b64>`) to a share base, handling both
// bare-host URLs and deeper paths (itch's user-page URL). Plain `?` is
// always correct since our bases never carry queries today.
function withShareParam(base, paramName, value) {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${paramName}=${encodeURIComponent(value)}`;
}

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

    // The wallet row only appears when the platform supports eth (web with
    // a deployed contract). Other targets keep the legacy 3-row form.
    this._walletEnabled = !!(platform && platform.ethEnabled);
    const extraRows = this._walletEnabled ? 1 : 0;

    const panelW = Math.min(560, width - 60);
    const panelH = 560 + extraRows * FIELD_ROW_H;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;
    this._panel = { px, py, panelW, panelH };

    // Content column — everything anchors off contentL / contentR so rows
    // stay aligned as the panel width varies with the viewport.
    const contentL = px + PANEL_PAD;
    const contentR = px + panelW - PANEL_PAD;
    const contentW = contentR - contentL;

    this.bg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.bg.fillStyle(PANEL_FILL, 1);
    this.bg.lineStyle(3, PANEL_STROKE, 1);
    this.bg.fillRoundedRect(px, py, panelW, panelH, 16);
    this.bg.strokeRoundedRect(px, py, panelW, panelH, 16);

    // --- header bar: title centered, close top-right ---
    this._addText(width / 2, py + 30, 'EXPORT LEVEL', '22px', 'bold', '#1a2332');
    this._closeButton = this._smallButton(contentR - 18, py + 30, 36, 28, 'X', () => this._close());

    // --- form rows (name / author / hint) ---
    const formY = py + 74;
    this._buildFieldRow(contentL, formY + FIELD_ROW_H * 0, contentW, 'NAME',
      () => this.level.name || 'untitled',
      (display) => { this.nameDisplay = display; },
      () => this._editName(),
      { valueStyle: { fontSize: '18px', fontStyle: 'bold' } });
    this._buildFieldRow(contentL, formY + FIELD_ROW_H * 1, contentW, 'AUTHOR',
      () => '\u2014',
      (display) => { this.authorDisplay = display; },
      () => this._editAuthor(),
      { valueStyle: { fontSize: '16px' } });

    // Wallet row (web + eth-enabled only). Sits between AUTHOR and HINT
    // because the wallet IS the on-chain author identity, so it reads
    // naturally as a sub-field of authorship.
    let walletRowOffset = 0;
    if (this._walletEnabled) {
      walletRowOffset = 1;
      this._buildFieldRow(contentL, formY + FIELD_ROW_H * 2, contentW, 'WALLET',
        () => 'not connected',
        (display) => { this.walletDisplay = display; },
        () => this._toggleWallet(),
        {
          valueStyle: { fontSize: '13px', fontFamily: 'monospace', color: '#6b7a8f' },
          editLabel: 'CONNECT',
          editKey: 'wallet',
        });
    }

    // Hint row — the instructional text that appears in the blueprint's
    // top slot at play time. Blank = no hint (top slot stays open).
    // Disabled whenever an initial factory occupies slot row 0, because
    // the hint pill and a top-row factory can't coexist in the same cell.
    this._topRowBlocked = this._hasTopRowFactory();
    const hintColor = this._topRowBlocked
      ? '#a01010'
      : (this.level.instructionalText ? '#1a2332' : '#6b7a8f');
    this._buildFieldRow(contentL, formY + FIELD_ROW_H * (2 + walletRowOffset), contentW, 'HINT',
      () => this._hintDisplayText(),
      (display) => { this.hintDisplay = display; },
      () => { if (!this._topRowBlocked) this._editHint(); },
      {
        valueStyle: { fontSize: '14px', color: hintColor, wordWrap: { width: contentW - FIELD_VALUE_X - EDIT_BTN_W - 16 } },
        disabled: this._topRowBlocked,
      });

    // --- divider ---
    const dividerY = formY + FIELD_ROW_H * (3 + walletRowOffset) + 8;
    this._drawDivider(contentL, dividerY, contentW);

    // --- share string box with COPY button inline in the header ---
    const shareHeaderY = dividerY + 22;
    this._addText(contentL, shareHeaderY, 'SHARE STRING', '12px', 'bold', '#1a2332', 0, 0.5);
    this.copyBtn = this._smallButton(contentR - EDIT_BTN_W / 2, shareHeaderY, EDIT_BTN_W, EDIT_BTN_H, 'COPY', () => this._copyShare());

    const shareBoxY = shareHeaderY + 20;
    this.shareBg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.shareBg.fillStyle(0xeef3fb, 1);
    this.shareBg.lineStyle(1, PANEL_STROKE, 0.6);
    this.shareBg.fillRoundedRect(contentL, shareBoxY, contentW, SHARE_BOX_H, 8);
    this.shareBg.strokeRoundedRect(contentL, shareBoxY, contentW, SHARE_BOX_H, 8);
    const shareText = this._encodeShareString(this.level);
    this.shareLabel = this.scene.add.text(contentL + 10, shareBoxY + 10,
      truncate(shareText, 240), {
      fontFamily: 'monospace', fontSize: '11px', color: '#1a2332',
      wordWrap: { width: contentW - 20 },
    }).setOrigin(0, 0).setDepth(PANEL_DEPTH);
    this._shareString = shareText;

    // --- divider between share-string and actions ---
    const dividerY2 = shareBoxY + SHARE_BOX_H + 20;
    this._drawDivider(contentL, dividerY2, contentW);

    // --- primary action row: DOWNLOAD / SAVE / PUBLISH ---
    const actionRowY = dividerY2 + 32;
    const actionsTotalW = ACTION_BTN_W * 3 + ACTION_GAP * 2;
    const actionsStartX = px + (panelW - actionsTotalW) / 2;
    this._actions = [
      this._actionButton(actionsStartX + ACTION_BTN_W / 2,                          actionRowY, ACTION_BTN_W, ACTION_BTN_H, 'DOWNLOAD JSON',   () => this._downloadJson()),
      this._actionButton(actionsStartX + ACTION_BTN_W + ACTION_GAP + ACTION_BTN_W / 2, actionRowY, ACTION_BTN_W, ACTION_BTN_H, 'SAVE TO LIBRARY', () => this._saveToLibrary()),
      this._actionButton(actionsStartX + (ACTION_BTN_W + ACTION_GAP) * 2 + ACTION_BTN_W / 2, actionRowY, ACTION_BTN_W, ACTION_BTN_H, 'PUBLISH',       () => this._publish()),
    ];

    // --- secondary row: EDIT MORE (optional) + COPY LINK + SHARE ---
    // Button count can be 2 or 3; width shrinks so everything fits in the
    // same row without spilling past the panel's content margin.
    const secondaryRowY = actionRowY + ACTION_BTN_H + 16;
    const secondaryItems = [];
    if (this.opts.onEditMore) {
      secondaryItems.push({
        key: 'editMore',
        label: '\u2190 EDIT MORE',
        onTap: () => { const cb = this.opts.onEditMore; this._close(); cb(); },
      });
    }
    secondaryItems.push({
      key: 'copyLink',
      label: 'COPY LINK',
      onTap: () => this._copyShareLink(),
    });
    // Only show native-share when the browser actually supports it —
    // desktop Chrome on Windows, for example, still often lacks the API.
    // Falls back to the copy-link button which always works.
    if (canNativeShare()) {
      secondaryItems.push({
        key: 'share',
        label: 'SHARE\u2026',
        onTap: () => this._nativeShare(),
      });
    }
    const pairGap = 12;
    const innerW = panelW - PANEL_PAD * 2;
    const pairW = Math.min(
      SECONDARY_BTN_W,
      (innerW - pairGap * (secondaryItems.length - 1)) / secondaryItems.length
    );
    const pairTotalW = pairW * secondaryItems.length + pairGap * (secondaryItems.length - 1);
    const pairStartX = px + (panelW - pairTotalW) / 2;
    secondaryItems.forEach((b, i) => {
      const cx = pairStartX + pairW / 2 + i * (pairW + pairGap);
      const btn = this._secondaryButton(cx, secondaryRowY, pairW, SECONDARY_BTN_H, b.label, b.onTap);
      if (b.key === 'copyLink') this._shareLinkBtn  = btn;
      if (b.key === 'editMore') this._editMoreBtn   = btn;
      if (b.key === 'share')    this._nativeShareBtn = btn;
    });

    // --- status line at the bottom ---
    this.status = this.scene.add.text(width / 2, py + panelH - 22, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#1a2332',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
  }

  // Draws one label + value + EDIT-button row. All three pieces anchor off
  // (rowX, rowY) which is the row's left edge + vertical center.
  _buildFieldRow(rowX, rowY, rowW, label, getValue, setDisplay, onEdit, opts = {}) {
    this._addText(rowX + FIELD_LABEL_X, rowY, label, '12px', 'bold', '#1a2332', 0, 0.5);
    const valueStyle = Object.assign({
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', color: '#1a2332',
    }, opts.valueStyle || {});
    const display = this.scene.add.text(rowX + FIELD_VALUE_X, rowY, getValue(), valueStyle)
      .setOrigin(0, 0.5).setDepth(PANEL_DEPTH);
    setDisplay(display);
    (this._fieldDisplays || (this._fieldDisplays = [])).push(display);
    const editX = rowX + rowW - EDIT_BTN_W / 2;
    const btn = this._smallButton(editX, rowY, EDIT_BTN_W, EDIT_BTN_H,
      opts.editLabel || 'EDIT', onEdit, { disabled: !!opts.disabled });
    (this._fieldEditBtns || (this._fieldEditBtns = [])).push(btn);
    // Wallet row needs to relabel its button on connect/disconnect; track
    // it by key so _refreshWallet can flip CONNECT ↔ DISCONNECT.
    if (opts.editKey) {
      (this._fieldEditByKey || (this._fieldEditByKey = {}))[opts.editKey] = btn;
    }
  }

  _drawDivider(x, y, w) {
    const g = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    g.lineStyle(1, DIVIDER_COLOR, 1);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + w, y);
    g.strokePath();
    (this._dividers || (this._dividers = [])).push(g);
  }

  _addText(x, y, text, size, weight, color, ox = 0.5, oy = 0.5) {
    const t = this.scene.add.text(x, y, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: size, fontStyle: weight,
      color,
    }).setOrigin(ox, oy).setDepth(PANEL_DEPTH);
    this._labels.push(t);
    return t;
  }

  _smallButton(cx, cy, w, h, label, onTap, opts = {}) {
    const disabled = !!opts.disabled;
    const idleFill  = disabled ? 0x9aa6b2 : 0x223047;
    const hoverFill = disabled ? 0x9aa6b2 : 0x2a3b55;
    const textColor = disabled ? '#d8dde4' : '#ffffff';
    const rect = this.scene.add.rectangle(cx, cy, w, h, idleFill, 1)
      .setStrokeStyle(1, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: !disabled })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: textColor,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerover', () => rect.setFillStyle(hoverFill, 1));
    rect.on('pointerout',  () => rect.setFillStyle(idleFill, 1));
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
    if (this._walletEnabled) await this._refreshWallet();
  }

  // Reads the connected wallet (if any) from the platform adapter and
  // updates the WALLET row's text + button label. Idempotent — safe to
  // call after connect, disconnect, or just on panel open.
  async _refreshWallet() {
    if (!this._walletEnabled || !this.walletDisplay) return;
    let address = null;
    try { address = await platform.getConnectedWallet(); } catch (e) {}
    const btn = this._fieldEditByKey && this._fieldEditByKey.wallet;
    if (address) {
      this.walletDisplay.setText(truncateAddress(address));
      this.walletDisplay.setColor('#1a2332');
      if (btn && btn.text) btn.text.setText('LOGOUT');
      // Stamp on the level so saveLocal carries it forward; the actual
      // signature is only attached at publish time after re-confirming.
      this.level.authorWallet = address;
    } else {
      this.walletDisplay.setText('not connected');
      this.walletDisplay.setColor('#6b7a8f');
      if (btn && btn.text) btn.text.setText('CONNECT');
    }
  }

  async _toggleWallet() {
    if (!this._walletEnabled) return;
    const existing = await platform.getConnectedWallet().catch(() => null);
    if (existing) {
      this._setStatus('Disconnecting wallet\u2026');
      await platform.disconnectWallet().catch(() => {});
      // Wallet identity changes invalidate the existing signature.
      delete this.level.authorWallet;
      delete this.level.authorSignature;
      await this._refreshWallet();
      this._setStatus('Wallet disconnected.');
    } else {
      this._setStatus('Opening wallet\u2026');
      try {
        await platform.connectWallet();
        await this._refreshWallet();
        this._setStatus('Wallet connected.');
      } catch (e) {
        this._setStatus('Wallet connection cancelled.');
      }
    }
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

  _hasTopRowFactory() {
    const list = this.level.initialFactories || [];
    return list.some((f) => f && f.slot && f.slot.row === 0);
  }

  _hintDisplayText() {
    if (this._topRowBlocked) {
      return 'Move top-row blueprint factories before adding a hint.';
    }
    return this.level.instructionalText || '(none — blank for no hint)';
  }

  _editHint() {
    if (this._hintInput) { this._hintInput.destroy(); this._hintInput = null; }
    const lx = this.hintDisplay.x + 160;
    const ly = this.hintDisplay.y;
    this._hintInput = new TextInputOverlay(this.scene, {
      x: lx, y: ly, width: 360, height: 30,
      value: this.level.instructionalText || '',
      placeholder: 'short hint shown above the blueprint',
      maxLength: 80,
      onCommit: (v) => {
        const text = (v || '').trim();
        // Empty hint = no hint; drop the field so exports stay clean.
        this.level.instructionalText = text || null;
        if (this.hintDisplay) {
          this.hintDisplay.setText(this._hintDisplayText());
          this.hintDisplay.setColor(text ? '#1a2332' : '#6b7a8f');
        }
        this._refreshShareString();
        this._hintInput = null;
      },
      onCancel: () => { this._hintInput = null; },
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

  // Copies a self-contained `?play=<base64>` deep link. Works for any
  // level regardless of save/publish state — the share-string IS the level
  // payload, so the recipient's client decodes it inline without needing
  // to hit the server. That means pre-approval levels can be shared.
  async _copyShareLink() {
    if (!this._boardSizeOk()) return;
    this._setStatus('Preparing share link\u2026');
    // Strip the display-only line breaks we added in _encodeShareString so
    // the share code is a single contiguous base64 blob.
    const raw = (this._shareString || this._encodeShareString(this.level)).replace(/\s+/g, '');
    const base = shareBaseForCurrentOrigin();

    // Try to shorten via the backend. If the API is down / slow / offline,
    // fall back to the long `?play=<b64>` URL so the button always works.
    let code = null;
    try { code = await platform.shortenShareCode(raw); } catch (e) {}
    const url = code
      ? withShareParam(base, 's', code)
      : withShareParam(base, 'play', raw);

    copyText(url).then(
      () => this._setStatus(code ? 'Share link copied.' : 'Share link copied (long form).'),
      (e) => this._setStatus('Copy failed: ' + (e && e.message ? e.message : 'unknown error')),
    );
  }

  _copyShare() {
    copyText(this._shareString).then(
      () => this._setStatus('Copied share string to clipboard'),
      (e) => this._setStatus('Copy failed: ' + (e && e.message ? e.message : 'unknown error')),
    );
  }

  async _nativeShare() {
    if (!this._boardSizeOk()) return;
    const shareString = this._shareString || this._encodeShareString(this.level);
    await shareLevel({
      scene: this.scene,
      level: this.level,
      shareString,
      onStatus: (msg) => this._setStatus(msg),
    });
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
    // Reaching ExportPanel means the level is finished (blueprint setup
    // complete), so flip the editor's 'unfinished' draft tag to 'private'.
    // Publish later bumps it to 'pending' via setStatus.
    if (this.level.status === 'unfinished' || !this.level.status) {
      this.level.status = 'private';
    }
    const stamped = await saveLocal(this.level);
    Object.assign(this.level, { id: stamped.id, status: stamped.status, author: stamped.author });
    this._setStatus(`Saved to library (status: ${stamped.status})`);
    if (this.opts.onSaved) this.opts.onSaved(stamped);
  }

  // Publish orchestrator. The path branches on `platform.ethEnabled`:
  //
  //   eth-disabled (default / non-web platforms):
  //     saveLocal → platform.publishLevel → flip status to 'pending'.
  //     Identical to the legacy behavior.
  //
  //   eth-enabled (web with VITE_BLOCKYARD_ETH_ENABLED=true and a deployed
  //   contract): the level is signed before submission and minted to the
  //   author's wallet after the server accepts it. The mint happens AFTER
  //   the server-publish call so the server-assigned id is what
  //   tokenURI points at — keeps off-chain metadata stable across remixes.
  //
  //   Step ordering matters: server validates the signature, so we sign
  //   the level body BEFORE saveLocal stamps id/createdAt/updatedAt onto
  //   it (the canonical-JSON helper strips those so signatures still
  //   verify, but doing it in this order also guarantees the local copy
  //   carries the signature for re-publish).
  async _publish() {
    if (!this._boardSizeOk()) return;
    const handle = await getAuthorHandle();
    if (!handle) { this._editAuthor(); return; }
    if (this.level.status === 'unfinished' || !this.level.status) {
      this.level.status = 'private';
    }

    // ---- eth-disabled fast path (legacy behavior) ----
    if (!this._walletEnabled) {
      const stamped = await saveLocal(this.level);
      const accepted = await platform.publishLevel(stamped);
      let final = stamped;
      if (accepted) final = (await setStatus(stamped.id, 'pending')) || stamped;
      Object.assign(this.level, { id: final.id, status: final.status, author: final.author });
      this._setStatus(accepted ? 'Submitted \u2014 status: pending mod review' : 'Saved (publish stub returned false)');
      if (this.opts.onSaved) this.opts.onSaved(final);
      return;
    }

    // ---- eth-enabled path ----
    let address = await platform.getConnectedWallet().catch(() => null);
    if (!address) {
      this._setStatus('Connecting wallet\u2026');
      try { address = await platform.connectWallet(); }
      catch (e) { this._setStatus('Publish requires a connected wallet.'); return; }
      await this._refreshWallet();
    }

    this._setStatus('Sign the level in your wallet\u2026');
    let signed;
    try {
      signed = await platform.signLevel(this.level);
    } catch (e) {
      this._setStatus('Signature rejected: ' + (e?.shortMessage || e?.message || 'unknown'));
      return;
    }
    this.level.authorWallet    = signed.address;
    this.level.authorSignature = signed.signature;
    this.level.chainId         = (await import('../../eth/config.js')).CHAIN_ID;

    this._setStatus('Submitting to server\u2026');
    const stamped = await saveLocal(this.level);
    const published = await platform.publishLevel(stamped);
    if (!published) {
      this._setStatus('Server rejected publish. Try again.');
      return;
    }
    const idForUri = (published && published.id) || stamped.id;
    let mid = stamped;
    mid = (await setStatus(stamped.id, 'pending')) || stamped;
    Object.assign(this.level, { id: mid.id, status: mid.status, author: mid.author });

    // Mint AFTER server-publish so tokenURI can point at the server's
    // stable id. We don't await record-mint as part of mint — failure to
    // record on the server is recoverable later, but failure to mint is
    // terminal for ownership.
    this._setStatus('Confirm mint in your wallet\u2026');
    let mintResult;
    try {
      const apiBase = (typeof import.meta !== 'undefined' && import.meta.env.VITE_BLOCKYARD_API) || '';
      const tokenURI = apiBase
        ? `${apiBase}/levels/${encodeURIComponent(idForUri)}/metadata.json`
        : `blockyard://level/${encodeURIComponent(idForUri)}`;
      mintResult = await platform.mintLevel({ tokenURI });
    } catch (e) {
      this._setStatus('Mint failed: ' + (e?.shortMessage || e?.message || 'unknown') + ' (level still submitted; retry mint from the library)');
      if (this.opts.onSaved) this.opts.onSaved(this.level);
      return;
    }
    this.level.tokenId = mintResult.tokenId;
    this.level.txHash  = mintResult.txHash;
    // Persist the mint state locally so reopening the panel shows
    // "Already minted — tokenId N" instead of re-prompting.
    await saveLocal(this.level);

    this._setStatus('Recording mint\u2026');
    await platform.recordMint(idForUri, {
      tokenId: mintResult.tokenId,
      txHash: mintResult.txHash,
      authorWallet: signed.address,
    }).catch(() => {});

    this._setStatus(`Submitted \u2014 minted token #${mintResult.tokenId}, pending mod review.`);
    if (this.opts.onSaved) this.opts.onSaved(this.level);
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
    if (this._hintInput)   { this._hintInput.destroy(); this._hintInput = null; }
    if (this._authorPrompt) { this._authorPrompt.destroy(); this._authorPrompt = null; }
    this.shield.destroy();
    this.bg.destroy();
    this.shareBg.destroy();
    this.shareLabel.destroy();
    this.status.destroy();
    for (const t of (this._labels || [])) { if (t) t.destroy(); }
    if (this._labels) this._labels.length = 0;
    for (const d of (this._fieldDisplays || [])) { if (d) d.destroy(); }
    for (const g of (this._dividers || [])) { if (g) g.destroy(); }
    const buttons = [
      this.copyBtn, this._closeButton, this._editMoreBtn, this._shareLinkBtn, this._nativeShareBtn,
      ...(this._actions || []),
      ...(this._fieldEditBtns || []),
    ];
    for (const b of buttons) {
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

// Display-only EOA shortener — `0x1234…ab12` keeps both ends so users can
// eyeball-match against MetaMask without overrunning the field row.
function truncateAddress(addr) {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
}
