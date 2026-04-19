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
      x, y, width, levelNumber, levelName, onHome,
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

      // Level name.
      const nameX = pillCX + PILL_SIZE / 2 + 14;
      this.nameText = scene.add.text(nameX, y, levelName || '', {
        fontFamily: 'system-ui, sans-serif', fontSize: '28px', fontStyle: 'bold',
        color: NAME_TEXT,
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
      const handler = rb.onTap || onHome;
      if (handler) this.homeHit.on('pointerup', handler);
    }
  }

  setLevel(number, name) {
    if (this.pillText) this.pillText.setText(String(number ?? 0));
    if (this.nameText) this.nameText.setText(name || (this.designerMode ? 'untitled' : ''));
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
    if (this.rightBox)  this.rightBox.destroy();
    if (this.homeIcon)  this.homeIcon.destroy();
    if (this.homeHit)   this.homeHit.destroy();
    if (this._rightIconContainer) this._rightIconContainer.destroy(true);
  }
}

// Height the scene should reserve above the play area for the title bar.
TitleBar.HEIGHT = TITLE_H;
