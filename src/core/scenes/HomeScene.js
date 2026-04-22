import Phaser from 'phaser';
import { loadProgress } from '../progress.js';
import { nextUnbeaten, LEVELS } from '../catalog/index.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody } from '../render/FactoryBodyRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderBufferLabels } from '../render/BufferLabelRenderer.js';
import {
  renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline,
} from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { FunnelParticleSystem, collectFunnelsForParticles } from '../render/FunnelParticleSystem.js';
import { Simulation } from '../sim/Simulation.js';
import { shapeSquash } from '../render/pulse.js';
import { genId } from '../model/level.js';
import { COLOR_HEX } from '../model/shape.js';
import { BOARD_GAP, CYCLE_MS, SHAPE_SCALE, motionWarp, outlineWidth } from '../constants.js';

// Home menu rendered as a miniature live level. Three factory "buttons" sit
// inside a real bordered play area with an active shape stream flowing
// through them: a blue circle spawns from the top border, crosses each
// factory top→bottom, and sinks into the bottom border. Tapping any
// factory navigates to its associated scene.
//
// The scene deliberately reuses every render + sim primitive the game uses
// so Home looks identical in style to Player — no special-case chrome.

const SHAPE_WARP_AMP = 0.15;

const BOARD_MARGIN      = 18;

// Title words sit inside interior rows 2 and 3 as text overlays on the
// playable-area floor.
const TITLE_WORDS       = ['BLOCK', 'YARD'];

// Board is 9×9. Factories are 1×5 bars, each anchored at (row, col=2), so
// the factory interior spans abs cols 2..6 (leaving cols 1 and 7 as empty
// interior gutter). Title words sit on abs rows 2 and 3; factories on abs
// rows 4, 5, 6. Based on an authored level JSON — see the earlier spec.
const BOARD_COLS        = 9;
const BOARD_ROWS        = 9;
const FACTORY_WIDTH     = 5;          // cells across each factory bar
const FACTORY_COL       = 2;          // abs col anchor for every factory
const TITLE_ROWS_ABS    = [2, 3];     // absolute rows for "BLOCK" / "YARD"
const FACTORY_ROWS_ABS  = [4, 5, 6];  // absolute rows for the 3 button bars

// Shape types per factory circuit (taken from the reference level).
const TYPE_RED_TRI     = { form: 'triangle', color: 'red'   };
const TYPE_BLUE_CIRCLE = { form: 'circle',   color: 'blue'  };
const TYPE_GREEN_SQR   = { form: 'square',   color: 'green' };

// Factory 1 gets a green body (the "play" factory) to signal QUICK PLAY —
// or yellow once the player has cleared every level in the catalog.
const PLAY_FILL       = 0x4caf50;
const PLAY_STROKE     = 0x2e7a36;
const COMPLETE_FILL   = 0xf5c518;
const COMPLETE_STROKE = 0x8c6d15;

export default class HomeScene extends Phaser.Scene {
  constructor() { super({ key: 'Home' }); }

  async create() {
    disableMenuBg();
    fadeIn(this);
    // Phaser keeps scene instances alive across `scene.start`, so flags
    // like `_letterboxWired` survive into a re-entry. Resetting here
    // forces a fresh wireLetterboxChecker on every create — without it,
    // returning to Home from Player/Editor leaves the body painted with
    // the previous scene's pxCell + origin (or the menu .bg-scroll class
    // from LevelSelect/Community) instead of Home's own pattern.
    this._letterboxWired = false;

    const progress = await loadProgress();
    const beatenSet = new Set(progress.beaten);
    const unbeaten = nextUnbeaten(beatenSet);
    // `allComplete`: every catalog level has been beaten. Flips the top
    // button to a yellow "COMPLETE" tile; tap still replays the final level.
    this._allComplete = (unbeaten === null && LEVELS.length > 0);
    this._next = unbeaten || LEVELS[LEVELS.length - 1] || null;

    // Containers. Depths mirror PlayerScene so exterior checker covers the
    // outside of the board via the same cut-out trick.
    this.boardContainer        = this.add.container(0, 0).setDepth(0);
    this.shapeContainer        = this.add.container(0, 0).setDepth(10);
    // Ambient funnel particles sit just below the funnel triangles.
    this.factoryFunnelParticleContainer = this.add.container(0, 0).setDepth(13);
    this.funnelContainer       = this.add.container(0, 0).setDepth(15);
    this.interactiveContainer  = this.add.container(0, 0).setDepth(20);
    this.flowContainer         = this.add.container(0, 0).setDepth(22);
    this.exteriorContainer     = this.add.container(0, 0).setDepth(25);
    this.shadowContainer       = this.add.container(0, 0).setDepth(140);
    this.borderFunnelParticleContainer = this.add.container(0, 0).setDepth(143);
    this.borderFunnelContainer = this.add.container(0, 0).setDepth(145);
    this.labelContainer        = this.add.container(0, 0).setDepth(150);
    this.frameContainer        = this.add.container(0, 0).setDepth(160);
    this.buttonHitContainer    = this.add.container(0, 0).setDepth(200);

    this.level = this._buildLevel();
    this.factoryRefs   = new Map();   // id → { bodyWrap, funnelWrap }
    this.borderFunnelWraps = null;
    this.bufferLabelWraps  = null;
    this.flowUpdaters = [];
    this._buttons = [];
    this.simTime = 0;

    this._layoutAndRender();

    this._onResize = () => this._relayoutForViewport();
    this.scale.on('resize', this._onResize);

    this.events.on('shutdown', () => {
      if (this.sim) this.sim.stop();
      if (this._onResize) this.scale.off('resize', this._onResize);
      this._destroyButtons();
      for (const f of this.flowUpdaters) { try { f.destroy && f.destroy(); } catch (e) {} }
      this.flowUpdaters = [];
      if (this.factoryFunnelParticles) { this.factoryFunnelParticles.destroy(); this.factoryFunnelParticles = null; }
      if (this.borderFunnelParticles)  { this.borderFunnelParticles.destroy();  this.borderFunnelParticles  = null; }
      if (this._titleTexts) for (const t of this._titleTexts) { try { t.destroy(); } catch (e) {} }
      this._titleTexts = null;
    });

    this.ready = true;
  }

  // ---------- Level assembly ----------

  _buildLevel() {
    // Transcribed from the authored `untitled.blockyard` reference — three
    // 1×5 factory bars at abs rows 4/5/6, col 2, each with its own border
    // input/output pair. Types: red triangle (fac 1), blue circle (fac 2),
    // green square (fac 3). Factory 3 has ONE input feeding TWO outputs
    // (one right, one bottom).
    const rowCells = Array.from({ length: FACTORY_WIDTH }, (_, c) => ({ r: 0, c }));
    const anchorAt = (absRow) => ({ row: absRow, col: FACTORY_COL });
    const lastCol  = FACTORY_WIDTH - 1;   // factory-local col of the right edge

    const fac1 = {
      id: genId(),
      anchor: anchorAt(FACTORY_ROWS_ABS[0]),                // row 4
      cells: rowCells.map((cc) => ({ ...cc })),
      funnels: [
        { r: 0, c: 0,       side: 'top',   role: 'input'  },
        { r: 0, c: lastCol, side: 'right', role: 'output' },
      ],
      fill:   this._allComplete ? COMPLETE_FILL   : PLAY_FILL,
      stroke: this._allComplete ? COMPLETE_STROKE : PLAY_STROKE,
    };
    const fac2 = {
      id: genId(),
      anchor: anchorAt(FACTORY_ROWS_ABS[1]),                // row 5
      cells: rowCells.map((cc) => ({ ...cc })),
      funnels: [
        { r: 0, c: lastCol, side: 'right', role: 'input'  },
        { r: 0, c: 0,       side: 'left',  role: 'output' },
      ],
    };
    const fac3 = {
      id: genId(),
      anchor: anchorAt(FACTORY_ROWS_ABS[2]),                // row 6
      cells: rowCells.map((cc) => ({ ...cc })),
      funnels: [
        { r: 0, c: 0,       side: 'left',   role: 'input'  },
        { r: 0, c: lastCol, side: 'right',  role: 'output' },
        { r: 0, c: lastCol, side: 'bottom', role: 'output' },
      ],
    };
    const factories = [fac1, fac2, fac3];

    // Border funnels mirror the reference JSON exactly.
    const borderFunnels = [
      // Fac 1 circuit — red triangle, top → right.
      { r: 0, c: FACTORY_COL,         side: 'bottom', role: 'input',  __type: TYPE_RED_TRI    },
      { r: 4, c: BOARD_COLS - 1,      side: 'left',   role: 'output', __type: TYPE_RED_TRI    },
      // Fac 2 circuit — blue circle, right → left.
      { r: 5, c: BOARD_COLS - 1,      side: 'left',   role: 'input',  __type: TYPE_BLUE_CIRCLE },
      { r: 5, c: 0,                   side: 'right',  role: 'output', __type: TYPE_BLUE_CIRCLE },
      // Fac 3 circuit — green square, one input (left) → two outputs (right + bottom).
      { r: 6, c: 0,                   side: 'right',  role: 'input',  __type: TYPE_GREEN_SQR  },
      { r: 6, c: BOARD_COLS - 1,      side: 'left',   role: 'output', __type: TYPE_GREEN_SQR  },
      { r: BOARD_ROWS - 1, c: FACTORY_COL + lastCol, side: 'top', role: 'output', __type: TYPE_GREEN_SQR },
    ];

    const inputs  = borderFunnels.filter((f) => f.role === 'input').map(({ __type, ...f }) => ({ ...f, type: { ...__type } }));
    const outputs = borderFunnels.filter((f) => f.role === 'output').map(({ __type, ...f }) => ({ ...f, type: { ...__type } }));

    return {
      board: { cols: BOARD_COLS, rows: BOARD_ROWS },
      inputs, outputs,
      border: { funnels: borderFunnels.map(({ __type, ...f }) => ({ ...f })) },
      factories,
      lockedFactories: [],
      initialFactories: [],
    };
  }

  // ---------- Layout ----------

  _computeLayout() {
    const box = compute920Box(this);
    const { boxX, boxY, boxW, boxH } = box;
    const availW = boxW - BOARD_MARGIN * 2;
    const availH = boxH - BOARD_MARGIN * 2;
    const cellW = (availW - BOARD_GAP * (BOARD_COLS - 1)) / BOARD_COLS;
    const cellH = (availH - BOARD_GAP * (BOARD_ROWS - 1)) / BOARD_ROWS;
    const pxCell = Math.max(24, Math.floor(Math.min(cellW, cellH)));
    const boardW = BOARD_COLS * pxCell + (BOARD_COLS - 1) * BOARD_GAP;
    const boardH = BOARD_ROWS * pxCell + (BOARD_ROWS - 1) * BOARD_GAP;
    const boardOriginX = boxX + Math.round((boxW - boardW) / 2);
    const boardOriginY = boxY + Math.round((boxH - boardH) / 2);
    return { boxX, boxY, boxW, boxH, pxCell, boardW, boardH, boardOriginX, boardOriginY };
  }

  _layoutAndRender() {
    const L = this._computeLayout();
    this.pxCell = L.pxCell;
    this.boardOriginX = L.boardOriginX;
    this.boardOriginY = L.boardOriginY;

    const setPos = (cnt, x, y) => cnt.setPosition(x, y);
    setPos(this.boardContainer,        L.boardOriginX, L.boardOriginY);
    setPos(this.shapeContainer,        L.boardOriginX, L.boardOriginY);
    if (this.factoryFunnelParticleContainer) setPos(this.factoryFunnelParticleContainer, L.boardOriginX, L.boardOriginY);
    setPos(this.funnelContainer,       L.boardOriginX, L.boardOriginY);
    setPos(this.interactiveContainer,  L.boardOriginX, L.boardOriginY);
    setPos(this.flowContainer,         L.boardOriginX, L.boardOriginY);
    setPos(this.exteriorContainer,     L.boardOriginX, L.boardOriginY);
    setPos(this.shadowContainer,       L.boardOriginX, L.boardOriginY);
    if (this.borderFunnelParticleContainer) setPos(this.borderFunnelParticleContainer, L.boardOriginX, L.boardOriginY);
    setPos(this.borderFunnelContainer, L.boardOriginX, L.boardOriginY);
    setPos(this.labelContainer,        L.boardOriginX, L.boardOriginY);
    setPos(this.frameContainer,        L.boardOriginX, L.boardOriginY);

    // Title words sit ON TOP of absolute rows 2 and 3 — text with inline
    // shape glyphs. The "O" in BLOCK becomes a blue circle; the "A" in
    // YARD becomes a green triangle. Each row is wrapped in its own
    // container so it can pulse with the same `shapeSquash` body scale
    // the factories use.
    this._destroyTitle();
    this._titleTexts = [];
    this._titleWraps = [];
    const step = L.pxCell + BOARD_GAP;
    // Horizontal center of the factory column so the title and the three
    // buttons share the same vertical midline.
    const factoryRightEdge = L.boardOriginX + (FACTORY_COL + FACTORY_WIDTH) * step - BOARD_GAP;
    const factoryWidthPx   = FACTORY_WIDTH * step - BOARD_GAP;
    const titleCenterX     = factoryRightEdge - factoryWidthPx / 2;
    const titleFontPx = Math.floor(L.pxCell * 0.95);

    // BLOCK keeps the inline circle glyph for the "O"; YARD is plain
    // text. All pieces render black with a white stroke.
    const rowSpecs = [
      { word: 'BLOCK', splitIdx: 2, form: 'circle', color: 0x000000 },   // BL | ⦿ | CK
      { word: 'YARD',  splitIdx: -1, form: null,    color: 0x000000 },   // plain text
    ];
    for (let i = 0; i < rowSpecs.length; i++) {
      const { word, splitIdx, form, color } = rowSpecs[i];
      const absRow = TITLE_ROWS_ABS[i];
      const cy = L.boardOriginY + absRow * step + L.pxCell / 2;
      if (form && splitIdx >= 0) {
        const prefix = word.slice(0, splitIdx);
        const suffix = word.slice(splitIdx + 1);
        this._drawTitleWithGlyph(titleCenterX, cy, prefix, suffix, form, color, titleFontPx);
      } else {
        this._drawTitleText(titleCenterX, cy, word, color, titleFontPx);
      }
    }

    this._renderBoard();
    this._destroyButtons();
    this._buildFactoryButtons(L);

    // Letterbox checker so the brown pattern wraps the canvas just like in
    // Player. Must run after `pxCell` + board origin are known.
    if (!this._letterboxWired) {
      wireLetterboxChecker(this, () => ({
        pxCell: this.pxCell,
        boardOriginX: this.boardOriginX,
        boardOriginY: this.boardOriginY,
      }));
      this._letterboxWired = true;
    }

    // Sim + shape renderer. Recreated on relayout so pxCell matches.
    if (this.shapeRenderer) this.shapeRenderer.clearAll && this.shapeRenderer.clearAll();
    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    if (this.sim) this.sim.stop();
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn:  (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: () => {},
    });
    this.simTime = 0;
    this.sim.start(this.level, 0);

    // Ambient funnel particles — rebuilt/resized alongside the sim so
    // sizing stays in sync with the current pxCell. Safe to call on every
    // layout: destroy-and-recreate keeps the funnel list fresh.
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.destroy();
    if (this.borderFunnelParticles)  this.borderFunnelParticles.destroy();
    this.factoryFunnelParticles = new FunnelParticleSystem(this, this.factoryFunnelParticleContainer, { pxCell: this.pxCell });
    this.borderFunnelParticles  = new FunnelParticleSystem(this, this.borderFunnelParticleContainer,  { pxCell: this.pxCell });
    const { factory, border } = collectFunnelsForParticles(this.level, this.pxCell, BOARD_GAP, SHAPE_SCALE);
    this.factoryFunnelParticles.setFunnels(factory);
    this.borderFunnelParticles.setFunnels(border);
  }

  _renderBoard() {
    // Clear dynamic containers before repainting.
    this.factoryRefs.clear();
    for (const f of this.flowUpdaters) { try { f.destroy && f.destroy(); } catch (e) {} }
    this.flowUpdaters = [];
    this.boardContainer.removeAll(true);
    this.funnelContainer.removeAll(true);
    this.interactiveContainer.removeAll(true);
    this.flowContainer.removeAll(true);
    this.exteriorContainer.removeAll(true);
    this.shadowContainer.removeAll(true);
    this.borderFunnelContainer.removeAll(true);
    this.labelContainer.removeAll(true);
    this.frameContainer.removeAll(true);

    renderInteriorFloor(this, this.boardContainer, { board: this.level.board, pxCell: this.pxCell });
    const border = renderBorder(this, this.boardContainer, this.borderFunnelContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.borderFunnelWraps = border.wraps;

    for (const fac of this.level.factories) this._drawFactory(fac);

    renderExteriorCheckers(this, this.exteriorContainer, {
      board: this.level.board, pxCell: this.pxCell,
      boardOriginX: this.boardOriginX, boardOriginY: this.boardOriginY,
    });
    renderFrameShadow(this, this.shadowContainer, { board: this.level.board, pxCell: this.pxCell });
    renderFrameOutline(this, this.frameContainer, { board: this.level.board, pxCell: this.pxCell });
    this.bufferLabelWraps = renderBufferLabels(this, this.labelContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
  }

  _drawFactory(factory) {
    const absCells = factory.cells.map((cc) => ({
      ...cc, r: factory.anchor.row + cc.r, c: factory.anchor.col + cc.c,
    }));
    const absFunnels = factory.funnels.map((f) => ({
      ...f, r: factory.anchor.row + f.r, c: factory.anchor.col + f.c,
    }));
    const [cx, cy] = factoryCenter(absCells, this.pxCell, BOARD_GAP);

    const funnelWrap = this.add.container(cx, cy);
    const bodyWrap   = this.add.container(cx, cy);
    this.interactiveContainer.add(bodyWrap);
    this.funnelContainer.add(funnelWrap);

    const funnels = renderFunnels(this, funnelWrap, absFunnels, {
      pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    funnels.setPosition(-cx, -cy);
    const body = renderFactoryBody(this, bodyWrap, {
      cells: absCells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      fill: factory.fill, stroke: factory.stroke,
    });
    body.setPosition(-cx, -cy);
    // No renderFlow() on Home — the dashed manifold would read as
    // distracting UI. Shapes still stream through via the sim; just no
    // per-factory flow graph overlay.
    this.factoryRefs.set(factory.id, { bodyWrap, funnelWrap, absCells });
  }

  // ---------- Buttons ----------

  _buildFactoryButtons(L) {
    const labelFor = (idx) => {
      if (idx === 0) {
        if (this._allComplete) return 'COMPLETE';
        if (!this._next) return 'PLAY';
        // Bosses have `number === null` (stamped in catalog). Show a
        // BOSS-N label on the quick-play tile when the next step is a
        // boss fight instead of the usual LEVEL-N.
        if (this._next.boss) return `BOSS ${this._next.bossIndex ?? ''}`.trim();
        return `LEVEL ${this._next.number}`;
      }
      if (idx === 1) return 'LEVEL SELECT';
      return 'COMMUNITY';
    };
    const onTapFor = (idx) => {
      if (idx === 0) return () => { if (this._next) fadeTo(this, 'Player', { levelId: this._next.id }); };
      if (idx === 1) return () => fadeTo(this, 'LevelSelect');
      return () => fadeTo(this, 'Community');
    };

    this.level.factories.forEach((fac, idx) => {
      const ref = this.factoryRefs.get(fac.id);
      if (!ref) return;
      const absCells = ref.absCells;
      const [cx, cy] = factoryCenter(absCells, this.pxCell, BOARD_GAP);
      const worldX = this.boardOriginX + cx;
      const worldY = this.boardOriginY + cy;

      // Factory footprint in board-local px.
      const step = this.pxCell + BOARD_GAP;
      let minC = Infinity, maxC = -Infinity;
      for (const { c } of absCells) { if (c < minC) minC = c; if (c > maxC) maxC = c; }
      const factoryW = (maxC - minC + 1) * step - BOARD_GAP;
      const factoryH = this.pxCell;

      // Label lives inside the bodyWrap (so pulse scales it with the
      // factory), centered on the factory body. The top button flips to
      // black text when it reads "COMPLETE" over yellow — white on
      // yellow is too low-contrast.
      const fontSize = Math.max(12, Math.min(32, Math.floor(this.pxCell * 0.44)));
      const textColor = (idx === 0 && this._allComplete) ? '#000000' : '#ffffff';
      const label = this.add.text(0, 0, labelFor(idx), {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontSize}px`,
        fontStyle: 'bold',
        color: textColor,
      }).setOrigin(0.5);
      ref.bodyWrap.add(label);

      // Transparent hit rect in scene space so pointer-over scaling animates
      // the bodyWrap (which contains the label) without interfering with the
      // pulse. Sits on the overlay-hit container so depth beats every other
      // board layer.
      const hit = this.add.rectangle(worldX, worldY, factoryW - 4, factoryH - 4, 0xffffff, 0)
        .setInteractive({ useHandCursor: true });
      this.buttonHitContainer.add(hit);

      const onTap = onTapFor(idx);
      this._attachTapJuice(hit, ref, onTap);

      this._buttons.push({ hit, label });
    });
  }

  _attachTapJuice(hit, ref, onTap) {
    const pair = [ref.bodyWrap, ref.funnelWrap];
    const killAll = () => { try { this.tweens.killTweensOf(pair); } catch (e) {} };
    // The pulse in update() re-asserts scale each frame — hover/press fight
    // it if we tween directly. Instead we store a multiplier on the wrap
    // that the update loop multiplies the pulse scale by.
    ref._juice = { mult: 1, pressed: false };

    const tweenMult = (to, duration, ease) => {
      killAll();
      this.tweens.add({
        targets: ref._juice, mult: to, duration, ease,
      });
    };

    hit.on('pointerover', () => { if (!ref._juice.pressed) tweenMult(1.04, 140, 'Sine.Out'); });
    hit.on('pointerout',  () => { ref._juice.pressed = false; tweenMult(1.0, 180, 'Sine.Out'); });
    hit.on('pointerdown', () => { ref._juice.pressed = true; tweenMult(0.93, 90, 'Sine.Out'); });
    hit.on('pointerup',   () => {
      ref._juice.pressed = false;
      tweenMult(1.0, 240, 'Back.Out');
      if (onTap) onTap();
    });
  }

  _destroyButtons() {
    for (const b of this._buttons) {
      try { b.hit.destroy(); } catch (e) {}
      try { b.label.destroy(); } catch (e) {}
    }
    this._buttons = [];
  }

  _destroyTitle() {
    if (this._titleTexts) for (const t of this._titleTexts) { try { t.destroy(); } catch (e) {} }
    this._titleTexts = null;
    this._titleWraps = null;
  }

  // Render a title row like "BL [circle] CK" inside a Phaser Container so
  // the whole row can scale-pulse with the same `shapeSquash` body curve
  // the factories use. Glyph stroke width is shared between the shape
  // outline and the white stroke on the flanking text, so the row feels
  // like one alphabet.
  // Plain-text title row (no inline shape glyph). Centered on `cx` and
  // wrapped in a container so it pulses with the factories.
  _drawTitleText(cx, cy, word, color, fontPx) {
    const strokeW = outlineWidth(this.pxCell);
    const style = {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${fontPx}px`,
      fontStyle: 'bold',
      color: colorToCss(color),
      stroke: '#ffffff',
      strokeThickness: strokeW * 2,
    };
    const text = this.make.text({ x: 0, y: 0, text: word, style, add: false }).setOrigin(0.5);
    const wrap = this.add.container(cx, cy).setDepth(180);
    wrap.add(text);
    this._titleTexts.push(wrap);
    this._titleWraps.push(wrap);
  }

  _drawTitleWithGlyph(cx, cy, prefix, suffix, form, color, fontPx) {
    const glyphR = Math.round(fontPx * 0.36);
    // Stroke thickness matches the live sim shape border (`outlineWidth`),
    // so the title glyphs and the flowing shapes share one outline weight.
    const strokeW = outlineWidth(this.pxCell);
    // Pull the glyph toward its neighbors so the text-stroke padding on
    // each side is the only visible spacing — anything positive here
    // reads as a literal space in the middle of the word.
    const GAP = -strokeW;

    const style = {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${fontPx}px`,
      fontStyle: 'bold',
      color: colorToCss(color),
      stroke: '#ffffff',
      // Phaser Text draws the stroke first then the fill on top, so half
      // the nominal stroke width lives inside the glyph and gets painted
      // over. Graphics, by contrast, strokes OVER the fill so the full
      // `strokeW` is visible. Double the text stroke so both visuals
      // land at the same on-screen thickness.
      strokeThickness: strokeW * 2,
    };

    // Layout is centered: the row's combined width is split in half
    // around local x=0. Children are positioned left-to-right from
    // -totalW/2.
    const pre = this.make.text({ x: 0, y: 0, text: prefix, style, add: false }).setOrigin(0, 0.5);
    const suf = this.make.text({ x: 0, y: 0, text: suffix, style, add: false }).setOrigin(0, 0.5);
    const glyphW = glyphR * 2;
    const totalW = pre.width + GAP + glyphW + GAP + suf.width;
    const startX = -totalW / 2;
    pre.x = startX;
    const glyphX = startX + pre.width + GAP + glyphR;
    suf.x = glyphX + glyphR + GAP;

    const gfx = this.make.graphics({ add: false });
    gfx.lineStyle(strokeW, 0xffffff, 1);
    gfx.fillStyle(color, 1);
    if (form === 'circle') {
      gfx.fillCircle(glyphX, 0, glyphR);
      gfx.strokeCircle(glyphX, 0, glyphR);
    } else if (form === 'triangle') {
      // Bounding-box-centered (point at -glyphR, base at +glyphR) so the
      // glyph's visual midline sits on the text's vertical center.
      const halfBase = glyphR * 1.05;
      gfx.beginPath();
      gfx.moveTo(glyphX,            -glyphR);
      gfx.lineTo(glyphX - halfBase,  glyphR);
      gfx.lineTo(glyphX + halfBase,  glyphR);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    }

    const wrap = this.add.container(cx, cy).setDepth(180);
    wrap.add(pre); wrap.add(suf); wrap.add(gfx);
    this._titleTexts.push(wrap);
    this._titleWraps.push(wrap);
  }

  // ---------- Viewport ----------

  _relayoutForViewport() {
    if (!this.ready) return;
    this._destroyButtons();
    this._layoutAndRender();
  }

  // ---------- Update loop ----------

  update(time, delta) {
    if (!this.ready) return;
    this.simTime += delta;
    const t = (this.simTime % CYCLE_MS) / CYCLE_MS;
    const sq = shapeSquash(t);
    // Title pulses on the opposite half-cycle from the factories, so when
    // the buttons compress the title words expand and vice versa.
    const sqOpp = shapeSquash((t + 0.5) % 1);

    // Pulse each factory — multiplied by any hover/press juice multiplier so
    // the two systems compose rather than fight for the scale slot.
    for (const entry of this.factoryRefs.values()) {
      const m = (entry._juice && entry._juice.mult) || 1;
      if (entry.bodyWrap)   { entry.bodyWrap.scaleX   = sq.body.scaleX    * m; entry.bodyWrap.scaleY   = sq.body.scaleY    * m; }
      if (entry.funnelWrap) { entry.funnelWrap.scaleX = sq.funnels.scaleX * m; entry.funnelWrap.scaleY = sq.funnels.scaleY * m; }
    }
    if (this.borderFunnelWraps) {
      for (const w of this.borderFunnelWraps) { w.scaleX = sq.funnels.scaleX; w.scaleY = sq.funnels.scaleY; }
    }
    if (this.bufferLabelWraps) {
      for (const w of this.bufferLabelWraps) { w.scaleX = sq.body.scaleX; w.scaleY = sq.body.scaleY; }
    }
    if (this._titleWraps) {
      for (const w of this._titleWraps) { w.scaleX = sqOpp.body.scaleX; w.scaleY = sqOpp.body.scaleY; }
    }

    for (const f of this.flowUpdaters) f.update(time);

    if (this.sim) {
      this.sim.update(this.simTime);
      const warp = motionWarp(this.simTime / CYCLE_MS);
      const warpStretch = 1 + warp * SHAPE_WARP_AMP;
      for (const shape of this.sim.shapes) {
        if (shape.dead) continue;
        const base = this.sim.shapeScale(shape, this.simTime);
        const alongX = shape.dx !== 0 ? warpStretch : 1 / warpStretch;
        const alongY = shape.dy !== 0 ? warpStretch : 1 / warpStretch;
        this.shapeRenderer.update(shape, base * alongX, base * alongY);
      }
    }
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.update(time);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.update(time);
  }
}

// Local copy of the same helper used in PlayerScene / EditorScene — kept
// inline to avoid a new export for a 10-line utility.
function colorToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

function factoryCenter(cells, pxCell, pxGap) {
  if (!cells || cells.length === 0) return [0, 0];
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const { r, c } of cells) {
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (c < minC) minC = c; if (c > maxC) maxC = c;
  }
  const step = pxCell + pxGap;
  return [
    ((minC + maxC) * step + pxCell) / 2,
    ((minR + maxR) * step + pxCell) / 2,
  ];
}
