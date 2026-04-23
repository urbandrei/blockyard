import Phaser from 'phaser';
import { loadLevel, genId } from '../model/level.js';
import {
  rotateFactoryShape, isBorderCell, normalizeFactory, isObstacleFactory,
} from '../model/shape.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody, renderLockedTint, drawBoltInto } from '../render/FactoryBodyRenderer.js';
import { renderAcidPits } from '../render/AcidPitRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderFlow } from '../render/FlowRenderer.js';
import { renderBufferLabels } from '../render/BufferLabelRenderer.js';
import { renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline } from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { LaserRenderer } from '../render/LaserRenderer.js';
import { FunnelParticleSystem, collectFunnelsForParticles, collectFactoryFunnelsForParticles } from '../render/FunnelParticleSystem.js';
import { BufferMarkerRenderer } from '../render/BufferMarkerRenderer.js';
import { TitleBar } from '../ui/TitleBar.js';
import { HintConfirmModal } from '../ui/HintConfirmModal.js';
import { HintNudgePopup } from '../ui/HintNudgePopup.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { compute920Box } from '../ui/ContentBox.js';
import { Simulation } from '../sim/Simulation.js';
import { DragController } from '../input/DragController.js';
import { shapeSquash } from '../render/pulse.js';
import { drawHome, drawGrid, drawCircleArrow, drawPlayTriangle } from '../ui/Icons.js';
import { getLevelById, nextLevelAfter } from '../catalog/index.js';
import { markBeaten } from '../progress.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import {
  BOARD_GAP, CYCLE_MS, SHAPE_SCALE, motionWarp,
  BLUEPRINT_BG, BLUEPRINT_DOT, BLUEPRINT_STROKE,
} from '../constants.js';

const SHAPE_WARP_AMP = 0.15;
const TOOLBAR_H = TitleBar.HEIGHT + 8;

const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;

// Icon island slots: BACK | (gap) | RESET | PLAY.
// Icon island — three evenly-spread shortcuts. PLAY / RESET that drive the
// actual simulation have been promoted out of the island into a prominent
// overlay in the blueprint area (see _renderBlueprint).
const ICON_SLOTS           = 3;
const SLOT_HOME            = 0;
const SLOT_LEVEL_SELECT    = 1;
const SLOT_RESET           = 2;

// Player scene: load a level (catalog or sandbox), present an interactive
// blueprint of starting factories, let the player drag/rotate them onto the
// play area, then PLAY → run the sim until every output is satisfied.

export default class PlayerScene extends Phaser.Scene {
  constructor() { super({ key: 'Player' }); }

  init(data) {
    this._levelId = (data && data.levelId) || null;
    // CommunityScene passes a fully-formed level object so the player can
    // run levels that aren't in the catalog (locally-saved + imported).
    this._inlineLevel = (data && data.levelData) || null;
  }

  async create() {
    disableMenuBg();
    fadeIn(this);
    this.ready = false;
    this.simState = 'idle';        // 'idle' | 'running' | 'paused'
    this.simTime  = 0;             // virtual clock — only advances when running
    this.satisfiedOutputs = new Set();
    this.satisfiedCollectors = new Set();
    this.victory = null;
    this.factoryRefs = new Map();  // id → { bodyWrap, funnelWrap }
    this.blueprintRefs = new Map();// id → { bodyWrap, funnelWrap }
    this.flowUpdaters = [];

    // Back-drop chrome (brown exterior, inner shadow, black frame outline)
    // sits at LOW depths so shapes + laser beams render on top of the black
    // border and the brown buffer checker. Factories/funnels still layer
    // above shapes/lasers — the relative play-area z-order is preserved.
    this.boardContainer        = this.add.container(0, 0).setDepth(0);
    this.exteriorContainer     = this.add.container(0, 0).setDepth(2);
    this.shadowContainer       = this.add.container(0, 0).setDepth(4);
    this.frameContainer        = this.add.container(0, 0).setDepth(5);
    this.acidPitContainer      = this.add.container(0, 0).setDepth(7);
    this.shapeContainer        = this.add.container(0, 0).setDepth(10);
    this.laserContainer        = this.add.container(0, 0).setDepth(12);
    this.factoryFunnelParticleContainer = this.add.container(0, 0).setDepth(13);
    this.borderFunnelParticleContainer  = this.add.container(0, 0).setDepth(14);
    this.funnelContainer       = this.add.container(0, 0).setDepth(15);
    this.interactiveContainer  = this.add.container(0, 0).setDepth(20);
    this.flowContainer         = this.add.container(0, 0).setDepth(22);
    // Border funnels + emitter glyphs, buffer label tiles, and sink-resolve
    // markers all render ABOVE the black frame outline so the centered box
    // cluster (triangle + tile + marker) reads as ONE piece on top of the
    // border line — rather than the frame cutting through each of them.
    this.borderFunnelContainer = this.add.container(0, 0).setDepth(163);
    this.labelContainer        = this.add.container(0, 0).setDepth(165);
    this.bufferMarkerContainer = this.add.container(0, 0).setDepth(168);
    this.blueprintContainer    = this.add.container(0, 0).setDepth(50);
    this.blueprintFlowContainer= this.add.container(0, 0).setDepth(51);
    this.blueprintBodyContainer= this.add.container(0, 0).setDepth(52);
    // Persistent overlay that survives _renderBlueprint's removeAll — lets
    // the PLAY + RESET tiles fade out when the user picks a factory back up
    // and fade back in only after the last factory is released.
    this.blueprintOverlayContainer = this.add.container(0, 0).setDepth(53);
    this.iconIslandContainer   = this.add.container(0, 0).setDepth(54);
    this.ghostContainer        = this.add.container(0, 0).setDepth(70);
    this.placementContainer    = this.add.container(0, 0).setDepth(80);

    // Resolve the level. Priority: inline level (from CommunityScene) →
    // catalog level by id → editor sandbox fallback.
    let source = this._inlineLevel || (this._levelId ? getLevelById(this._levelId) : null);
    if (!source) source = await loadLevel();
    // Boss levels: keep the original around for future round transitions
    // and use the round-0 composition as the active sourceLevel. RESET
    // and scene shutdown both put the boss back at round 0 (no mid-boss
    // save state per the user's spec).
    if (source && source.boss) {
      this._sourceLevelOriginal = source;
      this._bossState = { roundIdx: 0, locked: [] };
      this.sourceLevel = bossRoundLevel(source, 0, []);
    } else {
      this._sourceLevelOriginal = source;
      this._bossState = null;
      this.sourceLevel = source;
    }

    this._initRuntime();
    this._layoutBoardAndBlueprint();
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
    this._buildToolbar();
    // Toolbar was just (re)built — the earlier _renderAll/_renderBlueprint
    // calls couldn't update the hint button because it didn't exist yet.
    this._updateHintButtonState();

    wireLetterboxChecker(this, () => ({
      pxCell: this.pxCell,
      boardOriginX: this.boardOriginX,
      boardOriginY: this.boardOriginY,
    }));

    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this._composeLevel(), {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (accepted && funnel.ownerId === 'border') this._onOutputSatisfied(funnel);
      },
      onCollectorSatisfied: (c) => this._onCollectorSatisfied(c),
    });
    // Populate laser state without starting the sim so each emitter renders
    // its idle charge animation before the player presses Play.
    this.sim.prepEntities(this._composeLevel());
    if (this.laserRenderer) this.laserRenderer.destroy();
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });
    this.factoryFunnelParticles = new FunnelParticleSystem(this, this.factoryFunnelParticleContainer, { pxCell: this.pxCell });
    this.borderFunnelParticles  = new FunnelParticleSystem(this, this.borderFunnelParticleContainer,  { pxCell: this.pxCell });
    this._refreshFunnelParticles();

    this.dragCtrl = new DragController(this, {
      isOverCell:      (x, y) => this._cellAt(x, y),
      isOverEdge:      () => null,
      isOverBoardCell: (x, y) => this._boardCellAt(x, y),
      onToggleCell:    (info) => this._onTapCell(info),
      onToggleFunnel:  () => {},
      onDragStart:     (info) => this._onDragStart(info),
      onDragMove:      (x, y) => this._onDragMove(x, y),
      onDragEnd:       (info) => this._onDragEnd(info),
      canDrag:         (info) => this._canDrag(info),
      isPlaying:       () => this.simState !== 'idle' || !!this.victory,
    });

    // Pause-on-tap during a running sim. Bound at low priority — the icon
    // hits + drag controller still get their pointerup first because they're
    // attached to specific objects with their own listeners.
    this.input.on('pointerdown', (pointer) => this._maybeStopOnTap(pointer));

    this._onScaleResize = () => this._relayoutForViewport();
    this.scale.on('resize', this._onScaleResize);

    this._startStuckPopupTimer();

    this.events.on('shutdown', () => {
      this.sim && this.sim.stop();
      this.dragCtrl && this.dragCtrl.destroy();
      this._resetStuckPopup();
      if (this._hintModal) { this._hintModal.destroy(); this._hintModal = null; }
      this._teardownBlueprintPlayButtons();
      if (this.factoryFunnelParticles) { this.factoryFunnelParticles.destroy(); this.factoryFunnelParticles = null; }
      if (this.borderFunnelParticles)  { this.borderFunnelParticles.destroy();  this.borderFunnelParticles  = null; }
      if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
      if (this.blueprintParticleSystems) { for (const s of this.blueprintParticleSystems) s.destroy(); this.blueprintParticleSystems = null; }
      if (this._victoryTextBg) { this._victoryTextBg.destroy(); this._victoryTextBg = null; }
      if (this._victoryTextName) { this._victoryTextName.destroy(); this._victoryTextName = null; }
      if (this._victoryTextSub)  { this._victoryTextSub.destroy();  this._victoryTextSub  = null; }
      if (this._acidPits)        { this._acidPits.destroy();        this._acidPits        = null; }
      if (this._onScaleResize) this.scale.off('resize', this._onScaleResize);
      // Phaser reuses the scene instance across scene.start() transitions,
      // so properties survive into the next create(). The first _renderAll()
      // of the next run would otherwise see the old titleBar (with destroyed
      // children) and crash when we try to toggle its hit region.
      this.titleBar = null;
      this.factoryRefs && this.factoryRefs.clear && this.factoryRefs.clear();
      this.blueprintRefs && this.blueprintRefs.clear && this.blueprintRefs.clear();
    });

    this.ready = true;
  }

  // ===================================================================
  //   Runtime state
  // ===================================================================

  _initRuntime() {
    const lvl = this.sourceLevel;
    // Each placed factory is { id, source:'locked'|'initial', anchor, rotation,
    //   baseCells, baseFunnels, converter?, locked }. `baseCells`/`baseFunnels`
    //   are the un-rotated authored shape; the rotated cells are derived on
    //   demand for rendering / placement / sim composition.
    this.placed = new Map();
    // Blueprint stacks: slotKey "r,c" → array of factory IDs (top of stack
    // last). Each entry is also tracked in this.blueprintFactories.
    this.blueprint = new Map();
    this.blueprintFactories = new Map();   // id → { baseCells, baseFunnels, converter?, slot, rotation }
    this.startingState = { placed: [], blueprint: [] };

    // Locked factories — always on the board, painted with a pin. Anchored
    // and never rotated (their authored anchor + rotation = 0 are canonical).
    for (const lf of (lvl.lockedFactories || [])) {
      const id = lf.id || genId();
      const norm = normalizeFactory(lf.cells, lf.funnels || []);
      this.placed.set(id, {
        id, source: 'locked', anchor: { ...lf.anchor },
        rotation: 0,
        baseCells: norm.cells, baseFunnels: norm.funnels,
        converter: lf.converter, locked: true,
      });
    }

    // Initial factories — start in their declared blueprint slots. If two
    // declare the same slot, spread the second into the next free slot
    // (per D5: no overlap on the player's initial layout). Internally slots
    // are tracked as { r, c } (the catalog uses { row, col } so we translate).
    for (const it of (lvl.initialFactories || [])) {
      const id = it.id || genId();
      const norm = normalizeFactory(it.cells, it.funnels || []);
      const requested = it.slot ? { r: it.slot.row, c: it.slot.col } : { r: 0, c: 0 };
      const slot = this._claimFreeSlot(requested);
      const def = {
        id,
        baseCells: norm.cells, baseFunnels: norm.funnels,
        converter: it.converter,
        slot,                         // current slot {r,c}
        defaultSlot: { ...slot },     // remembered for RESET
        rotation: it.rotation || 0,
        defaultRotation: it.rotation || 0,
      };
      this.blueprintFactories.set(id, def);
      this._pushToSlot(slot, id);
      this.startingState.blueprint.push({ id, slot: { ...slot }, rotation: def.rotation });
    }

    // Community-level fallback: editor-authored levels keep their factories
    // in `level.factories[]` rather than the player-friendly `lockedFactories`
    // / `initialFactories` split. When neither of those is populated, treat
    // the authored factories as "already-placed" — the player sees the
    // puzzle as it was designed and can re-arrange or hit PLAY immediately.
    const noPlayerLayout =
      (lvl.lockedFactories || []).length === 0 &&
      (lvl.initialFactories || []).length === 0 &&
      Array.isArray(lvl.factories) && lvl.factories.length > 0;
    if (noPlayerLayout) {
      for (const fac of lvl.factories) {
        const id = fac.id || genId();
        const norm = normalizeFactory(fac.cells, fac.funnels || []);
        this.placed.set(id, {
          id, source: 'initial', anchor: { ...fac.anchor },
          rotation: 0,
          baseCells: norm.cells, baseFunnels: norm.funnels,
          converter: fac.converter, locked: false,
        });
        this.startingState.placed.push({
          id, anchor: { ...fac.anchor }, rotation: 0,
          baseCells: norm.cells, baseFunnels: norm.funnels, converter: fac.converter,
        });
      }
    }
  }

  // Find a free slot starting from the requested one, scanning row-major.
  _claimFreeSlot(requested) {
    const rows = this._slotRows();
    const cols = this._slotCols();
    const startR = Math.max(0, Math.min(rows - 1, (requested && requested.r) || 0));
    const startC = Math.max(0, Math.min(cols - 1, (requested && requested.c) || 0));
    if (!this._slotOccupied(startR, startC)) return { r: startR, c: startC };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!this._slotOccupied(r, c)) return { r, c };
      }
    }
    return { r: 0, c: 0 };  // last-resort fallback (will stack)
  }

  _slotRows() {
    return Math.max(1, (this.sourceLevel.board.rows - 2) + 1);
  }
  _slotCols() {
    return Math.max(1, (this.sourceLevel.board.cols - 2) + 1);
  }

  _slotOccupied(r, c) {
    const stack = this.blueprint.get(slotKey(r, c));
    return !!stack && stack.length > 0;
  }

  _pushToSlot(slot, factoryId) {
    const k = slotKey(slot.r, slot.c);
    if (!this.blueprint.has(k)) this.blueprint.set(k, []);
    this.blueprint.get(k).push(factoryId);
  }

  _popFromSlot(slot) {
    const k = slotKey(slot.r, slot.c);
    const stack = this.blueprint.get(k);
    if (!stack || stack.length === 0) return null;
    const id = stack.pop();
    if (stack.length === 0) this.blueprint.delete(k);
    return id;
  }

  // Compose a "level" object the Simulation can consume from the current
  // runtime state. Combines locked + placed initial factories with their
  // rotated cells/funnels, plus the level's border / inputs / outputs.
  // Repopulate the funnel particle systems from the current level state.
  // Accepts an optional precomposed level to avoid a second _composeLevel.
  _refreshFunnelParticles(lvl) {
    if (!this.factoryFunnelParticles || !this.borderFunnelParticles) return;
    const level = lvl || this._composeLevel();
    const { factory, border } = collectFunnelsForParticles(
      level, this.pxCell, BOARD_GAP, SHAPE_SCALE,
    );
    this.factoryFunnelParticles.setFunnels(factory);
    this.borderFunnelParticles.setFunnels(border);
  }

  _composeLevel() {
    const factories = [];
    for (const p of this.placed.values()) {
      const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation);
      factories.push({
        id: p.id,
        anchor: { ...p.anchor },
        cells: rot.cells,
        funnels: rot.funnels,
        converter: p.converter,
        locked: p.locked,
        rotation: p.rotation || 0,
      });
    }
    return {
      board: this.sourceLevel.board,
      name: this.sourceLevel.name,
      number: this.sourceLevel.number,
      factories,
      border: this.sourceLevel.border,
      inputs: this.sourceLevel.inputs,
      outputs: this.sourceLevel.outputs,
      acidPits: this.sourceLevel.acidPits || [],
    };
  }

  // ===================================================================
  //   Layout
  // ===================================================================

  _layoutBoardAndBlueprint() {
    const board = this.sourceLevel.board;
    const contentBox = compute920Box(this);
    this.contentBox = contentBox;
    const { boxX, boxY, boxW, boxH } = contentBox;

    const REF_DIM = 5;
    const slotRows = this._slotRows();
    const slotCols = this._slotCols();

    const topMargin = TOOLBAR_H;
    const titleToBoardGap = 4;
    const boardToBpGap = 6;
    const bottomMargin = 16;
    const availW = boxW - 8;
    const chrome = BLUEPRINT_PAD * 4 + ISLAND_TO_GRID_GAP;
    const stackFixed = topMargin + titleToBoardGap + boardToBpGap + bottomMargin + chrome;

    const fitPxCell = (boardDim, slotColsN, slotRowsN) => {
      // Full-board cell fit — see EditorScene.fitPxCell for the rationale.
      const wCellFactor = boardDim;
      const wGapFactor  = Math.max(0, boardDim - 1);
      const cellW_board = (availW - BOARD_GAP * wGapFactor) / wCellFactor;
      const cellW_blueprint = (availW - BLUEPRINT_PAD * 2) / slotColsN;
      const stackCellFactor = boardDim + (slotRowsN + 1);
      const stackGapFactor  = Math.max(0, boardDim - 1);
      const cellH_stack = (boxH - stackFixed - BOARD_GAP * stackGapFactor) / stackCellFactor;
      return Math.min(cellW_board, cellW_blueprint, cellH_stack);
    };
    const refSlotCols = (REF_DIM - 2) + 1;
    const refSlotRows = (REF_DIM - 2) + 1;
    const refPxCell = Math.max(24, Math.floor(fitPxCell(REF_DIM, refSlotCols, refSlotRows)));
    const refBoardW = REF_DIM * refPxCell + (REF_DIM - 1) * BOARD_GAP;
    const neededPx = (refBoardW - (board.cols - 1) * BOARD_GAP) / board.cols;

    const cellPx = Math.max(24, Math.floor(neededPx));
    this.pxCell = cellPx;

    const refInteriorCols = REF_DIM - 2;
    const refWidthGap     = Math.max(0, refInteriorCols - 1);
    const refLabelBoxW    = SHAPE_SCALE * refPxCell;
    const titleBarW = refInteriorCols * refPxCell + refWidthGap * BOARD_GAP + 2 * refLabelBoxW;
    const bpW = refSlotCols * refPxCell;
    const bpH = refSlotRows * refPxCell;
    const islandW = bpW;
    this.islandH = refPxCell;
    this.slotPx = Math.min(bpW / slotCols, bpH / slotRows);

    const boardW = board.cols * cellPx + (board.cols - 1) * BOARD_GAP;
    const boardH = board.rows * cellPx + (board.rows - 1) * BOARD_GAP;
    this.boardW = boardW;
    this.titleBarW = Math.round(titleBarW);
    this.islandSlotW = bpW / ICON_SLOTS;
    // Center the full stack vertically inside the content box — matches
    // the horizontal centering so leftover slack splits evenly top/bottom.
    const stackH =
      topMargin + titleToBoardGap +
      boardH + boardToBpGap +
      (BLUEPRINT_PAD * 2) + bpH +
      ISLAND_TO_GRID_GAP + (BLUEPRINT_PAD * 2) + this.islandH +
      bottomMargin;
    const verticalSlack = Math.max(0, Math.floor((boxH - stackH) / 2));
    const stackTop = boxY + verticalSlack;
    this.stackTop = stackTop;
    this.boardOriginX = boxX + Math.round((boxW - boardW) / 2);
    this.boardOriginY = stackTop + topMargin + titleToBoardGap;

    const blueprintTopY = this.boardOriginY + boardH + boardToBpGap;
    this.blueprintOriginX = boxX + Math.round((boxW - bpW) / 2);
    this.blueprintOriginY = Math.round(blueprintTopY + BLUEPRINT_PAD);
    this.blueprintW = bpW;
    this.blueprintH = bpH;

    this.iconIslandOriginX = boxX + Math.round((boxW - islandW) / 2);
    this.iconIslandOriginY = Math.round(
      this.blueprintOriginY + bpH + BLUEPRINT_PAD + ISLAND_TO_GRID_GAP + BLUEPRINT_PAD,
    );

    const setPos = (cnt, x, y) => cnt.setPosition(x, y);
    setPos(this.boardContainer,        this.boardOriginX, this.boardOriginY);
    if (this.acidPitContainer) setPos(this.acidPitContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.interactiveContainer,  this.boardOriginX, this.boardOriginY);
    setPos(this.flowContainer,         this.boardOriginX, this.boardOriginY);
    setPos(this.shapeContainer,        this.boardOriginX, this.boardOriginY);
    if (this.factoryFunnelParticleContainer) setPos(this.factoryFunnelParticleContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.funnelContainer,       this.boardOriginX, this.boardOriginY);
    if (this.laserContainer) setPos(this.laserContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.exteriorContainer,     this.boardOriginX, this.boardOriginY);
    setPos(this.shadowContainer,       this.boardOriginX, this.boardOriginY);
    if (this.borderFunnelParticleContainer) setPos(this.borderFunnelParticleContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.borderFunnelContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.frameContainer,        this.boardOriginX, this.boardOriginY);
    setPos(this.labelContainer,        this.boardOriginX, this.boardOriginY);
    setPos(this.bufferMarkerContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.placementContainer,    this.boardOriginX, this.boardOriginY);
    setPos(this.blueprintContainer,    this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.blueprintFlowContainer,this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.blueprintBodyContainer,this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.blueprintOverlayContainer, this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.iconIslandContainer,   this.iconIslandOriginX, this.iconIslandOriginY);
    setPos(this.ghostContainer,        0, 0);
  }

  // ===================================================================
  //   Render
  // ===================================================================

  _renderAll() {
    this._clearBoardDynamic();
    const lvl = this._composeLevel();
    this._refreshFunnelParticles(lvl);
    renderInteriorFloor(this, this.boardContainer, { board: lvl.board, pxCell: this.pxCell });
    if (this._acidPits) { this._acidPits.destroy(); this._acidPits = null; }
    this._acidPits = renderAcidPits(this, this.acidPitContainer, this.sourceLevel, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    const border = renderBorder(this, this.boardContainer, this.borderFunnelContainer, lvl, { pxCell: this.pxCell, pxGap: BOARD_GAP });
    this.borderFunnelWraps = border.wraps;
    for (const fac of lvl.factories) {
      const entry = this._drawFactory(fac);
      this.factoryRefs.set(fac.id, entry);
    }
    renderExteriorCheckers(this, this.exteriorContainer, {
      board: lvl.board, pxCell: this.pxCell,
      boardOriginX: this.boardOriginX, boardOriginY: this.boardOriginY,
    });
    renderFrameShadow(this, this.shadowContainer, { board: lvl.board, pxCell: this.pxCell });
    renderFrameOutline(this, this.frameContainer, { board: lvl.board, pxCell: this.pxCell });
    this.bufferLabelWraps = renderBufferLabels(this, this.labelContainer, lvl, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this._updateHintButtonState();
  }

  _drawFactory(factory) {
    // Preserve per-cell label by spreading the cell rather than picking r/c.
    const absCells = factory.cells.map((cc) => ({ ...cc, r: factory.anchor.row + cc.r, c: factory.anchor.col + cc.c }));
    const absFunnels = (factory.funnels || []).map((f) => ({ ...f, r: factory.anchor.row + f.r, c: factory.anchor.col + f.c }));
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
      converter: factory.converter,
      caution: isObstacleFactory(factory.funnels),
      rotation: factory.rotation || 0,
    });
    body.setPosition(-cx, -cy);
    // Locked-only decoration: full-cell floor tint on boardContainer so
    // the dim doesn't fade with the body's idle alpha. The body alpha
    // itself is driven from the update loop based on simState.
    let tintGfx = null;
    if (factory.locked) {
      tintGfx = renderLockedTint(this, this.boardContainer, {
        cells: absCells, pxCell: this.pxCell, pxGap: BOARD_GAP,
      });
    }
    const flow = renderFlow(this, this.flowContainer, {
      cells: absCells, funnels: absFunnels, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.flowUpdaters.push(flow);
    return { bodyWrap, funnelWrap, body, funnels, tintGfx, locked: !!factory.locked, factoryId: factory.id };
  }

  _clearBoardDynamic() {
    this.factoryRefs.clear();
    for (const f of this.flowUpdaters) f.destroy && f.destroy();
    this.flowUpdaters.length = 0;
    this.interactiveContainer.removeAll(true);
    this.funnelContainer.removeAll(true);
    this.exteriorContainer.removeAll(true);
    this.shadowContainer.removeAll(true);
    this.borderFunnelContainer.removeAll(true);
    this.frameContainer.removeAll(true);
    this.labelContainer.removeAll(true);
    this.flowContainer.removeAll(true);
    this.boardContainer.removeAll(true);
    this.placementContainer.removeAll(true);
  }

  // ---------- Blueprint ----------

  _renderBlueprint() {
    // Drop references to flow updaters whose gfx is about to be destroyed.
    if (this.blueprintFlows) this.blueprintFlows.length = 0;
    else this.blueprintFlows = [];
    // Particle systems attached to the blueprint flow container must be
    // torn down BEFORE the container wipe so their gfx is released first.
    if (this.blueprintParticleSystems) {
      for (const s of this.blueprintParticleSystems) s.destroy();
      this.blueprintParticleSystems.length = 0;
    } else {
      this.blueprintParticleSystems = [];
    }
    // PLAY + RESET tiles live in `blueprintOverlayContainer`, a persistent
    // container that is intentionally NOT torn down here — that's what lets
    // the tiles fade in/out across drag start/end without blinking. The
    // show/hide decision is made below based on the blueprint's content
    // AND the current drag state.
    this.blueprintContainer.removeAll(true);
    this.blueprintFlowContainer.removeAll(true);
    this.blueprintBodyContainer.removeAll(true);
    this.blueprintRefs.clear();

    const slotPx = this.slotPx;
    const slotCols = this._slotCols();
    const slotRows = this._slotRows();
    const dgW = slotCols * slotPx;
    const dgH = slotRows * slotPx;

    const frame = this.make.graphics({ add: false });
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, dgW + BLUEPRINT_PAD * 2, dgH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, dgW + BLUEPRINT_PAD * 2, dgH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this.blueprintContainer.add(frame);

    // If the level (or current boss round) carries instructional text, the
    // top row of the blueprint is reserved for the hint pill instead of
    // slot dots. _slotAt also rejects placements at r === 0 in this case.
    const hint = this._instructionText();
    const reservedRow = hint ? 1 : 0;

    const dots = this.make.graphics({ add: false });
    dots.fillStyle(BLUEPRINT_DOT, 0.9);
    const DOT_SPACING = 6;
    // Draw the dotted slot-grid lines from the top of the slot area
    // (reservedRow) to the bottom of the blueprint. Horizontal edges run
    // at every row line including the topmost, so the slot grid always
    // shows a closed top boundary regardless of whether a hint pill is
    // present above it.
    for (let r = reservedRow; r <= slotRows; r++) {
      for (let c = 0; c <= slotCols; c++) {
        if (c < slotCols) {
          stampEdge(dots, c * slotPx, r * slotPx, (c + 1) * slotPx, r * slotPx, DOT_SPACING);
        }
        if (r < slotRows) {
          stampEdge(dots, c * slotPx, r * slotPx, c * slotPx, (r + 1) * slotPx, DOT_SPACING);
        }
      }
    }
    this.blueprintContainer.add(dots);

    // Hint pill — white rounded box across the reserved top row with the
    // text centered. Sits inside the blueprintContainer so it scales with
    // the blueprint's local positioning.
    if (hint) {
      const pad = Math.max(4, Math.round(slotPx * 0.12));
      const pillW = dgW - pad * 2;
      const pillH = slotPx - pad * 2;
      const pill = this.make.graphics({ add: false });
      pill.fillStyle(0xffffff, 1);
      pill.lineStyle(2, 0x1a2332, 1);
      const radius = Math.max(6, Math.round(pillH * 0.25));
      pill.fillRoundedRect(pad, pad, pillW, pillH, radius);
      pill.strokeRoundedRect(pad, pad, pillW, pillH, radius);
      this.blueprintContainer.add(pill);

      const fontPx = Math.max(11, Math.min(20, Math.floor(pillH * 0.50)));
      const text = this.add.text(dgW / 2, slotPx / 2, hint, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontPx}px`,
        fontStyle: 'bold',
        color: '#1a2332',
        align: 'center',
        wordWrap: { width: pillW - pad * 2 },
      }).setOrigin(0.5);
      this.blueprintContainer.add(text);
    }

    // Render every factory in each occupied slot (D4: fanned stack, lower
    // layers offset + dimmed; the topmost layer is opaque and is what tap-
    // and drag-pickup target). Factories currently being dragged are skipped
    // — the ghost takes over their visual.
    let anyFactoriesInBlueprint = false;
    for (const [, stack] of this.blueprint) {
      if (stack.length === 0) continue;
      anyFactoriesInBlueprint = true;
      const topIdx = stack.length - 1;
      for (let i = 0; i < stack.length; i++) {
        const id = stack[i];
        if (this.drag && this.drag.factoryId === id) continue;
        const def = this.blueprintFactories.get(id);
        if (!def) continue;
        const isTop = i === topIdx;
        const layerFromTop = topIdx - i;
        this._drawBlueprintFactory(def, { isTop, layerFromTop });
      }
    }

    // Blueprint is empty AND nothing is being dragged — show the big PLAY +
    // RESET buttons centered inside the blueprint frame. Tiles live in a
    // persistent overlay so they can fade out the moment a factory is
    // picked back up, then fade back in only once it's released onto the
    // board. Rotations and unrelated re-renders leave the visible tiles
    // untouched.
    const shouldShow = !anyFactoriesInBlueprint && !this.drag;
    if (shouldShow) {
      if (!this._blueprintButtonsVisible) this._showBlueprintPlayButtons(dgW, dgH, true);
      else this._repositionBlueprintPlayButtons(dgW, dgH);
    } else if (this._blueprintButtonsVisible) {
      this._hideBlueprintPlayButtons(true);
    }
    this._updateHintButtonState();
  }

  _showBlueprintPlayButtons(dgW, dgH, animateEntry) {
    // Guard: if a prior hide-tween is still winding down, hard-reset the
    // overlay first so we don't stack two generations of tiles on top of
    // each other. (Can happen if the user rapid-fires pickup/release.)
    this._teardownBlueprintPlayButtons();

    const btnSize  = Math.floor(Math.min(dgW * 0.30, dgH * 0.55));
    const btnGap   = Math.floor(btnSize * 0.25);
    const centerY  = dgH / 2;
    const centerX  = dgW / 2;
    const resetCX  = centerX - (btnSize + btnGap) / 2;
    const playCX   = centerX + (btnSize + btnGap) / 2;
    const radius   = Math.floor(btnSize * 0.24);

    // Each tile is drawn in LOCAL coords (origin at its own center) and
    // positioned with .x/.y, so scaleX/Y pulses grow/shrink around the
    // button center instead of warping from the blueprint's origin.
    const makeTile = (cx, iconDraw) => {
      const g = this.make.graphics({ add: false });
      g.fillStyle(BLUEPRINT_BG, 1);
      g.fillRoundedRect(-btnSize / 2, -btnSize / 2, btnSize, btnSize, radius);
      iconDraw(g);
      g.x = cx;
      g.y = centerY;
      g.setScale(1);
      this.blueprintOverlayContainer.add(g);
      return g;
    };

    const resetBg = makeTile(resetCX, (g) => drawCircleArrow(g, 0, 0, btnSize * 0.75, 0xffffff));

    const running = this.simState === 'running';
    const playIconColor = running ? 0x637a5a : 0x4caf50;
    const playBg = makeTile(playCX, (g) => drawPlayTriangle(g, btnSize * 0.04, 0, btnSize * 0.68, playIconColor));

    const tweens = [];
    if (animateEntry) {
      resetBg.alpha = 0;
      playBg.alpha  = 0;
      tweens.push(this.tweens.add({
        targets: [resetBg, playBg], alpha: 1,
        duration: 260, ease: 'Sine.Out',
      }));
    } else {
      resetBg.alpha = 1;
      playBg.alpha  = 1;
    }
    tweens.push(this.tweens.add({
      targets: [resetBg, playBg],
      scale: { from: 1.0, to: 1.035 },
      duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.InOut',
    }));

    const squash = (target) => this.tweens.add({
      targets: target, scale: 0.88, duration: 80, ease: 'Sine.Out',
    });
    const pop = (target) => this.tweens.add({
      targets: target, scale: 1, duration: 220, ease: 'Back.Out',
    });

    const resetHitCX = this.blueprintOriginX + resetCX;
    const playHitCX  = this.blueprintOriginX + playCX;
    const hitCY      = this.blueprintOriginY + centerY;
    const resetHit = this.add.rectangle(resetHitCX, hitCY, btnSize, btnSize, 0xffffff, 0)
      .setInteractive({ useHandCursor: true }).setDepth(56);
    resetHit.on('pointerdown', () => squash(resetBg));
    resetHit.on('pointerup',   () => { pop(resetBg); this._resetPlay(); });
    resetHit.on('pointerout',  () => pop(resetBg));

    const playHit = this.add.rectangle(playHitCX, hitCY, btnSize, btnSize, 0xffffff, 0)
      .setInteractive({ useHandCursor: !running }).setDepth(56);
    playHit.on('pointerdown', () => squash(playBg));
    playHit.on('pointerout',  () => pop(playBg));
    playHit.on('pointerup', () => {
      pop(playBg);
      if (this.simState === 'idle' && this._canPlay()) this._startPlay();
      else if (this.simState === 'paused') this._resume();
    });
    this._blueprintButtonHits   = [resetHit, playHit];
    this._blueprintButtonTweens = tweens;
    this._blueprintButtonGfx    = { resetBg, playBg };
    this._blueprintButtonMetrics = { dgW, dgH, resetCX, playCX, centerY, btnSize };
    this._blueprintButtonsVisible = true;
  }

  _hideBlueprintPlayButtons(animate) {
    if (!this._blueprintButtonsVisible) return;
    const gfx  = this._blueprintButtonGfx;
    const hits = this._blueprintButtonHits || [];
    // Stop idle-pulse + any pending press/release tweens before the fade —
    // otherwise they'd keep re-asserting scale/alpha under us.
    if (this._blueprintButtonTweens) {
      for (const t of this._blueprintButtonTweens) { try { t.stop(); } catch (e) {} }
      this._blueprintButtonTweens = null;
    }
    // Hit rects go away immediately — we don't want the user to tap a
    // phantom PLAY/RESET while the tile is fading out.
    for (const h of hits) { try { h.destroy(); } catch (e) {} }
    this._blueprintButtonHits = null;
    this._blueprintButtonsVisible = false;

    const targets = gfx ? [gfx.resetBg, gfx.playBg].filter(Boolean) : [];
    if (!animate || targets.length === 0) {
      this._teardownBlueprintPlayButtons();
      return;
    }
    this._blueprintButtonFadeTween = this.tweens.add({
      targets, alpha: 0, duration: 180, ease: 'Sine.In',
      onComplete: () => this._teardownBlueprintPlayButtons(),
    });
  }

  _repositionBlueprintPlayButtons(dgW, dgH) {
    // Called on re-render when buttons are already visible — only redo
    // layout if the blueprint outer dims actually changed (viewport
    // resize). Otherwise leave the tiles + their live tweens alone.
    const m = this._blueprintButtonMetrics;
    if (m && m.dgW === dgW && m.dgH === dgH) return;
    this._showBlueprintPlayButtons(dgW, dgH, false);
  }

  _teardownBlueprintPlayButtons() {
    if (this._blueprintButtonFadeTween) {
      try { this._blueprintButtonFadeTween.stop(); } catch (e) {}
      this._blueprintButtonFadeTween = null;
    }
    if (this._blueprintButtonTweens) {
      for (const t of this._blueprintButtonTweens) { try { t.stop(); } catch (e) {} }
      this._blueprintButtonTweens = null;
    }
    if (this._blueprintButtonHits) {
      for (const h of this._blueprintButtonHits) { try { h.destroy(); } catch (e) {} }
      this._blueprintButtonHits = null;
    }
    if (this.blueprintOverlayContainer) this.blueprintOverlayContainer.removeAll(true);
    this._blueprintButtonGfx      = null;
    this._blueprintButtonMetrics  = null;
    this._blueprintButtonsVisible = false;
  }

  _drawBlueprintFactory(def, { isTop = true, layerFromTop = 0 } = {}) {
    const slotPx = this.slotPx;
    const rot = rotateFactoryShape({ cells: def.baseCells, funnels: def.baseFunnels }, def.rotation);
    // Position the factory at its slot's top-left (in blueprint local coords).
    // Stacked layers fan down-and-right by FAN_OFFSET px per layer beneath
    // the top so the player can see how deep the pile is at a glance.
    const FAN_OFFSET = 6;
    const ox = def.slot.c * slotPx + layerFromTop * FAN_OFFSET;
    const oy = def.slot.r * slotPx + layerFromTop * FAN_OFFSET;
    // Spread cells so per-cell `label` survives the local-coord copy.
    const cellsLocal = rot.cells.map((c) => ({ ...c }));
    const funnelsLocal = rot.funnels.map((f) => ({ ...f }));
    const [cx, cy] = factoryCenter(cellsLocal, slotPx, 0);
    const funnelWrap = this.add.container(ox + cx, oy + cy);
    const bodyWrap   = this.add.container(ox + cx, oy + cy);
    if (!isTop) { funnelWrap.setAlpha(0.55); bodyWrap.setAlpha(0.55); }
    // Funnels first → they render BELOW the body (matches the board +
    // ghost stack, where funnelContainer sits below interactiveContainer).
    this.blueprintBodyContainer.add(funnelWrap);
    this.blueprintBodyContainer.add(bodyWrap);
    const funnels = renderFunnels(this, funnelWrap, funnelsLocal, { pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE });
    funnels.setPosition(-cx, -cy);
    const body = renderFactoryBody(this, bodyWrap, {
      cells: cellsLocal, pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
      converter: def.converter,
      caution: isObstacleFactory(funnelsLocal),
      rotation: def.rotation || 0,
    });
    body.setPosition(-cx, -cy);
    if (isTop) {
      // Only the top of a stack draws its animated flow — fanned lower
      // layers would smear the playable preview otherwise. Track the flow
      // updater so the scene's update() loop animates the dashes.
      const cellsAtSlot   = cellsLocal.map((c) => ({ ...c, r: c.r + def.slot.r, c: c.c + def.slot.c }));
      const funnelsAtSlot = funnelsLocal.map((f) => ({ ...f, r: f.r + def.slot.r, c: f.c + def.slot.c }));
      // Flow dashes render into blueprintBodyContainer AFTER the body so
      // they sit ON TOP of the factory body (same stacking as the board,
      // where flowContainer at depth 22 sits above interactiveContainer at 20).
      const flow = renderFlow(this, this.blueprintBodyContainer, {
        cells: cellsAtSlot, funnels: funnelsAtSlot,
        pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
      });
      if (!this.blueprintFlows) this.blueprintFlows = [];
      this.blueprintFlows.push(flow);
      // Ambient funnel particles — into blueprintFlowContainer (depth 51,
      // below blueprintBodyContainer at 52 so the dots read behind the
      // factory body + funnels).
      const slotParticles = new FunnelParticleSystem(this, this.blueprintFlowContainer, { pxCell: slotPx });
      slotParticles.setFunnels(
        collectFactoryFunnelsForParticles(cellsAtSlot, funnelsAtSlot, slotPx, 0, SHAPE_SCALE),
      );
      if (!this.blueprintParticleSystems) this.blueprintParticleSystems = [];
      this.blueprintParticleSystems.push(slotParticles);
    }
    if (isTop) this.blueprintRefs.set(def.id, { bodyWrap, funnelWrap, body, funnels });
  }

  // ---------- Icon island — Home / Level Select / Reset ----------

  _renderIconIsland() {
    this.iconIslandContainer.removeAll(true);
    if (this.iconHits) for (const h of this.iconHits) h.destroy();
    this.iconHits = [];

    const slotW = this.islandSlotW;
    const islandW = slotW * ICON_SLOTS;
    const islandH = this.islandH;

    const frame = this.make.graphics({ add: false });
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this.iconIslandContainer.add(frame);

    const slotsGfx = this.make.graphics({ add: false });
    const slotPad = 4;
    for (let s = 0; s < ICON_SLOTS; s++) {
      slotsGfx.fillStyle(BLUEPRINT_BG, 1);
      slotsGfx.lineStyle(1, BLUEPRINT_STROKE, 0.5);
      slotsGfx.fillRoundedRect(s * slotW + slotPad, slotPad, slotW - slotPad * 2, islandH - slotPad * 2, 8);
    }
    this.iconIslandContainer.add(slotsGfx);

    const iconSize = Math.round(Math.min(slotW, islandH) * 0.55);
    const cy = islandH / 2;

    const home = this.make.graphics({ add: false });
    drawHome(home, SLOT_HOME * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
    this.iconIslandContainer.add(home);

    const levelSelect = this.make.graphics({ add: false });
    drawGrid(levelSelect, SLOT_LEVEL_SELECT * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
    this.iconIslandContainer.add(levelSelect);

    const reset = this.make.graphics({ add: false });
    drawCircleArrow(reset, SLOT_RESET * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
    this.iconIslandContainer.add(reset);

    const makeHit = (slot, onTap) => {
      const cx = this.iconIslandOriginX + slot * slotW + slotW / 2;
      const ay = this.iconIslandOriginY + islandH / 2;
      const rect = this.add.rectangle(cx, ay, slotW - 6, islandH - 6, 0xffffff, 0)
        .setInteractive({ useHandCursor: true });
      rect.on('pointerup', onTap);
      this.iconHits.push(rect);
    };
    makeHit(SLOT_HOME, () => {
      this.sim && this.sim.stop();
      fadeTo(this, 'Home');
    });
    makeHit(SLOT_LEVEL_SELECT, () => {
      this.sim && this.sim.stop();
      const isCommunity = this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported';
      fadeTo(this, isCommunity ? 'Community' : 'LevelSelect');
    });
    makeHit(SLOT_RESET, () => this._resetPlay());
  }

  _buildToolbar() {
    if (this.titleBar) this.titleBar.destroy();
    const stackTop = this.stackTop != null
      ? this.stackTop
      : ((this.contentBox && this.contentBox.boxY) || 0);
    // HOME lives in the icon-island BACK slot (drawn with the home glyph,
    // routes to fadeTo('Home')). The title-bar right box now carries HINT
    // instead — stub for now; real hint system lands later.
    this.titleBar = new TitleBar(this, {
      x: this.boardOriginX + this.boardW / 2,
      y: stackTop + TitleBar.HEIGHT / 2 + 12,
      width: this.titleBarW,
      levelNumber: this.sourceLevel.number,
      levelName: this.sourceLevel.name,
      author: this.sourceLevel.author,
      rightButton: {
        kind: 'hint',
        onTap: () => this._openHintModal(),
      },
    });
  }

  // ===================================================================
  //   Hint system
  // ===================================================================

  // Return the canonical solution factories for the current context.
  //   - Boss level, round i → _sourceLevelOriginal.boss.rounds[i].solution.factories
  //   - Single level (catalog / community authored) → sourceLevel.solution.factories
  //   - Legacy community fallback → sourceLevel.factories (pre-placed board state)
  // Each entry is { id, anchor:{row,col}, cells, funnels, converter? }.
  //
  // IMPORTANT: `cells` + `funnels` on a solution entry are the CANONICAL
  // (rotation-0) layout — the same arrays that `initialFactories[i]` carries
  // for the blueprint. To place the factory correctly, rotation must be 0.
  _currentSolutionFactories() {
    if (this._sourceLevelOriginal && this._sourceLevelOriginal.boss && this._bossState) {
      const r = this._sourceLevelOriginal.boss.rounds[this._bossState.roundIdx];
      return (r && r.solution && r.solution.factories) || [];
    }
    const sol = this.sourceLevel && this.sourceLevel.solution && this.sourceLevel.solution.factories;
    if (sol && sol.length) return sol;
    return (this.sourceLevel && this.sourceLevel.factories) || [];
  }

  // Pick ONE factory to auto-place / reposition:
  //   1. Fix any placed factory whose anchor OR rotation doesn't match its
  //      solution. If the target FOOTPRINT overlaps other placed factories,
  //      every such factory is recorded as a blocker so we return them to
  //      the blueprint first.
  //   2. Otherwise, take a random blueprint factory whose target footprint
  //      is clear (or only obstructed by displaceable blockers).
  // Returns { factoryId, from:'board'|'blueprint', toCell:{row,col}, blockerIds:[] }
  // or null if nothing can be helped.
  _hintTargetPlan() {
    const solution = this._currentSolutionFactories();
    if (!solution.length) return null;
    const solById = new Map();
    for (const sf of solution) if (sf.id) solById.set(sf.id, sf);

    // Absolute cells occupied by a placed factory (rotated footprint).
    const absCellsOf = (p) => {
      const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation || 0);
      return rot.cells.map((cc) => `${p.anchor.row + cc.r},${p.anchor.col + cc.c}`);
    };

    // For a factory that will land at `anchor` with its base cells
    // (rotation 0 = solution rotation), list every placed factory whose
    // current footprint intersects the target footprint. Skip the factory
    // being moved itself, and skip locked factories (they'd be uncovered
    // as not-displaceable — if a locked factory blocks the solution cell,
    // something else is wrong and this candidate is unreachable).
    const blockersFor = (factoryId, anchor, baseCells) => {
      const target = new Set(
        baseCells.map((cc) => `${anchor.row + cc.r},${anchor.col + cc.c}`),
      );
      const blockers = [];
      let lockedBlocker = false;
      for (const p of this.placed.values()) {
        if (p.id === factoryId) continue;
        const cells = absCellsOf(p);
        const intersects = cells.some((k) => target.has(k));
        if (!intersects) continue;
        if (p.locked) { lockedBlocker = true; continue; }
        // A blocker is only displaceable if it has a blueprint slot to
        // return to. Pre-placed community factories (no blueprint entry)
        // can't be moved by the hint system — treat as a hard block so
        // this candidate is skipped.
        if (!this.blueprintFactories.has(p.id)) { lockedBlocker = true; continue; }
        blockers.push(p.id);
      }
      return { blockers, lockedBlocker };
    };

    // Board-fix priority.
    const misplaced = [];
    for (const p of this.placed.values()) {
      if (p.locked) continue;
      const sf = solById.get(p.id);
      if (!sf) continue;
      const anchorOk = p.anchor.row === sf.anchor.row && p.anchor.col === sf.anchor.col;
      const rotOk = (p.rotation || 0) === 0;
      if (anchorOk && rotOk) continue;
      misplaced.push({ placed: p, solution: sf });
    }
    if (misplaced.length) {
      const pick = misplaced[Math.floor(Math.random() * misplaced.length)];
      const { blockers, lockedBlocker } = blockersFor(
        pick.placed.id, pick.solution.anchor, pick.solution.cells,
      );
      if (lockedBlocker) {
        // Target blocked by a locked factory — can't help this one. Try
        // another misplaced pick if any; otherwise fall through to blueprint.
        const others = misplaced.filter((m) => m !== pick);
        for (const alt of others) {
          const r = blockersFor(alt.placed.id, alt.solution.anchor, alt.solution.cells);
          if (!r.lockedBlocker) {
            return {
              factoryId: alt.placed.id,
              from: 'board',
              toCell: { row: alt.solution.anchor.row, col: alt.solution.anchor.col },
              blockerIds: r.blockers,
            };
          }
        }
      } else {
        return {
          factoryId: pick.placed.id,
          from: 'board',
          toCell: { row: pick.solution.anchor.row, col: pick.solution.anchor.col },
          blockerIds: blockers,
        };
      }
    }

    // Blueprint-to-board.
    const candidates = [];
    for (const def of this.blueprintFactories.values()) {
      const sf = solById.get(def.id);
      if (!sf) continue;
      const { blockers, lockedBlocker } = blockersFor(def.id, sf.anchor, sf.cells);
      if (lockedBlocker) continue;
      candidates.push({ def, sf, blockerIds: blockers });
    }
    if (!candidates.length) return null;
    // Prefer candidates with no blockers so the easy win happens first.
    candidates.sort((a, b) => a.blockerIds.length - b.blockerIds.length);
    const easyCount = candidates.filter((c) => c.blockerIds.length === 0).length;
    const pool = easyCount > 0 ? candidates.slice(0, easyCount) : candidates;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return {
      factoryId: pick.def.id,
      from: 'blueprint',
      toCell: { row: pick.sf.anchor.row, col: pick.sf.anchor.col },
      blockerIds: pick.blockerIds,
    };
  }

  // Check whether the hint button should currently be enabled. It's
  // disabled when there's nothing left to do — i.e. every solution factory
  // is already in its correct spot AND there are no misplaced pieces on
  // the board. Also disabled when the level carries no solution data
  // (early campaign levels with an empty solution array).
  _updateHintButtonState() {
    if (!this.titleBar || !this.titleBar.setRightButtonEnabled) return;
    const plan = this._hintTargetPlan();
    this.titleBar.setRightButtonEnabled(!!plan);
  }

  _openHintModal() {
    if (this._hintModal || this._hintTweenBusy) return;
    if (this.simState !== 'idle' || this.victory) return;
    // Guard: if no hint is possible, the button should have been greyed
    // out already — but a stale tap could still land here. Short-circuit.
    if (!this._hintTargetPlan()) return;
    // Dismiss a live nudge popup before showing the modal so the two don't
    // stack visually, and cut the gentle flash — the player is already
    // engaging with the hint flow.
    if (this._stuckPopup) { this._stuckPopup.destroy(); this._stuckPopup = null; }
    this._stopHintButtonGlow();
    this._hintModal = new HintConfirmModal(this, {
      onConfirm: () => { this._hintModal = null; this._applyHint(); },
      onCancel:  () => { this._hintModal = null; },
    });
  }

  _applyHint() {
    const plan = this._hintTargetPlan();
    if (!plan) return;
    this._hintTweenBusy = true;
    // Rotation-then-move for the target. Blocker returns are NOT queued
    // up-front — they fire in parallel with the target's slide phase (see
    // onBeforeSlide). Keeping blockers in place during the rotation phase
    // makes it clearer to the player what's moving where.
    this._tweenToSolutionCell(
      plan.factoryId, plan.from, plan.toCell,
      () => { this._hintTweenBusy = false; },
      {
        onBeforeSlide: () => {
          for (const blockerId of (plan.blockerIds || [])) {
            this._tweenPlacedToBlueprint(blockerId);
          }
        },
      },
    );
  }

  // Return the world-coord center of the blueprint slot at {r, c}.
  _blueprintSlotWorldCenter(slotR, slotC) {
    const slotPx = this.slotPx;
    return {
      x: this.blueprintOriginX + slotC * slotPx + slotPx / 2,
      y: this.blueprintOriginY + slotR * slotPx + slotPx / 2,
    };
  }

  // Return the world-coord center-of-rotated-factory for a board placement
  // at anchor {row, col}, given the factory's rotated cells.
  _boardCellFactoryWorldCenter(anchor, rotCells) {
    const absCells = rotCells.map((cc) => ({ r: anchor.row + cc.r, c: anchor.col + cc.c }));
    const [cx, cy] = factoryCenter(absCells, this.pxCell, BOARD_GAP);
    return { x: this.boardOriginX + cx, y: this.boardOriginY + cy };
  }

  // Build a detached ghost container (body + funnels + flow + particles) for a
  // factory at the given world position. Returns { root, destroy }. The ghost
  // lives in this.ghostContainer so it sits above the board/blueprint.
  _buildHintGhost({ worldX, worldY, baseCells, baseFunnels, rotation, converter }) {
    const rot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, rotation);
    const [lcx, lcy] = factoryCenter(rot.cells, this.pxCell, BOARD_GAP);
    const root = this.add.container(worldX - lcx, worldY - lcy);
    root.setDepth(70);
    // Particles first so they render behind body+funnels.
    const particles = new FunnelParticleSystem(this, root, { pxCell: this.pxCell });
    particles.setFunnels(
      collectFactoryFunnelsForParticles(rot.cells, rot.funnels, this.pxCell, BOARD_GAP, SHAPE_SCALE),
    );
    const funnelWrap = this.add.container(lcx, lcy);
    const bodyWrap   = this.add.container(lcx, lcy);
    root.add(funnelWrap);
    root.add(bodyWrap);
    const fns = renderFunnels(this, funnelWrap, rot.funnels, {
      pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    fns.setPosition(-lcx, -lcy);
    const body = renderFactoryBody(this, bodyWrap, {
      cells: rot.cells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      converter, caution: isObstacleFactory(rot.funnels),
      rotation,
    });
    body.setPosition(-lcx, -lcy);
    return {
      root,
      bodyWrap, funnelWrap,
      body,
      lcx, lcy,
      rotCells: rot.cells,
      destroy: () => {
        particles.destroy();
        root.destroy(true);
      },
    };
  }

  // Tween the blocker factory from its current board position back to its
  // default blueprint slot. On complete, update state so the factory is in
  // the blueprint and re-render.
  _tweenPlacedToBlueprint(blockerId, done) {
    const p = this.placed.get(blockerId);
    const def = this.blueprintFactories.get(blockerId);
    if (!p || !def) { done && done(); return; }
    const rotCells = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation).cells;
    const startCenter = this._boardCellFactoryWorldCenter(p.anchor, rotCells);
    const slot = def.defaultSlot || def.slot || { r: 0, c: 0 };
    const slotCenter = this._blueprintSlotWorldCenter(slot.r, slot.c);

    const ghost = this._buildHintGhost({
      worldX: startCenter.x, worldY: startCenter.y,
      baseCells: p.baseCells, baseFunnels: p.baseFunnels,
      rotation: p.rotation, converter: p.converter,
    });

    // Remove from board state + re-render (the live factory disappears;
    // ghost visually takes over during the tween).
    this.placed.delete(blockerId);
    this._renderAll();

    const [lcx, lcy] = factoryCenter(ghost.rotCells, this.pxCell, BOARD_GAP);
    this.tweens.add({
      targets: ghost.root,
      x: slotCenter.x - lcx,
      y: slotCenter.y - lcy,
      duration: 320,
      ease: 'Sine.InOut',
      onComplete: () => {
        ghost.destroy();
        def.slot = { ...slot };
        def.rotation = p.rotation;
        this._pushToSlot(def.slot, blockerId);
        this._renderBlueprint();
        this._renderIconIsland();
        done && done();
      },
    });
  }

  // Tween a factory (blueprint or board) into its solution cell on the
  // board. Solution cells/funnels are the canonical (rotation-0) layout,
  // so the correct placement is always `rotation = 0`.
  //
  // Animation sequence:
  //   1. Build the ghost at the factory's CURRENT rotation, sitting on top
  //      of the original source location.
  //   2. Animate one 90° quarter-turn at a time (shortest path, CW or CCW),
  //      with a short pause between turns so the player can read each step.
  //   3. Once rotation is 0, slide the ghost from its source to the target
  //      cell. On complete, write state + re-render.
  _tweenToSolutionCell(factoryId, from, toCell, done, opts = {}) {
    let baseCells, baseFunnels, converter, startCenter, startRotation;
    if (from === 'board') {
      const p = this.placed.get(factoryId);
      if (!p) { done && done(); return; }
      baseCells = p.baseCells; baseFunnels = p.baseFunnels;
      converter = p.converter; startRotation = p.rotation || 0;
      const rotCells = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, startRotation).cells;
      startCenter = this._boardCellFactoryWorldCenter(p.anchor, rotCells);
      this.placed.delete(factoryId);
      this._renderAll();
    } else {
      const def = this.blueprintFactories.get(factoryId);
      if (!def) { done && done(); return; }
      baseCells = def.baseCells; baseFunnels = def.baseFunnels;
      converter = def.converter; startRotation = def.rotation || 0;
      startCenter = this._blueprintSlotWorldCenter(def.slot.r, def.slot.c);
      this._popFromSlot(def.slot);
      this._renderBlueprint();
    }

    // Ghost at the ORIGINAL rotation so the first frame of the animation
    // matches what the player just saw.
    const ghost = this._buildHintGhost({
      worldX: startCenter.x, worldY: startCenter.y,
      baseCells, baseFunnels, rotation: startRotation, converter,
    });

    const targetRotation = 0;
    // Shortest rotation path: CW or CCW, whichever costs fewer 90° steps.
    const cwSteps  = ((targetRotation - startRotation) % 4 + 4) % 4;
    const ccwSteps = ((startRotation - targetRotation) % 4 + 4) % 4;
    const useCW = cwSteps <= ccwSteps;
    const steps = useCW ? cwSteps : ccwSteps;
    const stepRad = (useCW ? 1 : -1) * (Math.PI / 2);

    const ROT_DUR = 240;     // per-step tween duration
    const ROT_PAUSE = 180;   // pause between steps
    const MOVE_DUR = 420;

    const finalize = () => {
      ghost.destroy();
      this.placed.set(factoryId, {
        id: factoryId,
        source: 'initial',
        anchor: { row: toCell.row, col: toCell.col },
        rotation: targetRotation,
        baseCells, baseFunnels, converter,
        locked: false,
      });
      // Keep the blueprint-side rotation in sync so if the player later
      // picks the factory back up, it doesn't revert to an odd orientation.
      const def = this.blueprintFactories.get(factoryId);
      if (def) def.rotation = targetRotation;
      this._renderAll();
      this._renderBlueprint();
      this._renderIconIsland();
      done && done();
    };

    const slideToTarget = () => {
      // Kick off any "blockers-return-to-blueprint" animations now, so they
      // fly out of the way in parallel with the target sliding in.
      if (opts.onBeforeSlide) opts.onBeforeSlide();
      // Recompute target-side factory center using the SOLUTION rotation's
      // cells (rotation 0), since that's the layout we'll render on drop.
      const finalRot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, targetRotation);
      const endCenter = this._boardCellFactoryWorldCenter(
        { row: toCell.row, col: toCell.col },
        finalRot.cells,
      );
      // The ghost root sits at (worldX - startLcx, worldY - startLcy). The
      // visual pivot (wrap origin) is at root + (startLcx, startLcy) in
      // world coords. To land the pivot on endCenter we shift root by
      // (endCenter - startLcx, endCenter - startLcy) — same offset rule
      // the builder used for the initial position.
      this.tweens.add({
        targets: ghost.root,
        x: endCenter.x - ghost.lcx,
        y: endCenter.y - ghost.lcy,
        duration: MOVE_DUR,
        ease: 'Cubic.InOut',
        onComplete: finalize,
      });
    };

    if (steps === 0) { slideToTarget(); return; }

    let stepIdx = 0;
    const ghostLabels = (ghost.body && ghost.body.labels) || [];
    const doNextRotation = () => {
      if (stepIdx >= steps) { slideToTarget(); return; }
      this.tweens.add({
        targets: [ghost.bodyWrap, ghost.funnelWrap],
        rotation: `+=${stepRad}`,
        duration: ROT_DUR,
        ease: 'Sine.InOut',
        onComplete: () => {
          stepIdx++;
          if (stepIdx >= steps) slideToTarget();
          else this.time.delayedCall(ROT_PAUSE, doNextRotation);
        },
      });
      if (ghostLabels.length) {
        this.tweens.add({
          targets: ghostLabels,
          rotation: `-=${stepRad}`,
          duration: ROT_DUR,
          ease: 'Sine.InOut',
        });
      }
    };
    doNextRotation();
  }

  _startHintButtonGlow() {
    if (this.titleBar && this.titleBar.startGentleFlash) this.titleBar.startGentleFlash();
  }

  _stopHintButtonGlow() {
    if (this.titleBar && this.titleBar.stopGentleFlash) this.titleBar.stopGentleFlash();
  }

  // ===================================================================
  //   Stuck-popup timer
  // ===================================================================

  // How long to wait (ms) before firing the first "Need a hand?" popup
  // on the current level. Null → never fire (community levels).
  _stuckPopupFirstDelayMs() {
    // Community levels arrive via CommunityScene with no catalog number —
    // skip the nudge there so imported/local levels don't nag the player.
    const isCommunity = this.sourceLevel && (
      this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported'
    );
    if (isCommunity) return null;
    if (this._sourceLevelOriginal && this._sourceLevelOriginal.boss) return 60000;
    const n = this.sourceLevel && this.sourceLevel.number;
    if (typeof n !== 'number' || n <= 0) return null;  // sandbox or untagged
    if (n >= 10) return 60000;
    return 30000;
  }

  _startStuckPopupTimer() {
    this._resetStuckPopup();
    const first = this._stuckPopupFirstDelayMs();
    if (first == null) return;
    this._scheduleStuckPopup(first);
  }

  _scheduleStuckPopup(delayMs) {
    this._stuckTimerEvent = this.time.delayedCall(delayMs, () => {
      this._stuckTimerEvent = null;
      // Suppress when a modal is up or the level is already beaten — just
      // reschedule so the player gets nudged again next interval.
      if (this.victory || this._hintModal || this._stuckPopup || this.simState === 'running') {
        this._scheduleStuckPopup(300000);
        return;
      }
      // Don't nudge when there's nothing the hint button could do — every
      // factory is already at its solution spot (or the level has no
      // solution data). Retry on the next interval in case the player
      // moves a factory out of position.
      if (!this._hintTargetPlan()) {
        this._scheduleStuckPopup(300000);
        return;
      }
      const anchor = this.titleBar && this.titleBar.getRightButtonCenter();
      if (!anchor) { this._scheduleStuckPopup(300000); return; }
      const anchorBottomY = anchor.y + TitleBar.HEIGHT / 2;
      this._stuckPopup = new HintNudgePopup(this, {
        anchorX: anchor.x, anchorY: anchorBottomY,
        onDismiss: () => {
          this._stuckPopup = null;
          this._stopHintButtonGlow();
          this._scheduleStuckPopup(300000);
        },
      });
      // Kick off the gentle hint-button pulse the moment the popup appears
      // so the player's eye is drawn from popup → button in one glance.
      this._startHintButtonGlow();
    });
  }

  _resetStuckPopup() {
    if (this._stuckTimerEvent) { this._stuckTimerEvent.remove(false); this._stuckTimerEvent = null; }
    if (this._stuckPopup) { this._stuckPopup.destroy(); this._stuckPopup = null; }
  }

  // ===================================================================
  //   Update loop
  // ===================================================================

  update(time, delta) {
    if (!this.ready) return;
    if (this.simState === 'running') this.simTime += delta;
    // 30fps cosmetic tick — flow repaint + squash/stretch are visual-only
    // and don't need to run every frame. Halves per-frame GPU cost at 60fps;
    // at <30fps (mobile lag) they fire every frame, same as before.
    this._cosmeticAccum = (this._cosmeticAccum || 0) + (delta || 16);
    const cosmeticTick = this._cosmeticAccum >= 32;
    if (cosmeticTick) this._cosmeticAccum = 0;
    if (cosmeticTick) {
      const t = (this.simTime % CYCLE_MS) / CYCLE_MS;
      const sq = shapeSquash(t);
      const applyPair = (entry) => {
        // Powered-type factories sit still until fully powered — breathing
        // starts only once every bolt on the factory is fully lit.
        const powered = entry.body && entry.body.poweredGlow;
        const idlePowered = powered && entry.body.poweredGlow.alpha < 1;
        if (entry.bodyWrap) {
          entry.bodyWrap.scaleX = idlePowered ? 1 : sq.body.scaleX;
          entry.bodyWrap.scaleY = idlePowered ? 1 : sq.body.scaleY;
        }
        if (entry.funnelWrap) {
          entry.funnelWrap.scaleX = idlePowered ? 1 : sq.funnels.scaleX;
          entry.funnelWrap.scaleY = idlePowered ? 1 : sq.funnels.scaleY;
        }
      };
      // Locked factories dim to 0.65 when the sim isn't running so the player
      // can read the dark grid-cell tint through the body; full alpha during
      // play so the block reads as a firm wall.
      const lockedAlpha = (this.simState === 'running') ? 1.0 : 0.65;
      for (const entry of this.factoryRefs.values()) {
        applyPair(entry);
        if (entry.locked && entry.bodyWrap) entry.bodyWrap.alpha = lockedAlpha;
      }
      for (const entry of this.blueprintRefs.values()) applyPair(entry);
      if (this.ghostPulse) applyPair(this.ghostPulse);
      if (this.borderFunnelWraps) {
        for (const w of this.borderFunnelWraps) { w.scaleX = sq.funnels.scaleX; w.scaleY = sq.funnels.scaleY; }
      }
      if (this.bufferLabelWraps) {
        for (const w of this.bufferLabelWraps) { w.scaleX = sq.body.scaleX; w.scaleY = sq.body.scaleY; }
      }
      // Pass raw `time` so the flow dashes animate even before/after the sim
      // is running (idle and paused states still show movement). Animate every
      // factory copy on screen — placed body, blueprint slot previews, ghost.
      for (const f of this.flowUpdaters) f.update(time);
      if (this.blueprintFlows) for (const f of this.blueprintFlows) f.update(time);
      if (this.ghostFlow) this.ghostFlow.update(time);
      if (this._acidPits) this._acidPits.tick(time);
    }

    if (this.drag) {
      // dt-based exponential smoothing — frame-rate-independent so the
      // ghost doesn't visibly drag behind the pointer under mobile lag.
      // tau = 60ms matches the old 35%-per-60fps-frame feel at 60fps and
      // closes ~63% per 60ms regardless of actual frame rate.
      const dtClamped = Math.min(100, delta || 16);
      const alpha = 1 - Math.exp(-dtClamped / 60);
      this.ghostContainer.x += (this.ghostTargetX - this.ghostContainer.x) * alpha;
      this.ghostContainer.y += (this.ghostTargetY - this.ghostContainer.y) * alpha;
    }

    if (this.simState === 'running') {
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
    // Lasers + bolt pulse always refresh (they clear themselves when the
    // sim isn't running, since sim.lasers is empty and boltPowered is a
    // cleared Map after sim.stop()).
    if (this.laserRenderer) {
      const lasers   = (this.sim && this.sim.lasers) || [];
      const emitters = (this.sim && this.sim.emitters) || [];
      this.laserRenderer.update(this.simTime || time, lasers, emitters);
    }
    this._updateBoltVisuals();
    // Ambient funnel particles always animate (play-time and idle) so the
    // funnels read as live. Runs every frame — not gated on cosmetic tick —
    // because the effect is subtle and stutter would be noticeable.
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.update(time);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.update(time);
    if (this.ghostParticles)         this.ghostParticles.update(time);
    if (this.blueprintParticleSystems) for (const s of this.blueprintParticleSystems) s.update(time);
  }

  // ===================================================================
  //   Hit-testing
  // ===================================================================

  _cellAt(px, py) {
    const board = this._boardCellAt(px, py);
    if (board) return { ...board, kind: 'board' };
    const slot = this._slotAt(px, py);
    if (slot) return { ...slot, kind: 'blueprint' };
    return null;
  }

  _boardCellAt(px, py) {
    const lx = px - this.boardOriginX;
    const ly = py - this.boardOriginY;
    const step = this.pxCell + BOARD_GAP;
    const c = Math.floor(lx / step);
    const r = Math.floor(ly / step);
    if (r < 0 || c < 0 || r >= this.sourceLevel.board.rows || c >= this.sourceLevel.board.cols) return null;
    const localX = lx - c * step;
    const localY = ly - r * step;
    if (localX > this.pxCell || localY > this.pxCell) return null;
    return { r, c };
  }

  _slotAt(px, py) {
    const lx = px - this.blueprintOriginX;
    const ly = py - this.blueprintOriginY;
    if (lx < 0 || ly < 0 || lx > this.blueprintW || ly > this.blueprintH) return null;
    const c = Math.floor(lx / this.slotPx);
    const r = Math.floor(ly / this.slotPx);
    if (r < 0 || c < 0 || r >= this._slotRows() || c >= this._slotCols()) return null;
    // Top row is reserved for the instructional text box (when present) —
    // reject placements there so the player can't drop a factory under
    // the hint.
    if (this._instructionText() && r === 0) return null;
    return { r, c };
  }

  // Returns the active instructional text for the current sourceLevel
  // (boss-round levels carry the per-round text in `sourceLevel.instructionalText`
  // courtesy of `bossRoundLevel`), or null when no hint should be shown.
  // When non-null the blueprint top row is reserved.
  _instructionText() {
    return (this.sourceLevel && this.sourceLevel.instructionalText) || null;
  }

  _placedAtBoardCell(r, c) {
    for (const p of this.placed.values()) {
      if (p.locked) continue;
      const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation);
      for (const cc of rot.cells) {
        if (p.anchor.row + cc.r === r && p.anchor.col + cc.c === c) return p;
      }
    }
    return null;
  }

  // ===================================================================
  //   Drag controller wiring
  // ===================================================================

  _canDrag(info) {
    if (!info) return false;
    if (this.simState !== 'idle' || this.victory) return false;
    if (this._hintTweenBusy || this._rotateTweenBusy) return false;
    if (info.kind === 'board') return !!this._placedAtBoardCell(info.r, info.c);
    if (info.kind === 'blueprint') return !!this._findBlueprintFactoryAt(info.r, info.c);
    return false;
  }

  _onTapCell(info) {
    if (!info) return;
    if (this.simState !== 'idle' || this.victory) return;
    if (this._rotateTweenBusy || this._hintTweenBusy) return;
    if (info.kind === 'board') {
      const placed = this._placedAtBoardCell(info.r, info.c);
      if (placed) this._rotatePlaced(placed);
    } else if (info.kind === 'blueprint') {
      const hit = this._findBlueprintFactoryAt(info.r, info.c);
      if (!hit) return;
      const def = this.blueprintFactories.get(hit.factoryId);
      if (def) this._rotateBlueprint(def);
    }
  }

  // Find the blueprint factory whose rotated footprint covers the given
  // slot. Multi-cell factories span multiple slots; tapping or dragging on
  // any cell should resolve to that factory. Prefers anchor matches so a
  // factory whose (0,0) cell sits on the slot wins over a neighbor whose
  // tail happens to overlap. Only the top of each slot-stack is considered
  // (D4 fanned layers below aren't interactable).
  _findBlueprintFactoryAt(slotR, slotC) {
    let anchorHit = null;
    let footprintHit = null;
    for (const [stackKey, stack] of this.blueprint) {
      if (!stack || stack.length === 0) continue;
      const factoryId = stack[stack.length - 1];
      const def = this.blueprintFactories.get(factoryId);
      if (!def) continue;
      const [baseR, baseC] = stackKey.split(',').map(Number);
      const rot = rotateFactoryShape({ cells: def.baseCells, funnels: def.baseFunnels }, def.rotation || 0);
      for (const cc of rot.cells) {
        if (baseR + cc.r === slotR && baseC + cc.c === slotC) {
          const hit = { factoryId, slot: { r: baseR, c: baseC }, localCell: { r: cc.r, c: cc.c } };
          if (cc.r === 0 && cc.c === 0) anchorHit = hit;
          else if (!footprintHit) footprintHit = hit;
        }
      }
    }
    return anchorHit || footprintHit;
  }

  _rotatePlaced(p) {
    const newRot = (p.rotation + 1) % 4;
    const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, newRot);
    const ref = this.factoryRefs.get(p.id);
    if (!this._cellsFitOnBoard(p.anchor.row, p.anchor.col, rot.cells, p.id)) {
      if (ref) this._shakeRefusal([ref.bodyWrap, ref.funnelWrap], (ref.body && ref.body.labels) || []);
      return;
    }
    if (!ref || !ref.bodyWrap || !ref.funnelWrap) {
      p.rotation = newRot;
      this._renderAll();
      return;
    }
    const newAbsCells = rot.cells.map((cc) => ({
      ...cc, r: p.anchor.row + cc.r, c: p.anchor.col + cc.c,
    }));
    const [newCx, newCy] = factoryCenter(newAbsCells, this.pxCell, BOARD_GAP);
    this._rotateTweenBusy = true;
    this.tweens.add({
      targets: [ref.bodyWrap, ref.funnelWrap],
      rotation: `+=${Math.PI / 2}`,
      x: newCx,
      y: newCy,
      duration: 220,
      ease: 'Sine.InOut',
      onComplete: () => {
        p.rotation = newRot;
        this._rotateTweenBusy = false;
        this._renderAll();
      },
    });
    // Counter-rotate the cell labels so their glyphs stay upright even
    // while their position rotates around the bodyWrap origin.
    const labels = (ref.body && ref.body.labels) || [];
    if (labels.length) {
      this.tweens.add({
        targets: labels,
        rotation: `-=${Math.PI / 2}`,
        duration: 220,
        ease: 'Sine.InOut',
      });
    }
  }

  _rotateBlueprint(def) {
    const ref = this.blueprintRefs.get(def.id);
    if (!ref || !ref.bodyWrap || !ref.funnelWrap) {
      def.rotation = (def.rotation + 1) % 4;
      this._renderBlueprint();
      return;
    }
    const newRot = (def.rotation + 1) % 4;
    const rot = rotateFactoryShape({ cells: def.baseCells, funnels: def.baseFunnels }, newRot);
    const slotPx = this.slotPx;
    const cellsLocal = rot.cells.map((c) => ({ ...c }));
    const [cx, cy] = factoryCenter(cellsLocal, slotPx, 0);
    const newWrapX = def.slot.c * slotPx + cx;
    const newWrapY = def.slot.r * slotPx + cy;
    this._rotateTweenBusy = true;
    this.tweens.add({
      targets: [ref.bodyWrap, ref.funnelWrap],
      rotation: `+=${Math.PI / 2}`,
      x: newWrapX,
      y: newWrapY,
      duration: 220,
      ease: 'Sine.InOut',
      onComplete: () => {
        def.rotation = newRot;
        this._rotateTweenBusy = false;
        this._renderBlueprint();
      },
    });
    const labels = (ref.body && ref.body.labels) || [];
    if (labels.length) {
      this.tweens.add({
        targets: labels,
        rotation: `-=${Math.PI / 2}`,
        duration: 220,
        ease: 'Sine.InOut',
      });
    }
  }

  // Rotational wobble played when a rotation can't fit on the board —
  // reads as "the factory tried to turn and bounced back". Wobbles the
  // bodyWrap + funnelWrap rotation by a small angle, yoyoed a few times.
  // Labels (if provided) counter-wobble so their glyphs stay upright.
  _shakeRefusal(targets, labels = []) {
    if (!targets || !targets.length) return;
    if (this._rotateTweenBusy) return;
    this._rotateTweenBusy = true;
    const amp = 0.12;   // ~6.9° — just enough to read as a wobble
    const startRots = targets.map((t) => t.rotation || 0);
    const startLblRots = labels.map((l) => l.rotation || 0);
    this.tweens.add({
      targets,
      rotation: `+=${amp}`,
      duration: 55,
      yoyo: true,
      repeat: 2,         // ~330ms total: 3 forward + 3 yoyo at 55ms each
      ease: 'Sine.InOut',
      onComplete: () => {
        for (let i = 0; i < targets.length; i++) targets[i].rotation = startRots[i];
        this._rotateTweenBusy = false;
      },
    });
    if (labels.length) {
      this.tweens.add({
        targets: labels,
        rotation: `-=${amp}`,
        duration: 55,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.InOut',
        onComplete: () => {
          for (let i = 0; i < labels.length; i++) labels[i].rotation = startLblRots[i];
        },
      });
    }
  }

  _onDragStart({ grabR, grabC, kind }) {
    if (this.simState !== 'idle' || this.victory) return;
    let factoryId, baseCells, baseFunnels, converter, rotation;
    let grab;
    let source;
    let originPlaced = null;
    let originSlot = null;

    if (kind === 'board') {
      const placed = this._placedAtBoardCell(grabR, grabC);
      if (!placed) return;
      source = 'board';
      originPlaced = placed;
      factoryId = placed.id;
      baseCells = placed.baseCells; baseFunnels = placed.baseFunnels;
      converter = placed.converter; rotation = placed.rotation;
      const rot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, rotation);
      let pickRel = rot.cells.find((cc) => placed.anchor.row + cc.r === grabR && placed.anchor.col + cc.c === grabC);
      if (!pickRel) pickRel = rot.cells[0];
      grab = { r: pickRel.r, c: pickRel.c };
      this.placed.delete(placed.id);
      this._renderAll();
    } else if (kind === 'blueprint') {
      const hit = this._findBlueprintFactoryAt(grabR, grabC);
      if (!hit) return;
      source = 'blueprint';
      factoryId = hit.factoryId;
      const def = this.blueprintFactories.get(factoryId);
      if (!def) return;
      originSlot = { ...def.slot };
      baseCells = def.baseCells; baseFunnels = def.baseFunnels;
      converter = def.converter; rotation = def.rotation;
      // Grab at whichever cell the user actually tapped so the ghost tracks
      // under the pointer for multi-cell factories.
      grab = { r: hit.localCell.r, c: hit.localCell.c };
      // Pop from blueprint visually — re-render so the slot appears empty.
      this._popFromSlot(def.slot);
    } else {
      return;
    }

    // Build the ghost: body + funnels + animated flow at board scale so the
    // mid-drag preview shows the same dashed manifold as the final drop.
    if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
    this.ghostContainer.removeAll(true);
    this.ghostFlow = null;
    const rot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, rotation);
    // Ghost funnel particles — created FIRST so the gfx lands at the back
    // of ghostContainer's child list (behind funnel/body/flow).
    this.ghostParticles = new FunnelParticleSystem(this, this.ghostContainer, { pxCell: this.pxCell });
    this.ghostParticles.setFunnels(
      collectFactoryFunnelsForParticles(rot.cells, rot.funnels, this.pxCell, BOARD_GAP, SHAPE_SCALE),
    );
    const [cx, cy] = factoryCenter(rot.cells, this.pxCell, BOARD_GAP);
    const fWrap = this.add.container(cx, cy);
    const bWrap = this.add.container(cx, cy);
    this.ghostContainer.add(fWrap);
    this.ghostContainer.add(bWrap);
    const fns = renderFunnels(this, fWrap, rot.funnels, { pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
    fns.setPosition(-cx, -cy);
    const body = renderFactoryBody(this, bWrap, {
      cells: rot.cells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      caution: isObstacleFactory(rot.funnels),
      rotation,
    });
    body.setPosition(-cx, -cy);
    this.ghostFlow = renderFlow(this, this.ghostContainer, {
      cells: rot.cells, funnels: rot.funnels,
      pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.ghostPulse = { bodyWrap: bWrap, funnelWrap: fWrap };
    this.ghostContainer.setAlpha(0.95);

    this.drag = {
      source, factoryId, baseCells, baseFunnels, converter, rotation, grab,
      originPlaced, originSlot,
    };
    this._renderBlueprint();

    const pointer = this.input.activePointer;
    if (pointer) {
      const step = this.pxCell + BOARD_GAP;
      this.ghostContainer.x = pointer.x - (grab.c * step + this.pxCell / 2);
      this.ghostContainer.y = pointer.y - (grab.r * step + this.pxCell / 2);
      this.ghostTargetX = this.ghostContainer.x;
      this.ghostTargetY = this.ghostContainer.y;
    }
  }

  _onDragMove(x, y) {
    if (!this.drag) return;
    const step = this.pxCell + BOARD_GAP;
    const boardCell = this._boardCellAt(x, y);
    let targetX = x, targetY = y;
    if (boardCell) {
      targetX = this.boardOriginX + boardCell.c * step + this.pxCell / 2;
      targetY = this.boardOriginY + boardCell.r * step + this.pxCell / 2;
    }
    this.ghostTargetX = targetX - (this.drag.grab.c * step + this.pxCell / 2);
    this.ghostTargetY = targetY - (this.drag.grab.r * step + this.pxCell / 2);
    this._updatePlacementPreview(boardCell);
  }

  _onDragEnd({ boardRC }) {
    if (!this.drag) { this._clearDrag(); return; }
    const pointer = this.input.activePointer;
    const px = pointer ? pointer.x : 0;
    const py = pointer ? pointer.y : 0;
    if (boardRC && this._tryPlaceOnBoard(boardRC)) { this._clearDrag(); return; }
    const slot = this._slotAt(px, py);
    if (slot) {
      this._dropIntoSlot(slot);
      this._clearDrag();
      return;
    }
    this._cancelDrag();
    this._clearDrag();
  }

  _tryPlaceOnBoard(boardRC) {
    const d = this.drag;
    const rot = rotateFactoryShape({ cells: d.baseCells, funnels: d.baseFunnels }, d.rotation);
    const anchorR = boardRC.r - d.grab.r;
    const anchorC = boardRC.c - d.grab.c;
    if (!this._cellsFitOnBoard(anchorR, anchorC, rot.cells, d.factoryId)) return false;
    this.placed.set(d.factoryId, {
      id: d.factoryId,
      source: d.source === 'board' ? (d.originPlaced ? d.originPlaced.source : 'initial') : 'initial',
      anchor: { row: anchorR, col: anchorC },
      rotation: d.rotation,
      baseCells: d.baseCells, baseFunnels: d.baseFunnels,
      converter: d.converter, locked: false,
    });
    // Clear drag BEFORE re-rendering so _renderBlueprint sees the true
    // post-drop state — otherwise shouldShow stays false and the PLAY +
    // RESET tiles wouldn't fade in after the final factory lands.
    this.drag = null;
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
    return true;
  }

  _dropIntoSlot(slot) {
    const d = this.drag;
    const def = this.blueprintFactories.get(d.factoryId);
    if (def) {
      // Anchor = pointer-slot minus grab offset so the exact cell the user
      // grabbed lands on the tapped slot (critical for multi-cell factories).
      const grab = d.grab || { r: 0, c: 0 };
      const anchor = { r: slot.r - grab.r, c: slot.c - grab.c };
      def.slot = anchor;
      def.rotation = d.rotation;
      this._pushToSlot(anchor, d.factoryId);
    } else {
      // Factory was originally locked or not in blueprint vocabulary —
      // cancel back to its origin instead of orphaning state.
      this._cancelDrag();
    }
    // Clear the in-hand flag BEFORE re-rendering — _renderBlueprint skips the
    // dragged factoryId so the ghost can take over, and without this the
    // newly-slotted factory would stay invisible until the next frame.
    this.drag = null;
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    if (d.source === 'board' && d.originPlaced) {
      this.placed.set(d.originPlaced.id, d.originPlaced);
    } else if (d.source === 'blueprint' && d.originSlot) {
      this._pushToSlot(d.originSlot, d.factoryId);
    }
    // Same reason as _tryPlaceOnBoard / _dropIntoSlot — _renderBlueprint
    // reads this.drag when deciding whether to show the PLAY + RESET tiles.
    this.drag = null;
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
  }

  _clearDrag() {
    this.drag = null;
    this.ghostPulse = null;
    this.ghostFlow = null;             // gfx destroyed by ghostContainer.removeAll
    if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
    this.ghostContainer.removeAll(true);
    this.placementContainer.removeAll(true);
  }

  _cellsFitOnBoard(anchorR, anchorC, cells, ignoreId) {
    const { cols, rows } = this.sourceLevel.board;
    const occupied = this._occupiedCells(ignoreId);
    for (const { r, c } of cells) {
      const br = anchorR + r, bc = anchorC + c;
      if (br < 0 || br >= rows || bc < 0 || bc >= cols) return false;
      if (isBorderCell(this.sourceLevel.board, br, bc)) return false;
      if (occupied.has(`${br},${bc}`)) return false;
    }
    return true;
  }

  _occupiedCells(ignoreId) {
    const set = new Set();
    for (const p of this.placed.values()) {
      if (p.id === ignoreId) continue;
      const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation);
      for (const { r, c } of rot.cells) set.add(`${p.anchor.row + r},${p.anchor.col + c}`);
    }
    // Acid pits are immovable terrain — factories can't drop on them.
    for (const pit of (this.sourceLevel.acidPits || [])) {
      set.add(`${pit.r},${pit.c}`);
    }
    return set;
  }

  _updatePlacementPreview(boardCell) {
    this.placementContainer.removeAll(true);
    if (!this.drag || !boardCell) return;
    const d = this.drag;
    const rot = rotateFactoryShape({ cells: d.baseCells, funnels: d.baseFunnels }, d.rotation);
    const anchorR = boardCell.r - d.grab.r;
    const anchorC = boardCell.c - d.grab.c;
    if (this._cellsFitOnBoard(anchorR, anchorC, rot.cells, d.factoryId)) return;
    const occupied = this._occupiedCells(d.factoryId);
    const { cols, rows } = this.sourceLevel.board;
    const step = this.pxCell + BOARD_GAP;
    const gfx = this.make.graphics({ add: false });
    const lineW = Math.max(3, Math.round(this.pxCell * 0.12));
    gfx.lineStyle(lineW, 0xe63946, 1);
    const pad = this.pxCell * 0.2;
    for (const { r, c } of rot.cells) {
      const br = anchorR + r, bc = anchorC + c;
      const oob = br < 0 || br >= rows || bc < 0 || bc >= cols;
      const buf = !oob && isBorderCell(this.sourceLevel.board, br, bc);
      const occ = !oob && occupied.has(`${br},${bc}`);
      if (!oob && !occ && !buf) continue;
      const x0 = bc * step + pad;
      const y0 = br * step + pad;
      const x1 = bc * step + this.pxCell - pad;
      const y1 = br * step + this.pxCell - pad;
      gfx.beginPath();
      gfx.moveTo(x0, y0); gfx.lineTo(x1, y1);
      gfx.moveTo(x1, y0); gfx.lineTo(x0, y1);
      gfx.strokePath();
    }
    this.placementContainer.add(gfx);
  }

  // ===================================================================
  //   Play / Reset / Pause
  // ===================================================================

  _canPlay() {
    if (this.victory) return false;
    if (this.simState !== 'idle') return false;
    // Every blueprint slot must be empty (player has placed every initial).
    for (const stack of this.blueprint.values()) if (stack.length > 0) return false;
    // And the level must have at least one factory in play — either declared
    // in initialFactories/lockedFactories OR pre-placed via the community
    // fallback path (level.factories[]).
    if (this.blueprintFactories.size > 0) return true;
    if ((this.sourceLevel.lockedFactories || []).length > 0) return true;
    if (this.startingState && this.startingState.placed.length > 0) return true;
    return false;
  }

  _startPlay() {
    if (!this._canPlay()) return;
    this.satisfiedOutputs.clear();
    this.satisfiedCollectors.clear();
    this.simTime = 0;
    this.sim.start(this._composeLevel(), this.simTime);
    this.simState = 'running';
    this._renderIconIsland();
  }

  _pause() {
    if (this.simState !== 'running') return;
    this.sim.pause(this.simTime);
    this.simState = 'paused';
    this._renderIconIsland();
  }

  _resume() {
    if (this.simState !== 'paused') return;
    this.sim.resume(this.simTime);
    this.simState = 'running';
    this._renderIconIsland();
  }

  _resetPlay() {
    // Drop any in-flight hint / rotation state — a live tween would land
    // its factory into a scene that's about to be rebuilt.
    if (this._hintModal) { this._hintModal.destroy(); this._hintModal = null; }
    this._hintTweenBusy = false;
    this._rotateTweenBusy = false;
    // Drop any in-flight victory visuals — reset means "start the level
    // over clean", including nuking the delayed "completed" banner.
    if (this._victoryTextBg)   { this._victoryTextBg.destroy();   this._victoryTextBg = null; }
    if (this._victoryTextName) { this._victoryTextName.destroy(); this._victoryTextName = null; }
    if (this._victoryTextSub)  { this._victoryTextSub.destroy();  this._victoryTextSub  = null; }
    this.victory = null;
    // Boss levels: RESET sends the player all the way back to round 1 (no
    // mid-boss save state). Recompose the level for round 0 with no
    // locked carry, then fall through to the standard reset below.
    if (this._bossState && this._sourceLevelOriginal && this._sourceLevelOriginal.boss) {
      this._bossState = { roundIdx: 0, locked: [] };
      this.sourceLevel = bossRoundLevel(this._sourceLevelOriginal, 0, []);
      this.sim && this.sim.stop();
      if (this.shapeRenderer) this.shapeRenderer.clearAll();
      if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
      this.satisfiedOutputs && this.satisfiedOutputs.clear();
      this.satisfiedCollectors && this.satisfiedCollectors.clear();
      this.simState = 'idle';
      this.simTime = 0;
      this._initRuntime();
      this._renderAll();
      this._renderBlueprint();
      this._renderIconIsland();
      return;
    }
    this.sim && this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this.satisfiedOutputs.clear();
    this.satisfiedCollectors.clear();
    this.simState = 'idle';
    this.simTime = 0;
    // Restore: every initial factory back to its starting slot + rotation;
    // every locked factory remains placed (we never removed them since
    // _canDrag short-circuits on locked).
    this.placed.clear();
    for (const lf of (this.sourceLevel.lockedFactories || [])) {
      const norm = normalizeFactory(lf.cells, lf.funnels || []);
      this.placed.set(lf.id || genId(), {
        id: lf.id, source: 'locked', anchor: { ...lf.anchor },
        rotation: 0, baseCells: norm.cells, baseFunnels: norm.funnels,
        converter: lf.converter, locked: true,
      });
    }
    this.blueprint.clear();
    for (const def of this.blueprintFactories.values()) {
      def.slot = { ...def.defaultSlot };
      def.rotation = def.defaultRotation;
      this._pushToSlot(def.slot, def.id);
    }
    // Restore community-fallback pre-placed factories (those that weren't
    // authored as locked or as blueprint slots).
    for (const sp of (this.startingState ? this.startingState.placed : [])) {
      this.placed.set(sp.id, {
        id: sp.id, source: 'initial', anchor: { ...sp.anchor },
        rotation: sp.rotation || 0,
        baseCells: sp.baseCells, baseFunnels: sp.baseFunnels,
        converter: sp.converter, locked: false,
      });
    }
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
  }

  // Tap anywhere outside the icon island and the blueprint while a sim is
  // running → STOP the sim and clear all live shapes. Factories on the
  // board stay where they are so the player can adjust placements without
  // restarting from the blueprint. Replaces the previous pause-on-tap
  // behavior; the platform-driven pause/resume on app visibility is
  // unchanged (still uses Simulation.pause/resume).
  _maybeStopOnTap(pointer) {
    if (this.simState !== 'running') return;
    if (this.victory) return;
    if (this._inIconIsland(pointer.x, pointer.y)) return;
    if (this._inBlueprintArea(pointer.x, pointer.y)) return;
    this._stopPlay();
  }

  _stopPlay() {
    if (this.simState !== 'running') return;
    this.sim && this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    this.simState = 'idle';
    this.simTime = 0;
    // Re-render so the empty-blueprint PLAY/RESET tiles come back, and the
    // icon-island RESET re-evaluates its enabled state.
    this._renderBlueprint();
    this._renderIconIsland && this._renderIconIsland();
  }

  _inIconIsland(x, y) {
    const lx = x - this.iconIslandOriginX;
    const ly = y - this.iconIslandOriginY;
    return lx >= 0 && ly >= 0 && lx <= ICON_SLOTS * this.islandSlotW && ly <= this.islandH;
  }

  _inBlueprintArea(x, y) {
    if (this.blueprintOriginX == null) return false;
    const lx = x - this.blueprintOriginX;
    const ly = y - this.blueprintOriginY;
    return lx >= 0 && ly >= 0 && lx <= this.blueprintW && ly <= this.blueprintH;
  }

  // ===================================================================
  //   Victory
  // ===================================================================

  // Lerp each bolt's `glow` toward the sim's powered target over CYCLE_MS,
  // redraw each bolt, and drive the factory perimeter electricity off the
  // aggregate (max) glow on the factory.
  _updateBoltVisuals() {
    if (!this.sim || !this.factoryRefs) return;
    const powered = this.sim.boltPowered || new Map();
    const now = this.time.now;
    const dt = Math.max(0, Math.min(60, this.game.loop.delta || 16));
    const step = dt / CYCLE_MS;
    for (const entry of this.factoryRefs.values()) {
      const bolts = entry.body && entry.body.bolts;
      if (!bolts) continue;
      let minGlow = 1;
      for (const b of bolts) {
        const key = `${entry.factoryId}:${b.cellR},${b.cellC}`;
        const target = powered.get(key) ? 1 : 0;
        if      (b.glow < target) b.glow = Math.min(target, b.glow + step);
        else if (b.glow > target) b.glow = Math.max(target, b.glow - step);
        drawBoltInto(b.gfx, b.size, b.glow, now);
        if (b.glow < minGlow) minGlow = b.glow;
      }
      if (entry.body && entry.body.poweredGlow) {
        // Body goes lit only when EVERY bolt is fully powered — a single
        // dark bolt keeps the whole factory inert.
        entry.body.poweredGlow.alpha = minGlow >= 1 ? 1 : 0;
      }
    }
  }

  _onOutputSatisfied(funnel) {
    this.satisfiedOutputs.add(funnel.key);
    this._checkVictory();
  }

  _onCollectorSatisfied(collector) {
    this.satisfiedCollectors.add(collector.key);
    // Stamp the green check on the collector's buffer tile — same visual
    // language as a matched typed-sink hit.
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.mark(collector, true);
    this._checkVictory();
  }

  _checkVictory() {
    const outputs = (this.sourceLevel.outputs || []);
    for (const o of outputs) {
      const k = `border:${o.r},${o.c},${o.side}`;
      if (!this.satisfiedOutputs.has(k)) return;
    }
    // Collectors are AUTHORED in border.funnels with role:'collector'.
    const level = this._composeLevel();
    const collectors = ((level.border && level.border.funnels) || []).filter((f) => f.role === 'collector');
    for (const c of collectors) {
      const k = `border:${c.r},${c.c},${c.side}`;
      if (!this.satisfiedCollectors.has(k)) return;
    }
    if (outputs.length === 0 && collectors.length === 0) return;
    this._fireVictory();
  }

  _fireVictory() {
    if (this.victory) return;
    // Victory cancels any pending stuck nudge regardless of boss/non-boss —
    // intra-boss round resets schedule a fresh timer in _advanceBossRound.
    this._resetStuckPopup();
    // Boss flow — advance to the next round instead of marking the level
    // beaten + transitioning. The final round falls through to the normal
    // victory path so beaten/credits/auto-advance still happen.
    if (this._isBossWithMoreRounds()) {
      this.victory = true;       // gates duplicate fires from _onOutputSatisfied
      this.time.delayedCall(CYCLE_MS, () => this._advanceBossRound());
      return;
    }
    this.victory = true;
    if (this._sourceLevelOriginal && this._sourceLevelOriginal.id) {
      markBeaten(this._sourceLevelOriginal.id);
    } else if (this.sourceLevel.id) {
      markBeaten(this.sourceLevel.id);
    }
    // Hold for one cycle of animation so the last shape has a moment to
    // visibly land, then announce. Sim keeps running behind the banner.
    this.time.delayedCall(CYCLE_MS, () => this._showVictoryText());
  }

  _isBossWithMoreRounds() {
    if (!this._bossState || !this._sourceLevelOriginal || !this._sourceLevelOriginal.boss) return false;
    const total = this._sourceLevelOriginal.boss.rounds.length;
    return this._bossState.roundIdx + 1 < total;
  }

  // Snapshot every non-locked placed factory into the boss-locked carry,
  // increment the round, recompose the level, and re-init runtime + render.
  _advanceBossRound() {
    if (!this.scene || !this._isBossWithMoreRounds()) return;
    if (this._hintModal) { this._hintModal.destroy(); this._hintModal = null; }
    this._hintTweenBusy = false;
    const carry = [];
    for (const p of this.placed.values()) {
      if (p.locked) continue;       // pre-existing locked factories already in lockedFactories
      const rot = rotateFactoryShape({ cells: p.baseCells, funnels: p.baseFunnels }, p.rotation);
      carry.push({
        id: p.id,
        anchor: { ...p.anchor },
        cells: rot.cells,
        funnels: rot.funnels,
      });
    }
    this._bossState.locked.push(...carry);
    this._bossState.roundIdx += 1;
    this.victory = null;
    this.sim && this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    this.simState = 'idle';
    this.simTime = 0;
    this.satisfiedOutputs && this.satisfiedOutputs.clear();
    this.satisfiedCollectors && this.satisfiedCollectors.clear();
    this.sourceLevel = bossRoundLevel(
      this._sourceLevelOriginal,
      this._bossState.roundIdx,
      this._bossState.locked,
    );
    this._initRuntime();
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    // Fresh round → reset the stuck timer so the popup respects the new
    // round's clock instead of carrying over the prior round's schedule.
    this._startStuckPopupTimer();
  }

  _showVictoryText() {
    if (!this.scene || !this.victory || this._victoryTextName) return;
    // Anchor the message over the playable board, not the whole scene, so
    // it sits on the interesting bit of the screen.
    const boardCX = this.boardOriginX + this.boardW / 2;
    const rows = this.sourceLevel.board.rows;
    const boardH = rows * this.pxCell + (rows - 1) * BOARD_GAP;
    const boardCY = this.boardOriginY + boardH / 2;
    const bandH = 190;
    this._victoryTextBg = this.add.graphics().setDepth(8998);
    this._victoryTextBg.fillStyle(0x000000, 0.45);
    this._victoryTextBg.fillRect(this.boardOriginX, boardCY - bandH / 2, this.boardW, bandH);
    const name = (this.sourceLevel && this.sourceLevel.name) || 'Level';
    this._victoryTextName = this.add.text(boardCX, boardCY - 30, name, {
      fontFamily: 'system-ui, sans-serif', fontSize: '52px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(8999);
    this._victoryTextSub = this.add.text(boardCX, boardCY + 46, 'completed', {
      fontFamily: 'system-ui, sans-serif', fontSize: '36px',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(8999);
    // Disable input during the message so stray taps can't derail auto-advance.
    if (this.input) this.input.enabled = false;
    // Longer display (2s) so the name reads clearly before the transition.
    this.time.delayedCall(2000, () => this._advanceAfterVictory());
  }

  _advanceAfterVictory() {
    if (!this.victory) return;           // reset in-flight; abort the auto-advance
    const isCommunity = this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported';
    const next = (!isCommunity && this.sourceLevel.id) ? nextLevelAfter(this.sourceLevel.id) : null;
    // Re-enable input so SceneFader's own disable/enable cycle works cleanly.
    if (this.input) this.input.enabled = true;
    if (next) {
      fadeTo(this, 'Player', { levelId: next.id });
    } else {
      fadeTo(this, isCommunity ? 'Community' : 'LevelSelect');
    }
  }

  // ===================================================================
  //   Viewport
  // ===================================================================

  _relayoutForViewport() {
    if (!this.ready) return;
    const wasState = this.simState;
    if (wasState !== 'idle') { this.sim.stop(); this.simState = 'idle'; }
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this._layoutBoardAndBlueprint();
    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this._composeLevel(), {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (accepted && funnel.ownerId === 'border') this._onOutputSatisfied(funnel);
      },
      onCollectorSatisfied: (c) => this._onCollectorSatisfied(c),
    });
    // Populate laser state without starting the sim so each emitter renders
    // its idle charge animation before the player presses Play.
    this.sim.prepEntities(this._composeLevel());
    if (this.laserRenderer) this.laserRenderer.destroy();
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.resize(this.pxCell);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.resize(this.pxCell);
    if (this.titleBar) this.titleBar.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
    this._updateHintButtonState();
  }
}

function slotKey(r, c) { return `${r},${c}`; }

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

// Build the level snapshot for boss round `roundIdx`. The shared `board`
// + `name` carry over; per-round `border / inputs / outputs /
// initialFactories / instructionalText` come from boss.rounds[roundIdx].
// `lockedCarry` is the array of factories the player placed in earlier
// rounds — they're appended to the level's `lockedFactories` so they
// render with the lock pin + darken tint and are immovable.
function bossRoundLevel(srcLevel, roundIdx, lockedCarry) {
  const r = (srcLevel.boss && srcLevel.boss.rounds && srcLevel.boss.rounds[roundIdx]) || {};
  return {
    ...srcLevel,
    border: r.border || { funnels: [] },
    inputs: r.inputs || [],
    outputs: r.outputs || [],
    initialFactories: r.initialFactories || [],
    lockedFactories: [...(srcLevel.lockedFactories || []), ...lockedCarry],
    instructionalText: r.instructionalText || null,
    // Strip `boss` so the per-round snapshot can't trigger another boss
    // composition recursively (e.g. after _composeLevel persists state).
    boss: null,
  };
}

function stampEdge(gfx, x1, y1, x2, y2, spacing) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    gfx.fillCircle(x1 + dx * t, y1 + dy * t, 1.3);
  }
}
