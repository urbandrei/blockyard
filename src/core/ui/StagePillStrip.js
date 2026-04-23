// Stage pill strip for boss levels. Renders N numbered pills across the
// top row of the blueprint, plus a trailing "?" help pill that toggles a
// translucent hint overlay covering the pills.
//
//   [ (1) (2) [ 3 ] (4) (5)    [?] ]
//            ^ current = blue, bigger, green border
//
// Each pill's fill is the stage's color (from stageColors.js). Past stages
// dim to PAST_STAGE_ALPHA; future stages to FUTURE_STAGE_ALPHA. The current
// stage draws over CURRENT_STAGE_COLOR with CURRENT_STAGE_BORDER stroke,
// scaled CURRENT_PILL_SCALE.
//
// Tap behavior: stage pills fire onPillTap(idx) when provided. Help pill
// toggles the overlay via hint-manager state, and also fires onHelpTap.

import {
  stageColor,
  CURRENT_STAGE_COLOR, CURRENT_STAGE_BORDER, CURRENT_STAGE_STROKE,
  PAST_STAGE_ALPHA, FUTURE_STAGE_ALPHA, CURRENT_PILL_SCALE,
} from './stageColors.js';

const HELP_FILL   = 0xffffff;
const HELP_STROKE = 0x1a2332;

export class StagePillStrip {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number}  opts.x          left edge of strip (blueprint-container-local)
   * @param {number}  opts.y          top edge
   * @param {number}  opts.width      total available strip width
   * @param {number}  opts.height     row height (typically one slotPx)
   * @param {number}  opts.stageCount number of pills
   * @param {number}  opts.currentIdx current stage idx (0-based)
   * @param {string}  [opts.hintText]
   * @param {boolean} [opts.hintVisible=false]
   * @param {boolean} [opts.pillsInteractive=false]   tap-through on pill taps
   * @param {Phaser.GameObjects.Container} [opts.parent] container to attach to (optional)
   * @param {number}  [opts.depth]
   * @param {(idx:number)=>void} [opts.onPillTap]
   * @param {()=>void} [opts.onHelpTap]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = { hintVisible: false, pillsInteractive: false, ...opts };
    this.depth = opts.depth != null ? opts.depth : 0;
    this._hintShown = !!this.opts.hintVisible;
    this._objs = [];  // all graphics/text, for easy destroy
    this._hits = [];  // interactive hit zones (keep refs so we can disable)
    this._hintObjs = []; // overlay-only children, for show/hide
    this._build();
  }

  _build() {
    const {
      x, y, width, height, stageCount, currentIdx, hintText,
      parent, pillsInteractive, onPillTap, onHelpTap,
    } = this.opts;
    const scene = this.scene;
    const container = parent || null;
    const add = (obj) => { container ? container.add(obj) : null; this._objs.push(obj); return obj; };

    // Reserve the right end for the help pill (only if hint text is present).
    const hasHelp = !!hintText && hintText.length > 0;
    const pad = Math.max(4, Math.round(height * 0.12));
    const rowY = y + height / 2;
    const pillH = height - pad * 2;
    const helpW = hasHelp ? pillH : 0;
    const helpGap = hasHelp ? Math.max(6, Math.round(height * 0.18)) : 0;
    const stripAvailW = width - pad * 2 - helpW - helpGap;
    const slotW = stripAvailW / stageCount;

    // Stage pills.
    for (let i = 0; i < stageCount; i++) {
      const cx = x + pad + slotW * (i + 0.5);
      const isCurrent = i === currentIdx;
      const scale = isCurrent ? CURRENT_PILL_SCALE : 1;
      const pillW = Math.min(slotW * 0.82, pillH * 2.1) * scale;
      const phH   = pillH * scale;

      const fill   = isCurrent ? CURRENT_STAGE_COLOR : stageColor(i);
      const stroke = isCurrent ? CURRENT_STAGE_BORDER : CURRENT_STAGE_STROKE;
      const strokeW = isCurrent ? 4 : 2;
      const alpha = isCurrent ? 1 : (i < currentIdx ? PAST_STAGE_ALPHA : FUTURE_STAGE_ALPHA);
      const radius = phH * 0.5;

      const g = scene.make.graphics({ add: false });
      g.fillStyle(fill, alpha);
      g.lineStyle(strokeW, stroke, alpha);
      g.fillRoundedRect(cx - pillW / 2, rowY - phH / 2, pillW, phH, radius);
      g.strokeRoundedRect(cx - pillW / 2, rowY - phH / 2, pillW, phH, radius);
      g.setDepth(this.depth);
      add(g);

      const fontPx = Math.max(11, Math.min(20, Math.floor(phH * 0.55)));
      const t = scene.add.text(cx, rowY, String(i + 1), {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontPx}px`,
        fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5).setDepth(this.depth + 1).setAlpha(alpha);
      add(t);

      if (pillsInteractive && onPillTap) {
        const hit = scene.add.rectangle(cx, rowY, pillW, phH, 0xffffff, 0).setDepth(this.depth + 2);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerup', () => onPillTap(i));
        add(hit);
        this._hits.push(hit);
      }
    }

    // Help pill (?).
    if (hasHelp) {
      const cx = x + width - pad - helpW / 2;
      const g = scene.make.graphics({ add: false });
      g.fillStyle(HELP_FILL, 1);
      g.lineStyle(2, HELP_STROKE, 1);
      const radius = pillH * 0.5;
      g.fillRoundedRect(cx - helpW / 2, rowY - pillH / 2, helpW, pillH, radius);
      g.strokeRoundedRect(cx - helpW / 2, rowY - pillH / 2, helpW, pillH, radius);
      g.setDepth(this.depth);
      add(g);

      const fontPx = Math.max(12, Math.min(22, Math.floor(pillH * 0.65)));
      const t = scene.add.text(cx, rowY, '?', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontPx}px`,
        fontStyle: 'bold',
        color: '#1a2332',
      }).setOrigin(0.5).setDepth(this.depth + 1);
      add(t);

      const hit = scene.add.rectangle(cx, rowY, helpW, pillH, 0xffffff, 0).setDepth(this.depth + 2);
      hit.setInteractive({ useHandCursor: true });
      hit.on('pointerup', () => {
        this.toggleHint();
        if (onHelpTap) onHelpTap();
      });
      add(hit);
      this._hits.push(hit);

      // Overlay that covers the whole strip area when hint is shown.
      const oX = x + pad;
      const oY = y + pad;
      const oW = width - pad * 2;
      const oH = height - pad * 2;
      const bg = scene.make.graphics({ add: false });
      bg.fillStyle(0xffffff, 1);
      bg.lineStyle(2, HELP_STROKE, 1);
      const oR = Math.max(6, Math.round(oH * 0.25));
      bg.fillRoundedRect(oX, oY, oW, oH, oR);
      bg.strokeRoundedRect(oX, oY, oW, oH, oR);
      bg.setDepth(this.depth + 3);
      add(bg);
      this._hintObjs.push(bg);

      const hfontPx = Math.max(11, Math.min(20, Math.floor(oH * 0.50)));
      const htext = scene.add.text(x + width / 2, rowY, hintText, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${hfontPx}px`,
        fontStyle: 'bold',
        color: '#1a2332',
        align: 'center',
        wordWrap: { width: oW - pad * 2 },
      }).setOrigin(0.5).setDepth(this.depth + 4);
      add(htext);
      this._hintObjs.push(htext);

      this._applyHintVisibility();
    }
  }

  _applyHintVisibility() {
    for (const o of this._hintObjs) o.setVisible(this._hintShown);
  }

  showHint() {
    if (this._hintShown) return;
    this._hintShown = true;
    this._applyHintVisibility();
  }

  hideHint() {
    if (!this._hintShown) return;
    this._hintShown = false;
    this._applyHintVisibility();
  }

  toggleHint() {
    if (this._hintShown) this.hideHint(); else this.showHint();
  }

  destroy() {
    for (const h of this._hits) {
      try { h.disableInteractive(); } catch (_e) {}
    }
    this._hits = [];
    for (const o of this._objs) {
      try { o.destroy(); } catch (_e) {}
    }
    this._objs = [];
    this._hintObjs = [];
  }
}
