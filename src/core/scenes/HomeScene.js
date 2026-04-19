import Phaser from 'phaser';
import { loadProgress } from '../progress.js';
import { nextUnbeaten, LEVELS } from '../catalog/index.js';
import { ScrollingChecker } from '../render/ScrollingChecker.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';

// Home menu. Three primary actions:
//   • QUICK PLAY (<next unbeaten level name>) — jumps straight into the
//     first level the player hasn't beaten, or back into the last one if
//     everything is done.
//   • LEVEL SELECT — opens the section/level grid.
//   • COMMUNITY — placeholder route for the future Community scene
//     (Milestone G). Logs a stub for now.
//
// A small EDITOR link at the bottom keeps the sandbox reachable from home
// during development.

export default class HomeScene extends Phaser.Scene {
  constructor() { super({ key: 'Home' }); }

  async create() {
    this.bg = new ScrollingChecker(this, { scroll: true });
    fadeIn(this);

    const { width, height } = this.scale;

    this.add.text(width / 2, height * 0.18, 'BLOCKYARD', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '56px',
      color: '#e6edf5',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const progress = await loadProgress();
    const beatenSet = new Set(progress.beaten);
    const next = nextUnbeaten(beatenSet) || LEVELS[LEVELS.length - 1] || null;
    const quickLabel = next
      ? `QUICK PLAY — ${next.name}`
      : 'QUICK PLAY';

    this._button(width / 2, height * 0.42, quickLabel, () => {
      if (next) fadeTo(this, 'Player', { levelId: next.id });
    });
    this._button(width / 2, height * 0.55, 'LEVEL SELECT', () => {
      fadeTo(this, 'LevelSelect');
    });
    this._button(width / 2, height * 0.68, 'COMMUNITY', () => {
      fadeTo(this, 'Community');
    });

    this._smallButton(width / 2, height * 0.85, 'EDITOR (sandbox)', () => {
      fadeTo(this, 'Editor');
    });
  }

  update(_time, delta) {
    if (this.bg) this.bg.update(delta);
  }

  _button(x, y, label, onClick) {
    const w = 420, h = 76;
    const rect = this.add.rectangle(x, y, w, h, 0x223047, 1)
      .setStrokeStyle(2, 0x3a5a88, 1)
      .setInteractive({ useHandCursor: true });
    const text = this.add.text(x, y, label, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '22px',
      color: '#e6edf5',
      letterSpacing: 2,
    }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(0x2a3b55, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0x223047, 1));
    rect.on('pointerup', onClick);
    return { rect, text };
  }

  _smallButton(x, y, label, onClick) {
    const w = 260, h = 48;
    const rect = this.add.rectangle(x, y, w, h, 0x1a2332, 1)
      .setStrokeStyle(1, 0x3a5a88, 1)
      .setInteractive({ useHandCursor: true });
    const text = this.add.text(x, y, label, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      color: '#9aa6b2',
    }).setOrigin(0.5);
    rect.on('pointerup', onClick);
    return { rect, text };
  }
}
