import { drawHome, drawQuestion } from './Icons.js';
import { StepIndicator } from './StepIndicator.js';

// Title bar above the play area.
//
// Layout:  [ ⬤N   LEVEL NAME                    ] [ 🏠 ]
//           └── left box (pill + name) ─────────┘  └─ right box ─┘
//
// The left box holds a filled "number pill" with the level number in white,
// followed by the level name in dark text. The right box is a home-icon
// button that calls `onHome` on tap.
//
// Usage:
//   this.titleBar = new TitleBar(this, {
//     x: centerX, y: centerY, width: boardW,
//     levelNumber: level.number, levelName: level.name,
//     onHome: () => { this.sim && this.sim.stop(); this.scene.start('Home'); },
//   });

const TITLE_H            = 72;
const RIGHT_BOX_W        = 96;
const GAP_BETWEEN_BOXES  = 12;
const PILL_PADDING_X     = 14;
const PILL_SIZE          = 40;
const CORNER_R           = 14;

const FRAME_FILL   = 0xffffff;
const FRAME_STROKE = 0x1a2332;
const PILL_FILL    = 0x3b66b8;
const PILL_TEXT    = '#ffffff';
const NAME_TEXT    = '#1a2332';
const AUTHOR_TEXT  = '#5a6b82';
const AUTHOR_PAD_R = 14;   // gap from the right edge of the frame to the author label
const HOME_FILL    = 0x3a5a88;
const HOME_STROKE  = 0x1a2332;
const HOME_GLYPH   = 0xffffff;

// Depth at which every title-bar object sits. Must be above the
// board's exterior-checker container (depth 25) so the bar doesn't get
// hidden under the brown "cut-out" surface that covers the scene.
const TITLE_DEPTH = 100;

export class TitleBar {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x
   * @param {number} opts.y
   * @param {number} opts.width
   * @param {number} [opts.levelNumber]
   * @param {string} [opts.levelName]
   * @param {string} [opts.author]                 when set and not in designer/steps mode, drawn right-aligned inside the left frame as "by <author>"
   * @param {() => void} [opts.onHome]
   * @param {boolean} [opts.designerMode=false]   designer-mode: SAVE button replaces number pill, name becomes editable
   * @param {() => void} [opts.onSaveOpen]        designer-mode only — fires when SAVE is tapped
   * @param {() => void} [opts.onNameTap]         designer-mode only — fires when the name area is tapped (caller opens TextInputOverlay)
   * @param {object} [opts.steps]                 when present, the left box renders a StepIndicator instead of the pill/SAVE/name.
   * @param {string[]} [opts.steps.states]        per-step states (see StepIndicator)
   * @param {(key:string)=>void} [opts.steps.onStep]
   * @param {string} [opts.variant]               'standalone-steps' drops the left frame AND the right box so the bar is just 3 bare step pills. Requires `steps`.
   * @param {object} [opts.rightButton]           overrides the right-side button: { kind:'home'|'hint', onTap }. Default is 'home' using onHome.
   */
  constructor(scene, opts) {
    const {
      x, y, width, levelNumber, levelName, author, onHome,
      designerMode = false, onSaveOpen, onNameTap, steps,
      variant, rightButton,
    } = opts;
    this.scene = scene;
    this.designerMode = designerMode;
    this.variant = variant;

    const standalone = variant === 'standalone-steps';
    const showRight = !standalone;
    const effLeftW = showRight ? (width - RIGHT_BOX_W - GAP_BETWEEN_BOXES) : width;
    const leftW  = effLeftW;
    const leftX  = x - width / 2;
    const rightX = x + width / 2 - RIGHT_BOX_W;

    // ------- Left box — frame skipped entirely in standalone-steps mode -------
    if (!standalone) {
      this.leftBox = scene.add.graphics().setDepth(TITLE_DEPTH);
      this.leftBox.fillStyle(FRAME_FILL, 1);
      this.leftBox.lineStyle(2, FRAME_STROKE, 1);
      this.leftBox.fillRoundedRect(leftX, y - TITLE_H / 2, leftW, TITLE_H, CORNER_R);
      this.leftBox.strokeRoundedRect(leftX, y - TITLE_H / 2, leftW, TITLE_H, CORNER_R);
    }

    if (steps) {
      // Step-indicator mode replaces everything in the left box (pill, SAVE,
      // name) with a 3-box progress widget. Level name is edited via the
      // ExportPanel instead. In `standalone-steps` the pills span the whole
      // title width with no surrounding frame.
      const pad = standalone ? 0 : 10;
      this.steps = new StepIndicator(scene, {
        x: leftX + leftW / 2,
        y,
        width: leftW - pad * 2,
        height: TITLE_H - pad * 2,
        depth: TITLE_DEPTH,
        states: steps.states,
        onStep: steps.onStep,
      });
      // Text-less name slot — keep a tiny field so setLevel() calls don't blow
      // up. It's not rendered.
      this.nameText = scene.add.text(0, -9999, '', { fontSize: '1px' }).setVisible(false);
    } else if (designerMode) {
      // Designer mode: the SAVE button is only present when the caller
      // supplies `onSaveOpen`. Without it (the normal case until the user
      // finishes the export flow) the left box is just the editable name —
      // autosave still runs silently in EditorScene._persist.
      const showSave = !!onSaveOpen;
      const saveW = showSave ? 80 : 0;
      const saveGap = showSave ? 14 : 0;
      let nameX;
      if (showSave) {
        const saveH = 44;
        const saveCX = leftX + PILL_PADDING_X + saveW / 2;
        this.saveBg = scene.add.graphics().setDepth(TITLE_DEPTH);
        this.saveBg.fillStyle(PILL_FILL, 1);
        this.saveBg.lineStyle(2, FRAME_STROKE, 1);
        this.saveBg.fillRoundedRect(saveCX - saveW / 2, y - saveH / 2, saveW, saveH, 10);
        this.saveBg.strokeRoundedRect(saveCX - saveW / 2, y - saveH / 2, saveW, saveH, 10);
        this.saveText = scene.add.text(saveCX, y, 'SAVE', {
          fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
          color: PILL_TEXT,
        }).setOrigin(0.5).setDepth(TITLE_DEPTH);
        this.saveHit = scene.add.rectangle(saveCX, y, saveW, saveH, 0xffffff, 0)
          .setInteractive({ useHandCursor: true }).setDepth(TITLE_DEPTH);
        this.saveHit.on('pointerup', onSaveOpen);
        nameX = saveCX + saveW / 2 + saveGap;
      } else {
        nameX = leftX + PILL_PADDING_X;
      }
      const nameMaxW = leftX + leftW - nameX - 8;
      this.nameText = scene.add.text(nameX, y, levelName || 'untitled', {
        fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
        color: NAME_TEXT,
      }).setOrigin(0, 0.5).setDepth(TITLE_DEPTH);
      this.nameHit = scene.add.rectangle(nameX + nameMaxW / 2, y, nameMaxW, TITLE_H - 12, 0xffffff, 0)
        .setInteractive({ useHandCursor: true }).setDepth(TITLE_DEPTH);
      if (onNameTap) this.nameHit.on('pointerup', onNameTap);

      this._nameAreaX = nameX;
      this._nameAreaY = y;
      this._nameAreaW = nameMaxW;
    } else {
      // Number pill.
      const pillCX = leftX + PILL_PADDING_X + PILL_SIZE / 2;
      const pillCY = y;
      this.pill = scene.add.graphics().setDepth(TITLE_DEPTH);
      this.pill.fillStyle(PILL_FILL, 1);
      this.pill.fillCircle(pillCX, pillCY, PILL_SIZE / 2);
      this.pillText = scene.add.text(pillCX, pillCY, String(levelNumber ?? 0), {
        fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
        color: PILL_TEXT,
      }).setOrigin(0.5).setDepth(TITLE_DEPTH);

      // Author label (right-aligned inside the left frame, drawn first so
      // we can measure it and reserve width for the name on its left).
      const trimmedAuthor = (author || '').trim();
      let authorLeftEdge = leftX + leftW - AUTHOR_PAD_R;
      if (trimmedAuthor) {
        this.authorText = scene.add.text(
          leftX + leftW - AUTHOR_PAD_R, y, `by ${trimmedAuthor}`,
          {
            fontFamily: 'system-ui, sans-serif', fontSize: '14px',
            color: AUTHOR_TEXT, fontStyle: 'italic',
          },
        ).setOrigin(1, 0.5).setDepth(TITLE_DEPTH);
        authorLeftEdge = this.authorText.x - this.authorText.width - 10;
      }

      // Level name.
      const nameX = pillCX + PILL_SIZE / 2 + 14;
      const nameMaxW = Math.max(40, authorLeftEdge - nameX);
      this.nameText = scene.add.text(nameX, y, levelName || '', {
        fontFamily: 'system-ui, sans-serif', fontSize: '28px', fontStyle: 'bold',
        color: NAME_TEXT,
        wordWrap: { width: nameMaxW, useAdvancedWrap: false },
      }).setOrigin(0, 0.5).setDepth(TITLE_DEPTH);
    }

    // ------- Right box — skipped entirely in standalone-steps mode -------
    if (showRight) {
      const rb = rightButton || { kind: 'home', onTap: onHome };
      this.rightBox = scene.add.graphics().setDepth(TITLE_DEPTH);
      this.rightBox.fillStyle(HOME_FILL, 1);
      this.rightBox.lineStyle(2, HOME_STROKE, 1);
      this.rightBox.fillRoundedRect(rightX, y - TITLE_H / 2, RIGHT_BOX_W, TITLE_H, CORNER_R);
      this.rightBox.strokeRoundedRect(rightX, y - TITLE_H / 2, RIGHT_BOX_W, TITLE_H, CORNER_R);
      this._rightBoxBounds = { x: rightX, y: y - TITLE_H / 2, w: RIGHT_BOX_W, h: TITLE_H };
      this._rightBoxCenter = { x: rightX + RIGHT_BOX_W / 2, y };
      const iconCX = rightX + RIGHT_BOX_W / 2;
      const iconSize = Math.round(TITLE_H * 0.7);
      if (rb.kind === 'hint') {
        // drawQuestion needs a container to stash its Text child into — use a
        // tiny dedicated container so teardown is clean.
        this._rightIconContainer = scene.add.container(0, 0).setDepth(TITLE_DEPTH);
        drawQuestion(scene, this._rightIconContainer, iconCX, y, iconSize, HOME_GLYPH);
      } else {
        this.homeIcon = scene.add.graphics().setDepth(TITLE_DEPTH);
        drawHome(this.homeIcon, iconCX, y, iconSize, HOME_GLYPH);
      }
      this.homeHit = scene.add.rectangle(
        iconCX, y, RIGHT_BOX_W, TITLE_H, 0xffffff, 0,
      ).setInteractive({ useHandCursor: true }).setDepth(TITLE_DEPTH);

      // Hover/press juice. Draw a translucent tint overlay on top of the
      // box graphics (can't scale the graphics itself — it was drawn in
      // absolute world coords) and, for container-based icons (hint kind),
      // tween icon scale around the button center. For the home-icon
      // graphics variant we skip scale because Graphics pivots around 0,0
      // and would warp off-screen if scaled.
      const tintOverlay = scene.add.graphics().setDepth(TITLE_DEPTH + 1);
      tintOverlay.fillStyle(0xffffff, 1);
      tintOverlay.fillRoundedRect(rightX, y - TITLE_H / 2, RIGHT_BOX_W, TITLE_H, CORNER_R);
      tintOverlay.alpha = 0;
      this._rightBoxTint = tintOverlay;

      const iconTargets = [];
      if (this._rightIconContainer) {
        // Recenter the container at (iconCX, y) and shift its children so
        // scaling the container pivots around the button center.
        const c = this._rightIconContainer;
        c.setPosition(iconCX, y);
        for (const child of c.list) {
          child.x -= iconCX;
          child.y -= y;
        }
        iconTargets.push(c);
      }

      const setScale = (s, dur = 120, ease = 'Sine.Out') => {
        if (!iconTargets.length) return;
        scene.tweens.add({ targets: iconTargets, scaleX: s, scaleY: s, duration: dur, ease });
      };
      const setTint = (alpha, dur = 120) => {
        scene.tweens.add({ targets: tintOverlay, alpha, duration: dur, ease: 'Sine.Out' });
      };

      this.homeHit.on('pointerover', () => { setScale(1.14); setTint(0.16); });
      this.homeHit.on('pointerout',  () => { setScale(1.0);  setTint(0); });
      this.homeHit.on('pointerdown', () => { setScale(0.86, 70); setTint(0.30, 70); });

      const handler = rb.onTap || onHome;
      this.homeHit.on('pointerup', () => {
        if (iconTargets.length) {
          scene.tweens.add({
            targets: iconTargets,
            scaleX: 1.14, scaleY: 1.14,
            duration: 110, ease: 'Back.Out',
            onComplete: () => { setScale(1.0, 120); setTint(0, 180); if (handler) handler(); },
          });
        } else {
          setTint(0, 180);
          if (handler) handler();
        }
      });
    }
  }

  setLevel(number, name) {
    if (this.pillText) this.pillText.setText(String(number ?? 0));
    if (this.nameText) this.nameText.setText(name || (this.designerMode ? 'untitled' : ''));
  }

  // Start a gentle, ongoing flash on the right-side button so the player
  // notices the hint icon while the nudge popup is up. Paints a soft white
  // overlay that slowly yoyos its alpha. Idempotent — calling twice does
  // nothing the second time. Stop with stopGentleFlash().
  startGentleFlash() {
    if (!this.rightBox) return;
    if (this._flashOverlay) return;  // already flashing
    const bounds = this._rightBoxBounds;
    if (!bounds) return;
    const overlay = this.scene.add.graphics().setDepth(TITLE_DEPTH + 1);
    overlay.fillStyle(0xffffff, 1);
    overlay.fillRoundedRect(bounds.x, bounds.y, bounds.w, bounds.h, CORNER_R);
    overlay.alpha = 0;
    this._flashOverlay = overlay;
    this._flashTween = this.scene.tweens.add({
      targets: overlay,
      alpha: { from: 0, to: 0.32 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.InOut',
    });
  }

  // Toggle the right-side button between enabled (full opacity, interactive,
  // hover/press juice live) and disabled (greyed, non-interactive). Used by
  // PlayerScene to grey out the hint button when every factory is already
  // in its solution spot. Also cancels any gentle flash when disabling.
  setRightButtonEnabled(enabled) {
    if (!this.rightBox) return;
    const prev = this._rightEnabled !== false;
    if (enabled === prev) return;   // idempotent
    this._rightEnabled = !!enabled;
    const alpha = enabled ? 1 : 0.4;
    this.rightBox.alpha = alpha;
    if (this._rightIconContainer) this._rightIconContainer.alpha = alpha;
    if (this.homeIcon) this.homeIcon.alpha = alpha;
    if (this.homeHit) {
      if (enabled) this.homeHit.setInteractive({ useHandCursor: true });
      else this.homeHit.disableInteractive();
    }
    if (!enabled) this.stopGentleFlash();
  }

  stopGentleFlash() {
    if (this._flashTween) { this._flashTween.stop(); this._flashTween = null; }
    if (this._flashOverlay) {
      const overlay = this._flashOverlay;
      this._flashOverlay = null;
      this.scene.tweens.add({
        targets: overlay,
        alpha: 0,
        duration: 220,
        ease: 'Sine.Out',
        onComplete: () => overlay.destroy(),
      });
    }
  }

  // Update the step-indicator states when the editor's progress changes.
  // No-op when the title bar isn't in step mode.
  setStepStates(states) {
    if (this.steps) this.steps.setStates(states);
  }

  // Designer-mode anchor — caller positions a TextInputOverlay over the
  // editable name area so the overlay tracks where the text was.
  getNameAnchor() {
    if (!this.designerMode || !this._nameAreaX) return null;
    return { x: this._nameAreaX + this._nameAreaW / 2, y: this._nameAreaY, width: this._nameAreaW, height: TITLE_H - 12 };
  }

  destroy() {
    if (this.leftBox)   this.leftBox.destroy();
    if (this.pill)      this.pill.destroy();
    if (this.pillText)  this.pillText.destroy();
    if (this.saveBg)    this.saveBg.destroy();
    if (this.saveText)  this.saveText.destroy();
    if (this.saveHit)   this.saveHit.destroy();
    if (this.nameHit)   this.nameHit.destroy();
    if (this.steps)     this.steps.destroy();
    if (this.nameText)  this.nameText.destroy();
    if (this.authorText) this.authorText.destroy();
    if (this.rightBox)  this.rightBox.destroy();
    if (this.homeIcon)  this.homeIcon.destroy();
    if (this.homeHit)   this.homeHit.destroy();
    if (this._rightIconContainer) this._rightIconContainer.destroy(true);
    if (this._rightBoxTint) this._rightBoxTint.destroy();
    if (this._flashTween) { this._flashTween.stop(); this._flashTween = null; }
    if (this._flashOverlay) this._flashOverlay.destroy();
  }

  // World-coords center of the right-side button. Used by PlayerScene to
  // anchor the stuck-nudge popup underneath the hint icon.
  getRightButtonCenter() {
    return this._rightBoxCenter ? { ...this._rightBoxCenter } : null;
  }
}

// Height the scene should reserve above the play area for the title bar.
TitleBar.HEIGHT = TITLE_H;
