// Small callout that appears beneath the hint button after the player
// has been on a level for a while without dismissing it. Single-line text
// with an up-pointing notch aimed at the hint icon. Taps anywhere on the
// popup dismiss it (fires onDismiss).

const POPUP_DEPTH = 9010;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TEXT_COLOR   = '#1a2332';

export class HintNudgePopup {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.anchorX   world-x of the hint-button center (popup points up at this)
   * @param {number} opts.anchorY   world-y of the hint-button bottom edge
   * @param {() => void} opts.onDismiss
   */
  constructor(scene, { anchorX, anchorY, onDismiss }) {
    this.scene = scene;
    this._closed = false;

    const panelW = 260;
    const panelH = 52;
    const notchH = 10;
    const notchHalfW = 10;
    const gapFromAnchor = 8;

    const sceneW = scene.scale.width;
    // Ideal: panel's notch tip sits at anchorX. Clamp the panel so it
    // stays on screen; the notch can drift relative to the panel as long
    // as its tip still lands above the hint button.
    const panelIdealCX = anchorX;
    const panelCX = Math.max(panelW / 2 + 8, Math.min(sceneW - panelW / 2 - 8, panelIdealCX));
    const panelTopY = anchorY + gapFromAnchor + notchH;
    const panelCY = panelTopY + panelH / 2;

    this.root = scene.add.container(0, 0).setDepth(POPUP_DEPTH);

    const bg = scene.add.graphics();
    bg.fillStyle(PANEL_FILL, 1);
    bg.lineStyle(2, PANEL_STROKE, 1);
    bg.fillRoundedRect(panelCX - panelW / 2, panelTopY, panelW, panelH, 10);
    bg.strokeRoundedRect(panelCX - panelW / 2, panelTopY, panelW, panelH, 10);
    this.root.add(bg);

    // Up-pointing notch at anchorX. Draw the fill first, then a two-leg
    // stroke (skip the panel-side edge so the notch reads as part of the
    // panel outline).
    const notchTipY = panelTopY - notchH + 1;  // +1 tucks the triangle under the panel edge
    const notchBaseY = panelTopY + 0.5;
    const notchTipX = Math.max(
      panelCX - panelW / 2 + notchHalfW + 6,
      Math.min(panelCX + panelW / 2 - notchHalfW - 6, anchorX),
    );
    const notch = scene.add.graphics();
    notch.fillStyle(PANEL_FILL, 1);
    notch.beginPath();
    notch.moveTo(notchTipX, notchTipY);
    notch.lineTo(notchTipX - notchHalfW, notchBaseY);
    notch.lineTo(notchTipX + notchHalfW, notchBaseY);
    notch.closePath();
    notch.fillPath();
    notch.lineStyle(2, PANEL_STROKE, 1);
    notch.beginPath();
    notch.moveTo(notchTipX - notchHalfW, notchBaseY);
    notch.lineTo(notchTipX, notchTipY);
    notch.lineTo(notchTipX + notchHalfW, notchBaseY);
    notch.strokePath();
    this.root.add(notch);

    const text = scene.add.text(panelCX, panelCY, 'Need a hand? Tap ? for a hint.', {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
      color: TEXT_COLOR,
    }).setOrigin(0.5);
    this.root.add(text);

    // Whole popup is tap-to-dismiss. Sized a little bigger than the
    // panel so the notch is also a valid tap target.
    this.hit = scene.add.rectangle(panelCX, panelCY - notchH / 2, panelW + 8, panelH + notchH + 8, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true })
      .setDepth(POPUP_DEPTH);
    this.hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      this._finish(onDismiss);
    });

    // Entry animation — slide down + fade in so it doesn't just pop.
    this.root.alpha = 0;
    this.root.y = -6;
    scene.tweens.add({
      targets: this.root,
      alpha: 1, y: 0,
      duration: 220, ease: 'Sine.Out',
    });
  }

  _finish(cb) {
    if (this._closed) return;
    this._closed = true;
    this.destroy();
    if (cb) cb();
  }

  destroy() {
    if (this.root) { this.root.destroy(true); this.root = null; }
    if (this.hit)  { this.hit.destroy(); this.hit = null; }
  }
}
