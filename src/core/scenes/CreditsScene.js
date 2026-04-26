import Phaser from 'phaser';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import {
  fadeInAllLayers, fadeOutToLayerOne,
  fadeInCelebrationLayers, fadeOutCelebrationLayers,
} from '../audio/MusicEngine.js';
import { wireUiClicks } from '../audio/sfx.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import { disposeBakedGeometryCache } from '../render/textures/atlas.js';

// End-game credits. Plays after the player beats the final campaign level.
// Single static page — no scroll, no art — centered text on a near-black
// backdrop while the music engine swells the full mix. Tap anywhere (or
// wait for the auto-dismiss) to return to Home.

const AUTO_DISMISS_MS = 30000;

export default class CreditsScene extends Phaser.Scene {
  constructor() { super({ key: 'Credits' }); }

  create() {
    wireUiClicks(this);
    fadeIn(this);

    const { width, height } = this.scale;

    // Match the body / letterbox bg to the in-canvas color so the
    // dark backdrop reads as one continuous void out to the device
    // viewport edges.
    disableMenuBg();
    if (typeof document !== 'undefined') {
      const s = document.body.style;
      s.backgroundImage = '';
      s.backgroundSize = '';
      s.backgroundPosition = '';
      s.backgroundRepeat = '';
      s.backgroundAttachment = '';
      s.animation = '';
      s.backgroundColor = '#0a0a0e';
    }

    // Solid near-black backdrop covering the canvas.
    this.bg = this.add.rectangle(0, 0, width, height, 0x0a0a0e, 1)
      .setOrigin(0).setDepth(0);

    // Build the credit block in a container so it can be centered as a
    // unit. Each row appends downward; the container is repositioned at
    // the end so the whole stack sits vertically centered on the page.
    const block = this.add.container(width / 2, 0).setDepth(10);

    let cy = 0;
    const addText = (txt, fontSize, isBold, color = '#ffffff', extraGap = 0) => {
      const t = this.add.text(0, cy, txt, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontSize}px`,
        fontStyle: isBold ? 'bold' : 'normal',
        color,
        align: 'center',
      }).setOrigin(0.5, 0);
      block.add(t);
      cy += t.height + extraGap;
    };
    const addGap = (px) => { cy += px; };

    // Two-tier type scale: TITLE (the game name only) and BODY (every
    // credit row). Headers vs names are differentiated by weight + color
    // instead of size, so the page reads as one calm column instead of a
    // jumble of font sizes.
    const TITLE_PX     = 56;
    const BODY_PX      = 22;
    const FOOTER_PX    = 16;
    const TITLE_GAP    = 36;     // below game title
    const SECTION_GAP  = 22;     // between credit sections
    const ROW_GAP      = 3;      // tight row stacking inside a section
    const HEADER_GAP   = 6;      // gap below a small "header" line
    const HEADER_COLOR = '#9aa6b2';
    const SOFT_COLOR   = '#cfd8dc';

    // ----- content -----
    addText('BLOCK YARD', TITLE_PX, true);
    addGap(TITLE_GAP);

    addText('Lead developer', BODY_PX, false, HEADER_COLOR, HEADER_GAP);
    addText('Urbandrei', BODY_PX, true, '#ffffff', ROW_GAP);
    addGap(SECTION_GAP);

    addText('Guest designers', BODY_PX, false, HEADER_COLOR, HEADER_GAP);
    addText('p4songer', BODY_PX, true, '#ffffff', ROW_GAP);
    addText('JayTeaGibs', BODY_PX, true, '#ffffff', ROW_GAP);
    addGap(SECTION_GAP);

    addText('Audio sourcing', BODY_PX, false, HEADER_COLOR, HEADER_GAP);
    addText('JayTeaGibs', BODY_PX, true, '#ffffff', ROW_GAP);
    addGap(SECTION_GAP);

    addText('QA testing', BODY_PX, false, HEADER_COLOR, HEADER_GAP);
    addText('p4songer', BODY_PX, true, '#ffffff', ROW_GAP);
    addText('JayTeaGibs', BODY_PX, true, '#ffffff', ROW_GAP);
    addGap(SECTION_GAP);

    addText('Made with Phaser', BODY_PX, false, SOFT_COLOR, ROW_GAP);
    addGap(SECTION_GAP);

    addText('Big thanks to everyone', BODY_PX, false, SOFT_COLOR, ROW_GAP);
    addText('who played early builds', BODY_PX, false, SOFT_COLOR);
    addGap(SECTION_GAP);

    // Closing send-off — same body size, weighted bold so it reads as a
    // beat without breaking the consistent type scale above. Split across
    // two lines so each line stays comfortably within the panel width on
    // portrait phones; the second line is the player-facing thanks.
    addText('and most of all,', BODY_PX, true, '#ffffff', ROW_GAP);
    addText('thank YOU for playing!', BODY_PX, true, '#ffffff', ROW_GAP);
    addText('see you out there!', BODY_PX, true, '#ffffff');
    addGap(SECTION_GAP);

    addText('Tap anywhere to return home', FOOTER_PX, false, HEADER_COLOR);

    // Vertically center the whole block on the page. cy at this point is
    // the total stack height; the container's child y starts at 0 and
    // grows downward, so positioning the container at (h - cy)/2 lands
    // the first row at the right top edge for a centered layout.
    const blockHeight = cy;
    block.y = Math.max(20, Math.round((height - blockHeight) / 2));

    // Full mix: every layer of the regular bed (1, 2, 3) audible AND the
    // celebration layers (5 + 6) easing in. Tuned to ~4s so the layers
    // hit full volume early in the static page and the player gets a
    // long settled stretch of the celebration mix to read against —
    // not a slow build that never quite arrives.
    try { fadeInAllLayers(); } catch (e) {}
    try { fadeInCelebrationLayers(4000); } catch (e) {}

    // Tap-to-dismiss. Also auto-dismiss after a long hold so a player who
    // walks away doesn't get trapped on the credits screen.
    this.input.on('pointerdown', () => this._dismiss());
    this.time.delayedCall(AUTO_DISMISS_MS, () => this._dismiss());

    this.events.once('shutdown', () => {
      try { disposeBakedGeometryCache(this); } catch (e) { /* ignore */ }
    });
  }

  _dismiss() {
    if (this._dismissing) return;
    this._dismissing = true;
    // Fade the celebration cues out gently and the bed back to layer 1
    // only — Home arrives with the standard resting mix instead of the
    // full swell from the credits.
    try { fadeOutCelebrationLayers(); } catch (e) {}
    try { fadeOutToLayerOne(); } catch (e) {}
    fadeTo(this, 'Home');
  }
}
