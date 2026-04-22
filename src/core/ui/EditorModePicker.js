// Editor-mode sub-menu shown when the player taps LEVEL DESIGNER in
// CommunityScene. Offers two choices — Single Level and Boss Level —
// separated by a hairline rule. Below the Boss Level row a - N + counter
// picks the stage count (clamped to 2..5). Selection fires `onPick` with
// { bossMode, stageCount }. Styled to match ImportModal's modal vocabulary.

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;

const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;

const PRIMARY_FILL   = 0x3b66b8;
const PRIMARY_HOVER  = 0x4a76c8;
const PRIMARY_STROKE = 0x1f3a74;

const MIN_STAGES = 2;
const MAX_STAGES = 5;
const DEFAULT_STAGES = 3;

export class EditorModePicker {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {(res:{bossMode:boolean, stageCount:number})=>void} opts.onPick
   * @param {()=>void} [opts.onClose]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts || {};
    this._stageCount = DEFAULT_STAGES;
    this._objs = [];
    this._build();
  }

  _build() {
    const { width, height } = this.scene.scale;

    this.shield = this.scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerup', () => this._close());

    const panelW = Math.min(480, width - 60);
    const panelH = 320;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.bg = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    this.bg.fillStyle(PANEL_FILL, 1);
    this.bg.lineStyle(3, PANEL_STROKE, 1);
    this.bg.fillRoundedRect(px, py, panelW, panelH, 16);
    this.bg.strokeRoundedRect(px, py, panelW, panelH, 16);

    this._addText(width / 2, py + 30, 'NEW LEVEL', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0.5);

    // --- Single Level ---
    const btnW = panelW - 60;
    const singleCY = py + 80;
    this._makeActionButton(width / 2, singleCY, btnW, 48, 'SINGLE LEVEL',
      () => this._pick(false));

    // Divider hairline.
    const divY = singleCY + 36;
    const divider = this.scene.add.graphics().setDepth(PANEL_DEPTH);
    divider.lineStyle(1, PANEL_STROKE, 0.4);
    divider.lineBetween(px + 30, divY, px + panelW - 30, divY);
    this._objs.push(divider);

    // --- Boss Level ---
    const bossCY = divY + 36;
    this._makeActionButton(width / 2, bossCY, btnW, 48, 'BOSS LEVEL',
      () => this._pick(true));

    // --- Stage counter (below Boss Level) ---
    const counterCY = bossCY + 56;
    const labelLeft = this._addText(width / 2 - 100, counterCY, 'STAGES', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
      color: '#1a2332', letterSpacing: 1,
    }).setOrigin(1, 0.5);
    labelLeft.setAlpha(0.7);

    const stepperW = 150;
    const stepperH = 36;
    const stepperCX = width / 2 + 30;
    const btnSize = stepperH;

    this._minusBtn = this._makeStepperButton(stepperCX - stepperW / 2 + btnSize / 2,
      counterCY, btnSize, btnSize, '−', () => this._adjust(-1));
    this._plusBtn = this._makeStepperButton(stepperCX + stepperW / 2 - btnSize / 2,
      counterCY, btnSize, btnSize, '+', () => this._adjust(+1));

    this._countText = this._addText(stepperCX, counterCY, String(this._stageCount), {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: '#1a2332',
    }).setOrigin(0.5);

    this._hint = this._addText(width / 2, counterCY + 30,
      `2–5 stages. Boss fights play each stage in sequence.`, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#1a2332',
    }).setOrigin(0.5);
    this._hint.setAlpha(0.6);

    // Close button in top-right.
    this._closeBtn = this._makeStepperButton(px + panelW - 24, py + 24, 32, 24, 'X',
      () => this._close());

    this._refreshStepperState();
  }

  _adjust(delta) {
    const next = Math.max(MIN_STAGES, Math.min(MAX_STAGES, this._stageCount + delta));
    if (next === this._stageCount) return;
    this._stageCount = next;
    this._countText.setText(String(this._stageCount));
    this._refreshStepperState();
  }

  _refreshStepperState() {
    const atMin = this._stageCount <= MIN_STAGES;
    const atMax = this._stageCount >= MAX_STAGES;
    if (this._minusBtn) this._minusBtn.rect.setAlpha(atMin ? 0.35 : 1);
    if (this._plusBtn)  this._plusBtn.rect.setAlpha(atMax ? 0.35 : 1);
    if (this._minusBtn) this._minusBtn.text.setAlpha(atMin ? 0.5 : 1);
    if (this._plusBtn)  this._plusBtn.text.setAlpha(atMax ? 0.5 : 1);
  }

  _pick(bossMode) {
    const res = { bossMode, stageCount: bossMode ? this._stageCount : 1 };
    this.destroy();
    if (this.opts.onPick) this.opts.onPick(res);
  }

  _close() {
    this.destroy();
    if (this.opts.onClose) this.opts.onClose();
  }

  _addText(x, y, str, style) {
    const t = this.scene.add.text(x, y, str, style).setDepth(PANEL_DEPTH);
    this._objs.push(t);
    return t;
  }

  _makeActionButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, PRIMARY_FILL, 1)
      .setStrokeStyle(2, PRIMARY_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff', letterSpacing: 1,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerover', () => rect.setFillStyle(PRIMARY_HOVER, 1));
    rect.on('pointerout',  () => rect.setFillStyle(PRIMARY_FILL, 1));
    rect.on('pointerup', onTap);
    const obj = { rect, text };
    this._objs.push(rect, text);
    return obj;
  }

  _makeStepperButton(cx, cy, w, h, label, onTap) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, 0x223047, 1)
      .setStrokeStyle(1, PANEL_STROKE, 1)
      .setInteractive({ useHandCursor: true })
      .setDepth(PANEL_DEPTH);
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);
    rect.on('pointerup', onTap);
    const obj = { rect, text };
    this._objs.push(rect, text);
    return obj;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.shield) this.shield.destroy();
    if (this.bg) this.bg.destroy();
    for (const o of this._objs) { try { o.destroy(); } catch (e) {} }
    this._objs = [];
  }
}
