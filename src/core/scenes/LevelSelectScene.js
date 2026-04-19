import Phaser from 'phaser';
import { SECTIONS } from '../catalog/index.js';
import { loadProgress } from '../progress.js';
import { ScrollingChecker } from '../render/ScrollingChecker.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';

// Level select. One vertical-scroll list of sections; each section is a 2x5
// grid of regular levels followed by a wider BOSS button. Buttons reflect
// progress: unlocked / locked (dimmed) / beaten (checkmark overlay).
//
// Unlock rule (MVP): the first level is always unlocked; level N is unlocked
// once any earlier level has been beaten. Bosses unlock once every regular
// level in the section is beaten.

const HEADER_H        = 64;
const SECTION_GAP     = 32;
const BUTTON_SIZE     = 80;
const BUTTON_GAP      = 12;
const BOSS_HEIGHT     = 110;
const COLS            = 5;

export default class LevelSelectScene extends Phaser.Scene {
  constructor() { super({ key: 'LevelSelect' }); }

  async create() {
    this.bg = new ScrollingChecker(this, { scroll: true });
    fadeIn(this);

    const { width, height } = this.scale;

    this.add.rectangle(width / 2, 36, width, 72, 0x1a2332, 1).setOrigin(0.5);
    this.add.text(width / 2, 36, 'LEVEL SELECT', {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0.5);

    // Back button — top-left.
    const back = this.add.rectangle(60, 36, 88, 44, 0x223047, 1)
      .setStrokeStyle(1, 0x3a5a88, 1)
      .setInteractive({ useHandCursor: true });
    this.add.text(60, 36, 'BACK', {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#e6edf5',
    }).setOrigin(0.5);
    back.on('pointerup', () => fadeTo(this, 'Home'));

    const progress = await loadProgress();
    const beaten = new Set(progress.beaten);

    // Render sections in vertical sequence, top-down.
    let y = 96;
    for (const section of SECTIONS) {
      y = this._renderSection(section, beaten, width, y);
      y += SECTION_GAP;
    }
  }

  _renderSection(section, beaten, width, topY) {
    this.add.text(width / 2, topY, section.name, {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0.5);
    let y = topY + 32;

    // Compute unlock state for each level. Unlocked iff it's the very first
    // level in the catalog or any earlier level in this section is beaten.
    const levels = section.levels;
    const gridW = COLS * BUTTON_SIZE + (COLS - 1) * BUTTON_GAP;
    const startX = width / 2 - gridW / 2;
    let anyEarlierBeaten = beaten.size > 0;
    levels.forEach((lvl, idx) => {
      const r = Math.floor(idx / COLS);
      const c = idx % COLS;
      const cx = startX + c * (BUTTON_SIZE + BUTTON_GAP) + BUTTON_SIZE / 2;
      const cy = y + r * (BUTTON_SIZE + BUTTON_GAP) + BUTTON_SIZE / 2;
      const isBeaten  = beaten.has(lvl.id);
      // First level is always unlocked. Others require any prior beaten OR
      // the immediately previous level beaten — using "any earlier" keeps
      // the player from getting fully stuck.
      const unlocked  = idx === 0 || anyEarlierBeaten;
      this._levelButton(cx, cy, lvl, isBeaten, unlocked);
      if (isBeaten) anyEarlierBeaten = true;
    });
    const usedRows = Math.ceil(levels.length / COLS);
    y += usedRows * (BUTTON_SIZE + BUTTON_GAP);

    // Boss placeholder (no boss level in catalog yet — render as locked).
    const bossW = gridW;
    const bossY = y + BOSS_HEIGHT / 2 + 6;
    const bossRect = this.add.rectangle(width / 2, bossY, bossW, BOSS_HEIGHT, 0x2a3b55, 1)
      .setStrokeStyle(2, 0x3a5a88, 1);
    this.add.text(width / 2, bossY, 'BOSS — coming soon', {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: '#9aa6b2',
    }).setOrigin(0.5);
    bossRect.setAlpha(0.7);
    return bossY + BOSS_HEIGHT / 2;
  }

  _levelButton(cx, cy, level, isBeaten, unlocked) {
    const fill   = unlocked ? 0x3b66b8 : 0x2a3b55;
    const stroke = unlocked ? 0x1a2332 : 0x1a2332;
    const rect = this.add.rectangle(cx, cy, BUTTON_SIZE, BUTTON_SIZE, fill, 1)
      .setStrokeStyle(2, stroke, 1);
    if (!unlocked) rect.setAlpha(0.55);

    this.add.text(cx, cy - 8, String(level.number), {
      fontFamily: 'system-ui, sans-serif', fontSize: '28px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    this.add.text(cx, cy + 22, level.name, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px',
      color: '#e6edf5',
    }).setOrigin(0.5);

    if (isBeaten) {
      // Small green checkmark overlay (top-right corner).
      const badge = this.add.circle(cx + BUTTON_SIZE / 2 - 10, cy - BUTTON_SIZE / 2 + 10, 12, 0x4caf50, 1)
        .setStrokeStyle(2, 0x1a2332, 1);
      this.add.text(badge.x, badge.y, '✓', {
        fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5);
    }

    if (unlocked) {
      rect.setInteractive({ useHandCursor: true });
      rect.on('pointerover', () => rect.setFillStyle(0x4a76c8, 1));
      rect.on('pointerout',  () => rect.setFillStyle(fill, 1));
      rect.on('pointerup', () => fadeTo(this, 'Player', { levelId: level.id }));
    }
  }

  update(_time, delta) {
    if (this.bg) this.bg.update(delta);
  }
}
