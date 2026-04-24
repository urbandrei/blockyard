// Click-through tutorial modal for the editor. A series of pages, each
// with a heading and a body paragraph; the user advances with a NEXT
// button (or BACK) and dismisses with the X / tap-outside.
//
// Each page can include a `targetSlot` index — when set, an animated
// yellow ring is drawn around that palette slot so the user sees exactly
// which tool the current page is discussing. The modal panel positions
// itself in the LOWER half of the screen so the highlighted slot stays
// visible above.
//
// Uses the same shield + clamped-panel pattern as PalettePopup — shield
// at depth 9000, panel root at depth 9001, delayed onClose so the
// dismissing tap doesn't fall through to the editor underneath.

import { addDomDim } from '../ui/DomDim.js';

const PANEL_W = 520;
const PANEL_H = 360;
const PAD = 26;

const PAGES = [
  {
    title: 'Playable area',
    targetArea: 'board',
    body:
      'This is the board where shapes flow. The inner cells are the ' +
      'playable area. The ring around them is the buffer where border ' +
      'inputs and outputs live.',
  },
  {
    title: 'Blueprint',
    targetArea: 'composer',
    body:
      'This grid below the toolbar is the blueprint. You can build a ' +
      'factory shape here and drag it onto the board, or move a board ' +
      'factory back into the blueprint to edit it.',
  },
  {
    title: 'Toolbar',
    targetArea: 'palette',
    body:
      'This is the toolbar. Tap a slot to open its dropdown and pick an ' +
      'option, then drag from the slot onto the board or blueprint to ' +
      'place it. Double tap a slot to cycle to the next option without ' +
      'opening the dropdown.',
  },
  {
    title: 'Factory',
    targetSlot: 0,
    body:
      'Drag a factory block onto an empty board cell to create a small ' +
      'factory. Drop next to an existing factory to merge with it. Tap ' +
      'an empty cell to add a block. Tap a placed cell to rotate the ' +
      'whole factory.',
  },
  {
    title: 'In / out funnels',
    targetSlot: 1,
    body:
      'These blocks are the inputs and outputs of shapes and lasers ' +
      'for the factory. Drag one onto any factory edge to attach it.',
  },
  {
    title: 'Board pieces',
    targetSlot: 2,
    body:
      'All board pieces are placed in the playable area. Acid pits sit ' +
      'on the inner cells of the board. Border inputs and outputs sit ' +
      'on the buffer ring around the board and feed shapes or lasers ' +
      'into and out of the playable area.',
  },
  {
    title: 'Labels',
    targetSlot: 3,
    body:
      'Drag a label onto a factory cell, acid pit, or border funnel to ' +
      'set its type. The X clears the label. The lightning bolt makes ' +
      'a factory laser powered.',
  },
  {
    title: 'Eraser',
    targetSlot: 4,
    body:
      'Drag the eraser onto any single piece to delete just that piece. ' +
      'To delete a whole factory at once, drag the factory to the ' +
      'bottom of the screen.',
  },
  {
    title: 'Undo',
    targetSlot: 5,
    body:
      'Tap this slot to undo your last edit.',
  },
  {
    title: 'Bottom controls',
    targetArea: 'island',
    body:
      'These four buttons are HOME, START OVER, shrink the board, and ' +
      'grow the board.',
  },
  {
    title: 'Phase 1: Blocks',
    targetPhase: 0,
    body:
      'In the Blocks phase you build the puzzle. Place factories, ' +
      'attach funnels, set labels, and watch the simulation run. The ' +
      'goal is to get every output funnel filled with the right shape.',
  },
  {
    title: 'Phase 2: Blueprint',
    targetPhase: 1,
    body:
      'Once the puzzle works, the Blueprint phase opens. Drag every ' +
      'solution factory from the playable area into the blueprint grid ' +
      'so the player has the right pieces to start with.',
  },
  {
    title: 'Phase 3: Export',
    targetPhase: 2,
    body:
      'When every factory has a slot in the blueprint, the Export phase ' +
      'opens. From here you can publish the level so other players can ' +
      'try it.',
  },
];

// Boss mode replaces the Blocks phase slide with a stages-and-arrows
// explanation. The phases are still 1 to 3 conceptually but each level
// has multiple stages, and the bar at the top has front/back arrows for
// stepping through them. Other phase slides stay the same.
const BOSS_BLOCKS_PHASE = {
  title: 'Phase 1: Blocks (boss)',
  targetArea: 'titleBar',
  body:
    'In a boss level the Blocks phase repeats once per stage. The bar ' +
    'at the top shows the current phase. Use the front and back arrows ' +
    'on the bar to move between stages. Each stage carries its solved ' +
    'factories forward to the next.',
};

export class HelpModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this._page = 0;
    // Boss mode swaps the Phase-1 (Blocks) slide for the
    // stages-and-arrows variant. Other slides stay the same.
    this._pages = opts.bossMode
      ? PAGES.map((p) => (p.targetPhase === 0 && p.title.startsWith('Phase 1') ? BOSS_BLOCKS_PHASE : p))
      : PAGES;
    this._build();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._domDim) { try { this._domDim(); } catch (e) {} this._domDim = null; }
    this.root && this.root.destroy();
    this.shield && this.shield.destroy();
    if (this._dimGfx)       { this._dimGfx.destroy();       this._dimGfx = null; }
    if (this._highlightGfx) { this._highlightGfx.destroy(); this._highlightGfx = null; }
    if (this._highlightTween) { this._highlightTween.stop(); this._highlightTween = null; }
    this.scene.time.delayedCall(0, () => {
      this.opts.onClose && this.opts.onClose();
    });
  }

  _build() {
    const { scene, opts } = this;
    const sw = scene.scale.width;
    const sh = scene.scale.height;

    // HTML letterbox strips so the dim reaches the whole viewport.
    // The canvas part is dimmed by _dimGfx below (which draws the
    // spotlight strips around the highlighted target).
    this._domDim = addDomDim({ alpha: 0.55 });
    // Tap-capture surface — fully transparent, full-screen. Captures all
    // clicks while the modal is open so the editor underneath stays inert.
    this.shield = scene.add
      .rectangle(sw / 2, sh / 2, sw, sh, 0x000000, 0.001)
      .setDepth(9000)
      .setInteractive({ useHandCursor: false });
    this.shield.on('pointerdown', () => this.close());

    // Spotlight dim — drawn as 4 strips around the focus area so the
    // focus rect itself stays bright. When no focus is set, draws a
    // full-screen dim. Re-rendered on each page change. Sits between
    // the tap-capture shield and the modal panel.
    this._dimGfx = scene.add.graphics().setDepth(9000.5);
    this._highlightGfx = scene.add.graphics().setDepth(9000.6);

    // Panel position is decided per page in _positionRoot — initial spot
    // is just a placeholder so we can construct the container; the first
    // _render call repositions immediately.
    this.root = scene.add.container(sw / 2, sh / 2).setDepth(9001);

    const bg = scene.add.graphics();
    bg.fillStyle(0xffffff, 1);
    bg.lineStyle(2, 0x1a2332, 1);
    bg.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 16);
    bg.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 16);
    this.root.add(bg);

    // Swallow taps inside the panel so they don't fall through to the shield.
    const panelHit = scene.add.rectangle(0, 0, PANEL_W, PANEL_H, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: false });
    panelHit.on('pointerdown', (_p, _lx, _ly, e) => { e.stopPropagation(); });
    this.root.add(panelHit);

    // Close button — small × in the top-right corner with hover/press juice.
    const closeBtn = scene.add.text(PANEL_W / 2 - 22, -PANEL_H / 2 + 16, '×', {
      fontFamily: 'system-ui, sans-serif', fontSize: '32px', fontStyle: 'bold', color: '#1a2332',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const tweenScale = (target, s, dur = 110, ease = 'Sine.Out') => {
      scene.tweens.add({ targets: target, scaleX: s, scaleY: s, duration: dur, ease });
    };
    closeBtn.on('pointerover', () => tweenScale(closeBtn, 1.20));
    closeBtn.on('pointerout',  () => tweenScale(closeBtn, 1.0));
    closeBtn.on('pointerdown', (_p, _lx, _ly, e) => {
      e.stopPropagation();
      tweenScale(closeBtn, 0.82, 70);
    });
    closeBtn.on('pointerup', () => {
      scene.tweens.add({
        targets: closeBtn, scaleX: 1.20, scaleY: 1.20, duration: 90, ease: 'Back.Out',
        onComplete: () => this.close(),
      });
    });
    this.root.add(closeBtn);

    this._titleText = scene.add.text(0, -PANEL_H / 2 + PAD + 4, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '28px', fontStyle: 'bold', color: '#1a2332',
      align: 'center',
    }).setOrigin(0.5, 0);
    this.root.add(this._titleText);

    this._bodyText = scene.add.text(0, -PANEL_H / 2 + PAD + 58, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', color: '#1a2332',
      align: 'left', wordWrap: { width: PANEL_W - PAD * 2 - 16 }, lineSpacing: 6,
    }).setOrigin(0.5, 0);
    this.root.add(this._bodyText);

    // Page indicator (e.g., "3 / 11").
    this._pageText = scene.add.text(0, PANEL_H / 2 - PAD - 8, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#6a7480',
    }).setOrigin(0.5, 1);
    this.root.add(this._pageText);

    // BACK / NEXT buttons.
    this._backBtn = this._makeBtn(-125, PANEL_H / 2 - PAD - 36, 'BACK', () => this._goto(this._page - 1));
    this._nextBtn = this._makeBtn( 125, PANEL_H / 2 - PAD - 36, 'NEXT', () => {
      if (this._page >= this._pages.length - 1) this.close();
      else this._goto(this._page + 1);
    });

    void opts;
    this._render();
  }

  _makeBtn(cx, cy, text, onTap) {
    const w = 150, h = 46;
    const scene = this.scene;
    const btn = scene.add.container(cx, cy);
    const bg = scene.add.graphics();
    bg.fillStyle(0x1a2332, 1);
    bg.lineStyle(1, 0x1a2332, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 8);
    const label = scene.add.text(0, 0, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5);
    // Hover/press tint overlay — mirrors the TitleBar juice pattern. Sits
    // on top of the bg graphics; alpha-tweened on hover / press / release.
    const tint = scene.add.graphics();
    tint.fillStyle(0xffffff, 1);
    tint.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
    tint.alpha = 0;
    btn.add([bg, tint, label]);

    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });

    const tweenScale = (s, dur = 110, ease = 'Sine.Out') => {
      scene.tweens.add({ targets: btn, scaleX: s, scaleY: s, duration: dur, ease });
    };
    const tweenTint = (alpha, dur = 110) => {
      scene.tweens.add({ targets: tint, alpha, duration: dur, ease: 'Sine.Out' });
    };

    hit.on('pointerover', () => { tweenScale(1.05); tweenTint(0.16); });
    hit.on('pointerout',  () => { tweenScale(1.0);  tweenTint(0); });
    hit.on('pointerdown', (_p, _lx, _ly, e) => {
      e.stopPropagation();
      tweenScale(0.92, 70);
      tweenTint(0.30, 70);
    });
    hit.on('pointerup', () => {
      scene.tweens.add({
        targets: btn, scaleX: 1.06, scaleY: 1.06, duration: 90, ease: 'Back.Out',
        onComplete: () => {
          tweenScale(1.0, 110);
          tweenTint(0, 160);
          onTap();
        },
      });
    });

    btn.add(hit);
    btn._bg = bg; btn._label = label; btn._w = w; btn._h = h;
    this.root.add(btn);
    return btn;
  }

  _setBtnEnabled(btn, enabled) {
    btn.alpha = enabled ? 1 : 0.35;
    btn.list.forEach((child) => {
      if (child.input) child.input.enabled = !!enabled;
    });
  }

  _setBtnLabel(btn, text) {
    btn._label.setText(text);
  }

  _goto(idx) {
    this._page = Math.max(0, Math.min(this._pages.length - 1, idx));
    this._render();
  }

  _render() {
    const page = this._pages[this._page];
    if (!page) return;
    this._titleText.setText(page.title);
    this._bodyText.setText(page.body);
    this._pageText.setText(`${this._page + 1} / ${this._pages.length}`);
    this._setBtnEnabled(this._backBtn, this._page > 0);
    this._setBtnLabel(this._nextBtn, this._page >= this._pages.length - 1 ? 'DONE' : 'NEXT');
    this._renderSpotlight(page);
    this._positionRoot(page);
  }

  // Place the panel in the half of the screen OPPOSITE the focus area
  // so the highlighted UI element stays unblocked. If the focus center
  // is in the lower half of the screen, the panel sits in the upper
  // half, and vice versa. Pages with no focus center on the screen.
  _positionRoot(page) {
    if (!this.root) return;
    const sw = this.scene.scale.width;
    const sh = this.scene.scale.height;
    const focus = this._focusRectForPage(page);
    let desiredCy = sh / 2;
    if (focus) {
      const focusCy = focus.y + focus.h / 2;
      desiredCy = focusCy < sh / 2 ? Math.round(sh * 0.74) : Math.round(sh * 0.26);
    }
    const px = Math.max(PANEL_W / 2 + 8, Math.min(sw - PANEL_W / 2 - 8, sw / 2));
    const py = Math.max(PANEL_H / 2 + 8, Math.min(sh - PANEL_H / 2 - 8, desiredCy));
    this.root.setPosition(px, py);
  }

  // Spotlight effect — dim the entire screen EXCEPT the focus rect.
  // Implemented as 4 dark strips arranged around the focus rect (top,
  // bottom, left, right) so the focus area stays at full opacity. A
  // soft animated yellow border around the focus rect adds emphasis.
  // Falls back to a uniform dim when the page has no focus target.
  _renderSpotlight(page) {
    if (this._highlightTween) { this._highlightTween.stop(); this._highlightTween = null; }
    if (!this._dimGfx || !this._highlightGfx) return;
    this._dimGfx.clear();
    this._highlightGfx.clear();
    const sw = this.scene.scale.width;
    const sh = this.scene.scale.height;
    const focus = this._focusRectForPage(page);

    const DIM_ALPHA = 0.55;
    if (!focus) {
      // No focus → uniform dim across the whole screen.
      this._dimGfx.fillStyle(0x000000, DIM_ALPHA);
      this._dimGfx.fillRect(0, 0, sw, sh);
      return;
    }

    // Pad the focus rect so the bright area has a small breathing margin
    // around the targeted UI element.
    const PAD = 6;
    const fx = Math.max(0, focus.x - PAD);
    const fy = Math.max(0, focus.y - PAD);
    const fw = Math.min(sw, focus.x + focus.w + PAD) - fx;
    const fh = Math.min(sh, focus.y + focus.h + PAD) - fy;

    // 4 dim strips — top, bottom, left, right — leaving the focus rect
    // un-covered.
    this._dimGfx.fillStyle(0x000000, DIM_ALPHA);
    if (fy > 0)            this._dimGfx.fillRect(0, 0, sw, fy);                        // top
    if (fy + fh < sh)      this._dimGfx.fillRect(0, fy + fh, sw, sh - (fy + fh));      // bottom
    if (fx > 0)            this._dimGfx.fillRect(0, fy, fx, fh);                       // left
    if (fx + fw < sw)      this._dimGfx.fillRect(fx + fw, fy, sw - (fx + fw), fh);     // right

    // Soft animated yellow border around the focus rect for emphasis.
    const drawBorder = (alpha) => {
      this._highlightGfx.clear();
      this._highlightGfx.lineStyle(4, 0xffd33b, alpha);
      this._highlightGfx.strokeRoundedRect(fx, fy, fw, fh, 6);
    };
    const state = { alpha: 1 };
    drawBorder(state.alpha);
    this._highlightTween = this.scene.tweens.add({
      targets: state,
      alpha: 0.45,
      yoyo: true,
      repeat: -1,
      duration: 700,
      ease: 'Sine.easeInOut',
      onUpdate: () => drawBorder(state.alpha),
    });
  }

  // Resolve the screen-space focus rect for a page:
  //   targetSlot: number    → that single slot's rect
  //   targetArea: 'palette' → the entire palette bar
  //   targetArea: 'board'   → the board (interior + buffer ring)
  //   targetArea: 'composer'→ the blueprint draw grid
  //   targetArea: 'island'  → the four bottom buttons
  // Returns null if the targeted thing isn't ready / available, in which
  // case the spotlight falls back to a uniform dim.
  _focusRectForPage(page) {
    if (!page) return null;
    const scene = this.scene;
    if (page.targetArea === 'palette') {
      if (scene.paletteW == null || scene.paletteH == null) return null;
      return {
        x: scene.paletteOriginX,
        y: scene.paletteOriginY,
        w: scene.paletteW,
        h: scene.paletteH,
      };
    }
    if (page.targetArea === 'board') {
      if (scene.boardW == null || scene.boardOriginX == null) return null;
      const board = scene.level && scene.level.board;
      const cellPx = scene.pxCell || 0;
      const rows = board ? board.rows : 0;
      const boardH = rows * cellPx + Math.max(0, rows - 1) * 3;
      return {
        x: scene.boardOriginX,
        y: scene.boardOriginY,
        w: scene.boardW,
        h: boardH,
      };
    }
    if (page.targetArea === 'composer') {
      if (scene.drawCellPx == null || scene.drawGridOriginX == null) return null;
      return {
        x: scene.drawGridOriginX,
        y: scene.drawGridOriginY,
        w: scene.drawGridCols * scene.drawCellPx,
        h: scene.drawGridRows * scene.drawCellPx,
      };
    }
    if (page.targetArea === 'island') {
      if (scene.islandSlotW == null || scene.iconIslandOriginX == null) return null;
      return {
        x: scene.iconIslandOriginX,
        y: scene.iconIslandOriginY,
        w: scene.islandSlotW * 4,
        h: scene.islandH,
      };
    }
    if (page.targetArea === 'titleBar') {
      // Title bar lives at the top of the stack, centered on the board
      // horizontally. Used for the boss-mode Phase-1 slide so the slide
      // can talk about the BossPhaseIndicator (label + arrows) that
      // replaces the StepIndicator pills.
      if (scene.titleBarW == null || scene.boardOriginX == null) return null;
      const titleH = (scene.titleBar && scene.titleBar.constructor && scene.titleBar.constructor.HEIGHT) || 60;
      const cx = scene.boardOriginX + (scene.boardW || 0) / 2;
      const stackTop = scene.stackTop != null
        ? scene.stackTop
        : ((scene.contentBox && scene.contentBox.boxY) || 0);
      return {
        x: cx - scene.titleBarW / 2,
        y: stackTop + 12,
        w: scene.titleBarW,
        h: titleH,
      };
    }
    if (page.targetPhase != null) {
      // Highlight one of the BLOCKS / BLUEPRINT / EXPORT pills in the
      // title bar's StepIndicator.
      const steps = scene.titleBar && scene.titleBar.steps;
      if (steps && typeof steps.getBoxRect === 'function') return steps.getBoxRect(page.targetPhase);
      return null;
    }
    if (page.targetSlot != null) return this._slotRect(page.targetSlot);
    return null;
  }

  // Resolve the screen-space rect of the targeted palette slot.
  _slotRect(slotIdx) {
    const scene = this.scene;
    if (!scene._paletteBar) return null;
    const center = scene._paletteBar.slotCenter(slotIdx);
    const size = scene._paletteBar.slotSize();
    if (!center || !size) return null;
    return {
      x: scene.paletteOriginX + center.x - size.w / 2,
      y: scene.paletteOriginY + center.y - size.h / 2,
      w: size.w,
      h: size.h,
    };
  }
}
