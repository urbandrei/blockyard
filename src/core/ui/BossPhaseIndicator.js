// Mid-canvas phase indicator used when the editor is in Boss mode. Shows
// the current phase label between a left and right arrow:
//
//   ◀   Edit 2 of 4   ▶
//
// Phases form a flat sequence:
//   Edit 1, Blueprint 1, Edit 2, Blueprint 2, ..., Edit N, Blueprint N, Export
//
// Arrows move the cursor ±1. They disable (dimmed, non-interactive) at the
// extremes. Styled to match StepIndicator — green "current" pill, dark
// stroke, white text, rounded corners.

const PILL_FILL     = 0x4caf50;
const PILL_STROKE   = 0x1a2332;
const PILL_STROKE_W = 4;
const PILL_CORNER_R = 12;

const ARROW_FILL    = 0x9aa6b2;
const ARROW_STROKE  = 0x1a2332;
const ARROW_DISABLED_ALPHA = 0.3;

export class BossPhaseIndicator {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number}  opts.x
   * @param {number}  opts.y
   * @param {number}  opts.width   total width of the arrow+pill+arrow group
   * @param {number}  opts.height
   * @param {number}  [opts.depth]
   * @param {(delta:number)=>void} [opts.onNav]   fires with +1 or -1
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.depth = opts.depth != null ? opts.depth : 100;
    this._label = '';
    this._canBack = false;
    this._canNext = false;
    this._build();
  }

  _build() {
    const { x, y, width, height } = this.opts;
    const arrowW = Math.min(56, Math.round(height * 1.1));
    const pillW = width - arrowW * 2 - 24;
    const pillH = height;

    // Pill in the center.
    this._pillGfx = this.scene.add.graphics().setDepth(this.depth);
    this._pillText = this.scene.add.text(x, y, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: pillW >= 180 ? '18px' : '16px',
      fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(this.depth + 1);
    this._pillMetrics = { cx: x, cy: y, w: pillW, h: pillH };

    // Left arrow.
    const leftCX = x - pillW / 2 - 12 - arrowW / 2;
    this._backBtn = this._buildArrowButton(leftCX, y, arrowW, pillH, 'back');
    this._backBtn.hit.on('pointerup', () => {
      if (!this._canBack) return;
      if (this.opts.onNav) this.opts.onNav(-1);
    });

    // Right arrow.
    const rightCX = x + pillW / 2 + 12 + arrowW / 2;
    this._nextBtn = this._buildArrowButton(rightCX, y, arrowW, pillH, 'next');
    this._nextBtn.hit.on('pointerup', () => {
      if (!this._canNext) return;
      if (this.opts.onNav) this.opts.onNav(+1);
    });

    this._paintPill();
    this._paintArrows();
  }

  _buildArrowButton(cx, cy, w, h, direction) {
    const gfx = this.scene.add.graphics().setDepth(this.depth);
    const hit = this.scene.add.rectangle(cx, cy, w, h, 0xffffff, 0)
      .setDepth(this.depth + 3);
    return { gfx, hit, cx, cy, w, h, direction };
  }

  _paintPill() {
    const { cx, cy, w, h } = this._pillMetrics;
    this._pillGfx.clear();
    this._pillGfx.fillStyle(PILL_FILL, 1);
    this._pillGfx.lineStyle(PILL_STROKE_W, PILL_STROKE, 1);
    this._pillGfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, PILL_CORNER_R);
    this._pillGfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, PILL_CORNER_R);
    this._pillText.setText(this._label);
  }

  _paintArrows() {
    this._paintArrow(this._backBtn, this._canBack);
    this._paintArrow(this._nextBtn, this._canNext);
  }

  _paintArrow(entry, enabled) {
    const { cx, cy, w, h, direction, gfx, hit } = entry;
    gfx.clear();
    const alpha = enabled ? 1 : ARROW_DISABLED_ALPHA;
    gfx.fillStyle(ARROW_FILL, alpha);
    gfx.lineStyle(PILL_STROKE_W, ARROW_STROKE, alpha);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, PILL_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, PILL_CORNER_R);
    // Chevron.
    const chevW = w * 0.28;
    const chevH = h * 0.38;
    gfx.lineStyle(4, 0xffffff, alpha);
    if (direction === 'back') {
      gfx.beginPath();
      gfx.moveTo(cx + chevW / 2, cy - chevH / 2);
      gfx.lineTo(cx - chevW / 2, cy);
      gfx.lineTo(cx + chevW / 2, cy + chevH / 2);
      gfx.strokePath();
    } else {
      gfx.beginPath();
      gfx.moveTo(cx - chevW / 2, cy - chevH / 2);
      gfx.lineTo(cx + chevW / 2, cy);
      gfx.lineTo(cx - chevW / 2, cy + chevH / 2);
      gfx.strokePath();
    }
    if (enabled) hit.setInteractive({ useHandCursor: true });
    else         hit.disableInteractive();
  }

  /** Update the displayed state. */
  setState({ label, canBack, canNext }) {
    this._label = label || '';
    this._canBack = !!canBack;
    this._canNext = !!canNext;
    this._paintPill();
    this._paintArrows();
  }

  setVisible(v) {
    this._pillGfx.setVisible(v);
    this._pillText.setVisible(v);
    this._backBtn.gfx.setVisible(v);
    this._backBtn.hit.setVisible(v);
    this._nextBtn.gfx.setVisible(v);
    this._nextBtn.hit.setVisible(v);
    if (!v) {
      this._backBtn.hit.disableInteractive();
      this._nextBtn.hit.disableInteractive();
    } else {
      this._paintArrows();
    }
  }

  destroy() {
    if (this._pillGfx) this._pillGfx.destroy();
    if (this._pillText) this._pillText.destroy();
    for (const b of [this._backBtn, this._nextBtn]) {
      if (b) { b.gfx.destroy(); b.hit.destroy(); }
    }
    this._pillGfx = this._pillText = this._backBtn = this._nextBtn = null;
  }
}
