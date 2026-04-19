import Phaser from 'phaser';
import { loadLevel, genId } from '../model/level.js';
import {
  rotateFactoryShape, isBorderCell, normalizeFactory,
} from '../model/shape.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody } from '../render/FactoryBodyRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderFlow } from '../render/FlowRenderer.js';
import { renderBufferLabels } from '../render/BufferLabelRenderer.js';
import { renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline } from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { BufferMarkerRenderer } from '../render/BufferMarkerRenderer.js';
import { TitleBar } from '../ui/TitleBar.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { compute920Box } from '../ui/ContentBox.js';
import { Simulation } from '../sim/Simulation.js';
import { DragController } from '../input/DragController.js';
import { shapeSquash } from '../render/pulse.js';
import { VictoryModal } from '../ui/VictoryModal.js';
import { drawHome, drawTrash } from '../ui/Icons.js';
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
const ICON_SLOTS  = 4;
const SLOT_BACK   = 0;
const SLOT_RESET  = 2;
const SLOT_PLAY   = 3;

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
    this.victory = null;
    this.factoryRefs = new Map();  // id → { bodyWrap, funnelWrap }
    this.blueprintRefs = new Map();// id → { bodyWrap, funnelWrap }
    this.flowUpdaters = [];

    // Layer order. Mirrors EditorScene: brown checker covers buffer + outside,
    // factories sit under it via the cut-out trick.
    this.boardContainer       = this.add.container(0, 0).setDepth(0);
    this.shapeContainer       = this.add.container(0, 0).setDepth(10);
    this.funnelContainer      = this.add.container(0, 0).setDepth(15);
    this.interactiveContainer = this.add.container(0, 0).setDepth(20);
    // Flow dashes sit on top of the factory body (see EditorScene comment).
    this.flowContainer        = this.add.container(0, 0).setDepth(22);
    this.exteriorContainer    = this.add.container(0, 0).setDepth(25);
    this.shadowContainer       = this.add.container(0, 0).setDepth(140);
    this.borderFunnelContainer = this.add.container(0, 0).setDepth(145);
    this.labelContainer        = this.add.container(0, 0).setDepth(150);
    this.bufferMarkerContainer = this.add.container(0, 0).setDepth(155);
    this.frameContainer        = this.add.container(0, 0).setDepth(160);
    this.blueprintContainer    = this.add.container(0, 0).setDepth(50);
    this.blueprintFlowContainer= this.add.container(0, 0).setDepth(51);
    this.blueprintBodyContainer= this.add.container(0, 0).setDepth(52);
    this.iconIslandContainer   = this.add.container(0, 0).setDepth(54);
    this.ghostContainer        = this.add.container(0, 0).setDepth(70);
    this.placementContainer    = this.add.container(0, 0).setDepth(80);

    // Resolve the level. Priority: inline level (from CommunityScene) →
    // catalog level by id → editor sandbox fallback.
    let source = this._inlineLevel || (this._levelId ? getLevelById(this._levelId) : null);
    if (!source) source = await loadLevel();
    this.sourceLevel = source;

    this._initRuntime();
    this._layoutBoardAndBlueprint();
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
    this._buildToolbar();

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
    });

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
    this.input.on('pointerdown', (pointer) => this._maybePauseOnTap(pointer));

    this._onScaleResize = () => this._relayoutForViewport();
    this.scale.on('resize', this._onScaleResize);

    this.events.on('shutdown', () => {
      this.sim && this.sim.stop();
      this.dragCtrl && this.dragCtrl.destroy();
      if (this.victoryModal) { this.victoryModal.destroy(); this.victoryModal = null; }
      if (this._onScaleResize) this.scale.off('resize', this._onScaleResize);
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
    setPos(this.interactiveContainer,  this.boardOriginX, this.boardOriginY);
    setPos(this.flowContainer,         this.boardOriginX, this.boardOriginY);
    setPos(this.shapeContainer,        this.boardOriginX, this.boardOriginY);
    setPos(this.funnelContainer,       this.boardOriginX, this.boardOriginY);
    setPos(this.exteriorContainer,     this.boardOriginX, this.boardOriginY);
    setPos(this.shadowContainer,       this.boardOriginX, this.boardOriginY);
    setPos(this.borderFunnelContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.frameContainer,        this.boardOriginX, this.boardOriginY);
    setPos(this.labelContainer,        this.boardOriginX, this.boardOriginY);
    setPos(this.bufferMarkerContainer, this.boardOriginX, this.boardOriginY);
    setPos(this.placementContainer,    this.boardOriginX, this.boardOriginY);
    setPos(this.blueprintContainer,    this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.blueprintFlowContainer,this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.blueprintBodyContainer,this.blueprintOriginX, this.blueprintOriginY);
    setPos(this.iconIslandContainer,   this.iconIslandOriginX, this.iconIslandOriginY);
    setPos(this.ghostContainer,        0, 0);
  }

  // ===================================================================
  //   Render
  // ===================================================================

  _renderAll() {
    this._clearBoardDynamic();
    const lvl = this._composeLevel();
    renderInteriorFloor(this, this.boardContainer, { board: lvl.board, pxCell: this.pxCell });
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
      converter: factory.converter, locked: !!factory.locked,
    });
    body.setPosition(-cx, -cy);
    const flow = renderFlow(this, this.flowContainer, {
      cells: absCells, funnels: absFunnels, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.flowUpdaters.push(flow);
    return { bodyWrap, funnelWrap, body, funnels };
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

    const dots = this.make.graphics({ add: false });
    dots.fillStyle(BLUEPRINT_DOT, 0.9);
    const DOT_SPACING = 6;
    for (let r = 0; r <= slotRows; r++) {
      for (let c = 0; c <= slotCols; c++) {
        if (c < slotCols) stampEdge(dots, c * slotPx, r * slotPx, (c + 1) * slotPx, r * slotPx, DOT_SPACING);
        if (r < slotRows) stampEdge(dots, c * slotPx, r * slotPx, c * slotPx, (r + 1) * slotPx, DOT_SPACING);
      }
    }
    this.blueprintContainer.add(dots);

    // Render every factory in each occupied slot (D4: fanned stack, lower
    // layers offset + dimmed; the topmost layer is opaque and is what tap-
    // and drag-pickup target). Factories currently being dragged are skipped
    // — the ghost takes over their visual.
    for (const [, stack] of this.blueprint) {
      if (stack.length === 0) continue;
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
    this.blueprintBodyContainer.add(bodyWrap);
    this.blueprintBodyContainer.add(funnelWrap);
    const funnels = renderFunnels(this, funnelWrap, funnelsLocal, { pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE });
    funnels.setPosition(-cx, -cy);
    const body = renderFactoryBody(this, bodyWrap, {
      cells: cellsLocal, pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
      converter: def.converter,
    });
    body.setPosition(-cx, -cy);
    if (isTop) {
      // Only the top of a stack draws its animated flow — fanned lower
      // layers would smear the playable preview otherwise. Track the flow
      // updater so the scene's update() loop animates the dashes.
      const flow = renderFlow(this, this.blueprintFlowContainer, {
        cells: cellsLocal.map((c) => ({ r: c.r + def.slot.r, c: c.c + def.slot.c })),
        funnels: funnelsLocal.map((f) => ({ ...f, r: f.r + def.slot.r, c: f.c + def.slot.c })),
        pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
      });
      if (!this.blueprintFlows) this.blueprintFlows = [];
      this.blueprintFlows.push(flow);
    }
    if (isTop) this.blueprintRefs.set(def.id, { bodyWrap, funnelWrap, body, funnels });
  }

  // ---------- Icon island (BACK / RESET / PLAY) ----------

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

    // BACK glyph (home).
    const home = this.make.graphics({ add: false });
    drawHome(home, SLOT_BACK * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
    this.iconIslandContainer.add(home);

    // RESET glyph (trash bin — using the existing icon for "wipe").
    const reset = this.make.graphics({ add: false });
    drawTrash(reset, SLOT_RESET * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
    this.iconIslandContainer.add(reset);

    // PLAY label — text-based, enabled when ready or paused.
    const canPlay = this._canPlay() || this.simState === 'paused';
    const playColor = canPlay ? '#ffffff' : '#9aa6b2';
    const playText = this.simState === 'paused' ? 'RESUME'
                    : this.simState === 'running' ? 'RUNNING' : 'PLAY';
    const playLabel = this.add.text(
      SLOT_PLAY * slotW + slotW / 2, cy, playText,
      { fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold', color: playColor },
    ).setOrigin(0.5);
    this.iconIslandContainer.add(playLabel);

    // Hit rects.
    const makeHit = (slot, onTap) => {
      const cx = this.iconIslandOriginX + slot * slotW + slotW / 2;
      const ay = this.iconIslandOriginY + islandH / 2;
      const rect = this.add.rectangle(cx, ay, slotW - 6, islandH - 6, 0xffffff, 0)
        .setInteractive({ useHandCursor: true });
      rect.on('pointerup', onTap);
      this.iconHits.push(rect);
    };
    makeHit(SLOT_BACK, () => {
      this.sim && this.sim.stop();
      fadeTo(this, 'Home');
    });
    makeHit(SLOT_RESET, () => this._resetPlay());
    makeHit(SLOT_PLAY, () => {
      if (this.simState === 'idle' && this._canPlay()) this._startPlay();
      else if (this.simState === 'paused') this._resume();
    });
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
      rightButton: {
        kind: 'hint',
        onTap: () => { console.log('[hint] stub'); },
      },
    });
  }

  // ===================================================================
  //   Update loop
  // ===================================================================

  update(time, delta) {
    if (!this.ready) return;
    if (this.simState === 'running') this.simTime += delta;
    const t = (this.simTime % CYCLE_MS) / CYCLE_MS;
    const sq = shapeSquash(t);
    const applyPair = (entry) => {
      if (entry.bodyWrap)   { entry.bodyWrap.scaleX   = sq.body.scaleX;    entry.bodyWrap.scaleY   = sq.body.scaleY; }
      if (entry.funnelWrap) { entry.funnelWrap.scaleX = sq.funnels.scaleX; entry.funnelWrap.scaleY = sq.funnels.scaleY; }
    };
    for (const entry of this.factoryRefs.values())   applyPair(entry);
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

    if (this.drag) {
      const smooth = 0.35;
      this.ghostContainer.x += (this.ghostTargetX - this.ghostContainer.x) * smooth;
      this.ghostContainer.y += (this.ghostTargetY - this.ghostContainer.y) * smooth;
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
    return { r, c };
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
    if (info.kind === 'board') return !!this._placedAtBoardCell(info.r, info.c);
    if (info.kind === 'blueprint') return !!this._findBlueprintFactoryAt(info.r, info.c);
    return false;
  }

  _onTapCell(info) {
    if (!info) return;
    if (this.simState !== 'idle' || this.victory) return;
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
    if (!this._cellsFitOnBoard(p.anchor.row, p.anchor.col, rot.cells, p.id)) return;
    p.rotation = newRot;
    this._renderAll();
  }

  _rotateBlueprint(def) {
    def.rotation = (def.rotation + 1) % 4;
    this._renderBlueprint();
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
    this.ghostContainer.removeAll(true);
    this.ghostFlow = null;
    const rot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, rotation);
    const [cx, cy] = factoryCenter(rot.cells, this.pxCell, BOARD_GAP);
    const fWrap = this.add.container(cx, cy);
    const bWrap = this.add.container(cx, cy);
    this.ghostContainer.add(fWrap);
    this.ghostContainer.add(bWrap);
    const fns = renderFunnels(this, fWrap, rot.funnels, { pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
    fns.setPosition(-cx, -cy);
    const body = renderFactoryBody(this, bWrap, { cells: rot.cells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
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
    // If from blueprint, also keep the def around so subsequent picks know the
    // canonical slot — but the def itself stays in blueprintFactories until
    // the player resets. We don't push back to blueprint.
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
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
  }

  _clearDrag() {
    this.drag = null;
    this.ghostPulse = null;
    this.ghostFlow = null;             // gfx destroyed by ghostContainer.removeAll
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
    if (this.victoryModal) { this.victoryModal.destroy(); this.victoryModal = null; }
    this.victory = null;
    this.sim && this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this.satisfiedOutputs.clear();
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

  _maybePauseOnTap(pointer) {
    if (this.simState !== 'running') return;
    if (this.victory) return;
    // Don't pause if the tap landed on the icon island (the PLAY/RESET
    // buttons handle their own behavior).
    if (this._inIconIsland(pointer.x, pointer.y)) return;
    this._pause();
  }

  _inIconIsland(x, y) {
    const lx = x - this.iconIslandOriginX;
    const ly = y - this.iconIslandOriginY;
    return lx >= 0 && ly >= 0 && lx <= ICON_SLOTS * this.islandSlotW && ly <= this.islandH;
  }

  // ===================================================================
  //   Victory
  // ===================================================================

  _onOutputSatisfied(funnel) {
    this.satisfiedOutputs.add(funnel.key);
    const required = (this.sourceLevel.outputs || []);
    if (required.length === 0) return;
    for (const o of required) {
      const k = `border:${o.r},${o.c},${o.side}`;
      if (!this.satisfiedOutputs.has(k)) return;
    }
    this._fireVictory();
  }

  async _fireVictory() {
    if (this.victory) return;
    this.victory = true;
    if (this.simState === 'running') {
      this.sim.pause(this.simTime);
      this.simState = 'paused';
    }
    if (this.sourceLevel.id) await markBeaten(this.sourceLevel.id);
    // Community-origin levels don't have a "next in section" — Next is
    // disabled, and the Level Select button routes back to Community.
    const isCommunity = this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported';
    const next = (!isCommunity && this.sourceLevel.id) ? nextLevelAfter(this.sourceLevel.id) : null;
    this.victoryModal = new VictoryModal(this, {
      hasNext: !!next,
      onNext: () => {
        if (!next) return;
        fadeTo(this, 'Player', { levelId: next.id });
      },
      onRetry: () => {
        if (this.victoryModal) { this.victoryModal.destroy(); this.victoryModal = null; }
        this.victory = null;
        this._resetPlay();
      },
      onLevelSelect: () => fadeTo(this, isCommunity ? 'Community' : 'LevelSelect'),
    });
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
    });
    if (this.titleBar) this.titleBar.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderBlueprint();
    this._renderIconIsland();
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

function stampEdge(gfx, x1, y1, x2, y2, spacing) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    gfx.fillCircle(x1 + dx * t, y1 + dy * t, 1.3);
  }
}
