import Phaser from 'phaser';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import {
  fadeInAllLayers, fadeOutToLayerOne,
  fadeInCelebrationLayers, fadeOutCelebrationLayers,
} from '../audio/MusicEngine.js';
import { themeForSectionIdx } from '../themes/sectionThemes.js';
import { wireUiClicks } from '../audio/sfx.js';
import { disableMenuBg } from '../ui/MenuBackground.js';

// Section-unlock cinematic. Shown on the FIRST time a player unlocks a
// new section (Paint Spill, Acid Swamp, Laser Field, Wild West). The
// screen fills with a vertically-scrolling tile pattern in the new
// section's theme colors with the section title overlaid in big bold
// type. Music swells to all layers. After HOLD_MS (or on tap) the scene
// fades to the next level.

const SECTION_TITLES = ['BLOCK YARD', 'PAINT SPILL', 'ACID SWAMP', 'LASER FIELD', 'WILD WEST'];

const TILE_PX  = 110;     // base tile size for the scrolling backdrop
const SCROLL_S = 6;       // seconds for the pattern to scroll one row
const HOLD_MS  = 6500;    // total time on screen before auto-advance

export default class SectionIntroScene extends Phaser.Scene {
  constructor() { super({ key: 'SectionIntro' }); }

  init(data) {
    this._sectionIdx  = (data && data.sectionIdx != null) ? data.sectionIdx : 0;
    this._nextLevelId = (data && data.nextLevelId) || null;
    // Phaser reuses scene instances across scene.start, so the prior run's
    // dismiss flag would otherwise stick and short-circuit _advance on the
    // very next intro the player sees.
    this._dismissing  = false;
  }

  create() {
    wireUiClicks(this);
    fadeIn(this);

    const { width, height } = this.scale;
    const theme = themeForSectionIdx(this._sectionIdx);

    // Match the body / letterbox bg to the in-canvas color so the
    // section's tile pattern reads as one continuous biome out to the
    // device viewport edges. We strip the menu .bg-scroll class first
    // and paint a solid theme-buffer color inline.
    disableMenuBg();
    if (typeof document !== 'undefined') {
      const hex = '#' + theme.buffer.toString(16).padStart(6, '0');
      const s = document.body.style;
      s.backgroundImage = '';
      s.backgroundSize = '';
      s.backgroundPosition = '';
      s.backgroundRepeat = '';
      s.backgroundAttachment = '';
      s.animation = '';
      s.backgroundColor = hex;
    }

    // Solid backdrop in the section's buffer color so any gap between
    // tiles never reveals brown body bg underneath.
    this.add.rectangle(0, 0, width, height, theme.buffer, 1)
      .setOrigin(0).setDepth(0);

    // Scrolling tile pattern. Built once and tweened vertically; we
    // size it tall enough that the wrap-around at the loop point lands
    // off-canvas, so the seam is invisible.
    const cols = Math.ceil(width  / TILE_PX) + 2;
    const rows = Math.ceil(height / TILE_PX) + 4;
    this.tilesContainer = this.add.container(0, 0).setDepth(5);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const fill = ((r + c) & 1) ? theme.bufferAlt : theme.buffer;
        const tile = this.add.rectangle(c * TILE_PX, r * TILE_PX, TILE_PX, TILE_PX, fill, 1).setOrigin(0);
        this.tilesContainer.add(tile);
      }
    }
    this.tilesContainer.x = -TILE_PX;
    this.tilesContainer.y = -TILE_PX * 2;
    this.tweens.add({
      targets: this.tilesContainer,
      y: -TILE_PX * 2 - TILE_PX * 2,    // travel two tiles, then loop seamlessly
      duration: SCROLL_S * 1000,
      ease: 'Linear',
      repeat: -1,
    });

    // Section title — large, centered, with a heavy stroke so it reads
    // on any combination of theme colors behind it.
    const title = SECTION_TITLES[this._sectionIdx] || `STAGE ${this._sectionIdx + 1}`;
    const titleText = this.add.text(width / 2, height / 2 - 16, title, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '72px',
      fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#1a2332',
      strokeThickness: 8,
      align: 'center',
    }).setOrigin(0.5).setDepth(10);

    const sub = this.add.text(width / 2, height / 2 + 48, `STAGE ${this._sectionIdx + 1}`, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '26px',
      fontStyle: 'bold',
      color: '#ffffff',
      stroke: '#1a2332',
      strokeThickness: 5,
      align: 'center',
    }).setOrigin(0.5).setDepth(10);

    // Subtle pulse on the title so it feels alive instead of static.
    this.tweens.add({
      targets: [titleText, sub],
      scale: { from: 1.0, to: 1.04 },
      duration: 900, ease: 'Sine.InOut', yoyo: true, repeat: -1,
    });

    // Full mix: all three regular bed layers AND the celebration
    // layers (5 + 6) gently fading in over a few seconds. Celebration
    // tracks have been looping silently since boot, so they're
    // perfectly phase-locked with layers 1..3 the moment they swell.
    try { fadeInAllLayers(); } catch (e) {}
    try { fadeInCelebrationLayers(); } catch (e) {}

    // Auto-advance after HOLD_MS. Tap also advances early.
    this.time.delayedCall(HOLD_MS, () => this._advance());
    this.input.on('pointerdown', () => this._advance());
  }

  _advance() {
    if (this._dismissing) return;
    this._dismissing = true;
    // Fade the celebration cues out gently and the bed back to layer 1
    // only so PlayerScene starts with a clean "layer 1 only" mix
    // instead of inheriting the full swell.
    try { fadeOutCelebrationLayers(); } catch (e) {}
    try { fadeOutToLayerOne(); } catch (e) {}
    if (this._nextLevelId) {
      // _skipIntroCheck stops PlayerScene from re-routing back through
      // the intro on the resulting fadeTo.
      fadeTo(this, 'Player', { levelId: this._nextLevelId, _skipIntroCheck: true });
    } else {
      fadeTo(this, 'Home');
    }
  }
}
