import Phaser from 'phaser';
import { loadProgress } from '../progress.js';
import { nextUnbeaten, LEVELS } from '../catalog/index.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';

// Home menu. Three primary actions stacked vertically in the centered
// content column:
//   • QUICK PLAY (LEVEL N) — jumps to the first unbeaten level, or back to
//     the last one if everything's been cleared.
//   • LEVEL SELECT — opens the section/level grid.
//   • COMMUNITY — opens the community hub.
// A small EDITOR link lives just under the primary stack for sandbox
// access during development.

const BTN_H       = 76;
const BTN_RADIUS  = 18;
const BTN_GAP     = 22;
const TITLE_H     = 64;

const QP_FILL   = 0x4caf50;
const QP_STROKE = 0x2e7a36;
const QP_TEXT   = '#ffffff';

const BTN_FILL    = 0x223047;
const BTN_STROKE  = 0x3a5a88;
const BTN_TEXT    = '#e6edf5';

export default class HomeScene extends Phaser.Scene {
  constructor() { super({ key: 'Home' }); }

  async create() {
    enableMenuBg();
    fadeIn(this);

    const progress = await loadProgress();
    const beatenSet = new Set(progress.beaten);
    const next = nextUnbeaten(beatenSet) || LEVELS[LEVELS.length - 1] || null;
    this._next = next;
    this._quickLabel = next ? `LEVEL ${next.number}` : 'QUICK PLAY';

    this._buttons = [];
    this._layoutAndRender();

    this._onResize = () => this._relayout();
    this.scale.on('resize', this._onResize);
    this.events.on('shutdown', () => {
      if (this._onResize) this.scale.off('resize', this._onResize);
    });
  }

  _relayout() {
    for (const b of this._buttons) b.destroy();
    this._buttons = [];
    this._layoutAndRender();
  }

  _layoutAndRender() {
    const { boxX, boxY, boxW, boxH } = compute920Box(this);
    const centerX = boxX + Math.round(boxW / 2);

    // Match LevelSelect's header/button width so the menu reads as the
    // same column the game uses — not a fullscreen sprawl.
    const btnW = Math.min(420, boxW - 48);

    // Title + 3 primary buttons, vertically centered in the content box.
    const primaryCount = 3;
    const stackH =
      TITLE_H + BTN_GAP +
      primaryCount * BTN_H + (primaryCount - 1) * BTN_GAP;
    const topPad = Math.max(24, Math.floor((boxH - stackH) / 2));
    let y = boxY + topPad;

    // ---- Title ----
    const title = this.add.text(centerX, y + TITLE_H / 2, 'BLOCKYARD', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '56px',
      color: '#e6edf5',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    // Fade/slide the title in so Home has a first-frame moment of motion.
    title.alpha = 0;
    title.y -= 12;
    this.tweens.add({
      targets: title, alpha: 1, y: y + TITLE_H / 2,
      duration: 360, ease: 'Sine.Out',
    });
    this._buttons.push({ destroy: () => title.destroy() });

    y += TITLE_H + BTN_GAP;

    // ---- QUICK PLAY (green) ----
    const qp = this._button(centerX, y + BTN_H / 2, btnW, BTN_H, this._quickLabel, {
      fill: QP_FILL, stroke: QP_STROKE, textColor: QP_TEXT, pulse: true, fontSize: 28,
      onClick: () => {
        if (this._next) fadeTo(this, 'Player', { levelId: this._next.id });
      },
    });
    this._buttons.push(qp);
    y += BTN_H + BTN_GAP;

    // ---- LEVEL SELECT ----
    this._buttons.push(this._button(centerX, y + BTN_H / 2, btnW, BTN_H, 'LEVEL SELECT', {
      fill: BTN_FILL, stroke: BTN_STROKE, textColor: BTN_TEXT,
      onClick: () => fadeTo(this, 'LevelSelect'),
    }));
    y += BTN_H + BTN_GAP;

    // ---- COMMUNITY ----
    this._buttons.push(this._button(centerX, y + BTN_H / 2, btnW, BTN_H, 'COMMUNITY', {
      fill: BTN_FILL, stroke: BTN_STROKE, textColor: BTN_TEXT,
      onClick: () => fadeTo(this, 'Community'),
    }));
  }

  // Rounded rectangle button drawn with Phaser Graphics, positioned via
  // .x/.y so scale tweens grow around the button center instead of the
  // scene origin. Returns a `{ destroy }` handle for relayout teardown.
  _button(cx, cy, w, h, label, opts) {
    const {
      fill, stroke, textColor, onClick,
      pulse = false, fontSize = 22, radius = BTN_RADIUS,
    } = opts;

    // Graphics in local coords (origin = button center) so scale transforms
    // stay centered.
    const g = this.add.graphics();
    g.fillStyle(fill, 1);
    g.lineStyle(2, stroke, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, radius);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, radius);
    g.x = cx; g.y = cy;
    g.setScale(1);
    g.alpha = 0;

    const text = this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${fontSize}px`,
      fontStyle: 'bold',
      color: textColor,
      letterSpacing: 2,
    }).setOrigin(0.5);
    text.alpha = 0;

    // Staggered fade-in so the stack cascades rather than flashing in
    // all at once.
    const delay = this._buttons ? Math.min(this._buttons.length * 55, 320) : 0;
    this.tweens.add({
      targets: [g, text], alpha: 1,
      duration: 280, ease: 'Sine.Out', delay,
    });

    // Invisible hit rect on top — absorbs pointer events so the underlying
    // graphics doesn't need to be interactive (graphics hit regions are
    // more trouble than a plain rectangle).
    const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });

    const tweens = [];

    // Idle pulse on the quick-play tile only — "tap me" without being loud.
    let pulseTween = null;
    if (pulse) {
      pulseTween = this.tweens.add({
        targets: g,
        scale: { from: 1.0, to: 1.035 },
        duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.InOut',
      });
      tweens.push(pulseTween);
    }

    // Juice: hover = slight grow; press = squash; release = pop back with
    // a hint of overshoot. The pulse tween (if any) gets paused during
    // press so it doesn't fight the squash.
    const squash = () => {
      if (pulseTween) pulseTween.pause();
      this.tweens.killTweensOf([g, text]);
      this.tweens.add({ targets: [g, text], scale: 0.93, duration: 80, ease: 'Sine.Out' });
    };
    const pop = () => {
      this.tweens.killTweensOf([g, text]);
      this.tweens.add({
        targets: [g, text], scale: 1, duration: 240, ease: 'Back.Out',
        onComplete: () => { if (pulseTween) pulseTween.resume(); },
      });
    };
    const hover = (entering) => {
      if (pulseTween) return;            // pulsing buttons don't hover-scale
      this.tweens.killTweensOf([g, text]);
      this.tweens.add({
        targets: [g, text],
        scale: entering ? 1.04 : 1,
        duration: 140, ease: 'Sine.Out',
      });
    };

    hit.on('pointerover', () => hover(true));
    hit.on('pointerout',  () => { hover(false); pop(); });
    hit.on('pointerdown', () => squash());
    hit.on('pointerup',   () => { pop(); if (onClick) onClick(); });

    return {
      destroy: () => {
        for (const t of tweens) { try { t.stop(); } catch (e) {} }
        try { this.tweens.killTweensOf([g, text]); } catch (e) {}
        g.destroy(); text.destroy(); hit.destroy();
      },
    };
  }
}
