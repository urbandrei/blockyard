import Phaser from 'phaser';
import { loadLevel, saveLevel, genId, seedDefaultFunnels, defaultLevel } from '../model/level.js';
import { getCommunityLevelById, saveLocal as saveCommunityLocal } from '../community.js';
import { SaveMenu } from '../ui/SaveMenu.js';
import { TextInputOverlay } from '../ui/TextInputOverlay.js';
import {
  cellsToSet, isContiguous, isAdjacentToFactory, isPerimeterEdge,
  normalizeFactory, isBorderCell, innerSideOf, funnelPolyPoints,
  validateFactory,
} from '../model/shape.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody } from '../render/FactoryBodyRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderFlow } from '../render/FlowRenderer.js';
import { renderBufferLabels, computeBufferLabelBox } from '../render/BufferLabelRenderer.js';
import { renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline } from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { BufferMarkerRenderer } from '../render/BufferMarkerRenderer.js';
import { TitleBar } from '../ui/TitleBar.js';
import { FunnelTypePicker } from '../ui/FunnelTypePicker.js';
import { CellLabelPicker } from '../ui/CellLabelPicker.js';
import { ExportPanel } from '../ui/ExportPanel.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { rotateFactoryShape } from '../model/shape.js';
import { DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { drawBackChevron, drawQuestion, drawTrash, drawPlus, drawMinus } from '../ui/Icons.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { compute920Box } from '../ui/ContentBox.js';
import { Simulation } from '../sim/Simulation.js';
import { DragController } from '../input/DragController.js';
import { shapeSquash } from '../render/pulse.js';
import {
  BOARD_GAP, CYCLE_MS, SHAPE_SCALE, motionWarp,
  BLUEPRINT_BG, BLUEPRINT_DOT, BLUEPRINT_STROKE,
} from '../constants.js';

// Fractional elongation along motion direction at peak speed; the
// perpendicular axis contracts by 1/stretch so area is preserved. Kept
// subtle — this is a nod, not a squish.
const SHAPE_WARP_AMP = 0.15;

// Editor scene. Board at the top, 5x5 factory-draft grid at the bottom:
//   • Tap a draw-grid cell to add it to the draft (must stay 4-connected).
//   • Tap a filled draw-grid cell to remove it (contiguity-checked).
//   • Tap a draft's outer edge to cycle its funnel: none → input → output → none.
//   • Press-drag a filled draft cell and release on a board cell to place.
//   • Tap a placed factory to remove it.
//   • Tap a border cell's inner edge to cycle a border funnel.
//   • Play/Stop in the toolbar runs the sim (shapes flow through factories).

const TOOLBAR_H = TitleBar.HEIGHT + 24;   // space reserved above the play area
const ICON_SLOTS = 5;                     // fixed — BACK, HINT, -, +, CLEAR

// Blueprint (draft-composer) chrome. Grid + a small separate icon island
// sitting below the grid in its own rounded-rect panel.
const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;

// Which slot holds which icon.
const SLOT_BACK   = 0;
const SLOT_HINT   = 1;
const SLOT_SHRINK = 2;
const SLOT_GROW   = 3;
const SLOT_CLEAR  = 4;

// Board resize clamps (for the +/- buttons; testing-only knob).
const BOARD_MIN_DIM = 3;
const BOARD_MAX_DIM = 9;

// Resize transition: instant swap, then screenwide fade-in via camera
// alpha. Duration tuned so the discontinuity reads as a soft "flash" rather
// than a hard jump.
const RESIZE_FADE_MS = 280;

export default class EditorScene extends Phaser.Scene {
  constructor() { super({ key: 'Editor' }); }

  init(data) {
    // Designer mode (Milestone G): the editor doubles as a community-level
    // designer. The scene loads the community level by id (or starts a fresh
    // one when no id), persists changes to community storage rather than the
    // sandbox key, and replaces the title-bar number pill with a SAVE button.
    this._designerMode = !!(data && data.designerMode);
    this._designerLevelId = (data && data.levelId) || null;
  }

  async create() {
    fadeIn(this);
    // Synchronous field init BEFORE the await so update() never sees undefined
    // state on the first frame.
    this.ready = false;
    this.level = null;
    this.draftCells = [];
    this.draftFunnels = [];
    this.drag = null;

    // Layer order (back to front). Explicit setDepth so the ordering doesn't
    // depend on scene display-list insertion order (graphics added later inside
    // the rendering functions would otherwise end up on top of everything).
    // Back → front layering:
    //   boardContainer (0)      peach interior floor
    //   flowContainer (5)       dashed flow lines
    //   shapeContainer (10)     sim shapes
    //   funnelContainer (15)    funnel triangles
    //   interactiveContainer (20)  factory bodies + bridges
    //   exteriorContainer (25)  brown checker WITH interior hole (the "cut-out")
    //   frameContainer (30)     black frame + inner shadow + buffer labels
    this.boardContainer       = this.add.container(0, 0).setDepth(0);
    this.shapeContainer       = this.add.container(0, 0).setDepth(10);
    this.funnelContainer      = this.add.container(0, 0).setDepth(15);
    this.interactiveContainer = this.add.container(0, 0).setDepth(20);
    // Flow dashes sit on top of the factory body so the manifold pattern is
    // visible (the body is opaque mid-grey; at depth < body the dashes were
    // hidden). Above body, below the brown exterior cut-out (25).
    this.flowContainer        = this.add.container(0, 0).setDepth(22);
    this.exteriorContainer    = this.add.container(0, 0).setDepth(25);
    // Frame chrome is split across depths so border-funnel triangles AND
    // buffer labels sit BETWEEN the inner shadow and the outline — both
    // rendered UNDER the black edge, just like interior factories are
    // under the frame.
    this.shadowContainer       = this.add.container(0, 0).setDepth(140);
    this.borderFunnelContainer = this.add.container(0, 0).setDepth(145);
    this.labelContainer        = this.add.container(0, 0).setDepth(150);
    this.bufferMarkerContainer = this.add.container(0, 0).setDepth(155);
    this.frameContainer        = this.add.container(0, 0).setDepth(160);
    // Error badges (red text over invalid factories) sit above the frame
    // outline so they're always legible.
    this.errorContainer        = this.add.container(0, 0).setDepth(170);
    this.drawGridContainer    = this.add.container(0, 0).setDepth(50);
    this.iconIslandContainer  = this.add.container(0, 0).setDepth(52);
    this.hoverContainer       = this.add.container(0, 0).setDepth(60);
    this.boardHoverContainer  = this.add.container(0, 0).setDepth(60);
    // ghost renders below placement so the red-X invalid markers sit ON TOP
    // of the dragged shape, clearly flagging the conflicting cells.
    this.ghostContainer       = this.add.container(0, 0).setDepth(70);
    this.placementContainer   = this.add.container(0, 0).setDepth(80);

    this.factoryRefs = new Map();
    this.flowUpdaters = [];

    // Smooth-lerp target for the ghost. Set each pointermove during a drag;
    // the update() loop eases the ghost's actual position toward it so snap
    // transitions feel fluid.
    this.ghostTargetX = 0;
    this.ghostTargetY = 0;

    this.level = await this._resolveInitialLevel();

    this._layoutBoardAndDrawGrid();
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._buildToolbar();

    this._reapplyLetterbox = wireLetterboxChecker(this, () => ({
      pxCell: this.pxCell,
      boardOriginX: this.boardOriginX,
      boardOriginY: this.boardOriginY,
    }));

    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (accepted && funnel.ownerId === 'border') {
          this._onEditorOutputSatisfied(funnel);
        }
      },
    });

    this._satisfiedOutputs = new Set();
    this._victoryReady = false;
    this._mode = 'design';                  // 'design' | 'blueprintSetup'
    this._blueprintAssignments = new Map(); // factoryId -> { slot:{r,c}, rotation }
    this._solutionSnapshot = null;

    this.dragCtrl = new DragController(this, {
      isOverCell:      (x, y) => this._cellAt(x, y),
      isOverEdge:      (x, y) => this._edgeAt(x, y),
      isOverBoardCell: (x, y) => this._boardCellAt(x, y),
      onToggleCell:    (info) => this._onToggleCell(info),
      onToggleFunnel:  (info) => this._onToggleFunnel(info),
      onDragStart:     (info) => this._onDragStart(info),
      onDragMove:      (x, y) => this._onDragMove(x, y),
      onDragEnd:       (info) => this._onDragEnd(info),
      canDrag:         (info) => {
        if (!info) return false;
        if (this._mode === 'blueprintSetup') {
          if (info.kind === 'draft') return !!this._findAssignmentAt(info.r, info.c);
          if (info.kind === 'board') return !!this._factoryAtBoardCell(info.r, info.c);
          return false;
        }
        if (info.kind === 'draft') return this._isDraftCell(info.r, info.c);
        if (info.kind === 'board') {
          const fac = this._factoryAtBoardCell(info.r, info.c);
          return !!fac && !fac.locked;
        }
        return false;
      },
      // FunnelTypePicker uses a fullscreen shield to capture taps; gate the
      // drag controller on it so a tap inside the picker can't also fire a
      // funnel-edge toggle behind it.
      isPlaying:       () => !!this.funnelPicker || !!this.cellLabelPicker || !!this.saveMenu || !!this.exportPanel || !!this.nameInput,
    });

    // Sim auto-runs in the editor so funnels emit shapes as you design. Any
    // level mutation (place/remove factory, cycle border funnel, clear) calls
    // _restartSim() to pick up the new funnel/wall layout.
    this._restartSim();

    // Hover preview for the draw grid: as the pointer moves over an empty-but-
    // adjacent cell, show a grey ghost of the cell that would be added. Over
    // a perimeter edge that doesn't yet have an output funnel, show a grey
    // ghost of the NEXT funnel state (input if none, output if input).
    this.input.on('pointermove', (pointer) => this._updateHoverPreview(pointer.x, pointer.y));
    this.input.on('pointerdown', (pointer) => this._updateHoverPreview(pointer.x, pointer.y));
    this.input.on('gameout', () => this._clearHoverPreview());

    this._onScaleResize = () => this._relayoutForViewport();
    this.scale.on('resize', this._onScaleResize);

    this.events.on('shutdown', () => {
      this.sim.stop();
      this.dragCtrl && this.dragCtrl.destroy();
      if (this.saveMenu)  { this.saveMenu.close(); this.saveMenu = null; }
      if (this.nameInput) { this.nameInput.destroy(); this.nameInput = null; }
      if (this.cellLabelPicker) { this.cellLabelPicker.close(); this.cellLabelPicker = null; }
      if (this.exportPanel)     { this.exportPanel.destroy();   this.exportPanel = null; }
      this._dismissStepAdvanceBanner && this._dismissStepAdvanceBanner();
      if (this._stepNew) this._stepNew.clear();
      this._lastStepReachable = null;
      if (this._onScaleResize) this.scale.off('resize', this._onScaleResize);
    });

    this.ready = true;
  }

  update(time) {
    if (!this.ready) return;
    const t = (time % CYCLE_MS) / CYCLE_MS;
    // Subtle squash-and-stretch. Each factory has two wrap containers
    // positioned at the factory's center: one for the body, one for the
    // funnels. The funnels run in opposite phase so they react against the
    // body as it deforms. Both wraps scale around their shared center so
    // nothing drifts.
    const sq = shapeSquash(t);
    const applyPair = (entry) => {
      if (entry.bodyWrap)   { entry.bodyWrap.scaleX   = sq.body.scaleX;    entry.bodyWrap.scaleY   = sq.body.scaleY; }
      if (entry.funnelWrap) { entry.funnelWrap.scaleX = sq.funnels.scaleX; entry.funnelWrap.scaleY = sq.funnels.scaleY; }
    };
    for (const entry of this.factoryRefs.values()) applyPair(entry);
    if (this.draftPulse) applyPair(this.draftPulse);
    if (this.ghostPulse) applyPair(this.ghostPulse);
    // Border funnel triangles pulse like factory funnels; buffer label
    // boxes pulse like factory BODIES — so the triangle and its label box
    // alternate the same way a factory's body and its funnels do.
    if (this.borderFunnelWraps) {
      for (const w of this.borderFunnelWraps) {
        w.scaleX = sq.funnels.scaleX;
        w.scaleY = sq.funnels.scaleY;
      }
    }
    if (this.bufferLabelWraps) {
      for (const w of this.bufferLabelWraps) {
        w.scaleX = sq.body.scaleX;
        w.scaleY = sq.body.scaleY;
      }
    }

    // Pass raw `time` so the dash pattern is monotonic (no cycle-boundary jump).
    // Animate every factory copy on screen — placed body, draft composer,
    // ghost during drag, and blueprint-setup slot previews — even when the
    // sim isn't actively spawning shapes.
    for (const f of this.flowUpdaters) f.update(time);
    if (this.draftFlow) this.draftFlow.update(time);
    if (this.ghostFlow) this.ghostFlow.update(time);
    if (this.slotFlows) for (const f of this.slotFlows) f.update(time);

    // Smooth-lerp the drag ghost toward its target so snap-to-cell and
    // snap-between-cells transitions feel fluid instead of jumpy.
    if (this.drag) {
      const smooth = 0.35;
      this.ghostContainer.x += (this.ghostTargetX - this.ghostContainer.x) * smooth;
      this.ghostContainer.y += (this.ghostTargetY - this.ghostContainer.y) * smooth;
    }

    this.sim.update(time);
    // Motion warp — stretch along direction of motion during fast phases,
    // no warp during slow plateaus. Amplitude tuned so fast peaks read as
    // a clear "squashed oval" without distorting the shape's identity.
    const warp = motionWarp(time / CYCLE_MS);
    const warpStretch = 1 + warp * SHAPE_WARP_AMP;
    for (const shape of this.sim.shapes) {
      if (shape.dead) continue;
      const baseScale = this.sim.shapeScale(shape, time);
      const alongX = shape.dx !== 0 ? warpStretch : 1 / warpStretch;
      const alongY = shape.dy !== 0 ? warpStretch : 1 / warpStretch;
      this.shapeRenderer.update(shape, baseScale * alongX, baseScale * alongY);
    }
  }

  _restartSim() {
    if (!this.sim) return;
    this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    // Mutations may invalidate the previously-captured solution; force the
    // user to re-satisfy outputs before EXPORT lights up again.
    this._resetVictoryTracking && this._resetVictoryTracking();
    if (this._designerMode) {
      // Refresh the icon island so EXPORT dims back out after a mutation.
      this._renderIconIsland && this._renderIconIsland();
      this._setupIconSlotHandlers && this._setupIconSlotHandlers();
    }
    this.sim.start(this.level, this.time.now);
  }

  // ---------- Designer-mode plumbing (Milestone G) ----------

  // Sandbox: load the editor's localStorage level. Designer mode: load the
  // community level by id, or seed a fresh blank if none was passed (the
  // user pressed LEVEL DESIGNER from the Community scene with no draft yet).
  async _resolveInitialLevel() {
    if (!this._designerMode) return loadLevel();
    if (this._designerLevelId) {
      const existing = await getCommunityLevelById(this._designerLevelId);
      if (existing) return normalizeForEditor(existing);
    }
    const fresh = defaultLevel();
    fresh.name = 'untitled';
    fresh.number = 0;
    fresh.origin = 'local';
    fresh.status = 'private';
    return fresh;
  }

  // Single funnel for every level mutation. Sandbox writes through the legacy
  // `blockyard.level` key; designer mode writes through community.saveLocal,
  // which mints an id on first save and re-stamps `updatedAt` thereafter.
  // Editor's auto-running test sim resolves a border output → record it.
  // When every required output has been satisfied at least once, mark the
  // editor's "victory ready" — the EXPORT button in the icon island goes
  // active and the user can switch to blueprint-setup mode.
  _onEditorOutputSatisfied(funnel) {
    if (this._mode !== 'design') return;
    this._satisfiedOutputs.add(funnel.key);
    const required = (this.level && this.level.outputs) || [];
    if (required.length === 0) return;
    for (const o of required) {
      const k = `border:${o.r},${o.c},${o.side}`;
      if (!this._satisfiedOutputs.has(k)) return;
    }
    if (!this._victoryReady) {
      this._victoryReady = true;
      // Refresh the icon island so the EXPORT slot lights up, and push the
      // step indicator into its "blocks complete" state (fires the 5s
      // "tap BLUEPRINT" banner on transition).
      this._renderIconIsland();
      this._setupIconSlotHandlers();
      this._refreshSteps();
    }
  }

  // Restart the test sim and clear the satisfied-outputs tracker (any level
  // mutation may invalidate the previous solution).
  _resetVictoryTracking() {
    this._satisfiedOutputs && this._satisfiedOutputs.clear();
    this._victoryReady = false;
    this._refreshSteps();
  }

  // ---------- Blueprint-setup mode ----------

  _enterBlueprintSetup() {
    if (this._mode === 'blueprintSetup') return;
    if (!this._victoryReady) return;
    // Snapshot the solution (deep-clone factories) so we can rebuild the
    // play area on cancel and embed `solution` in the export payload.
    this._solutionSnapshot = JSON.parse(JSON.stringify(this.level.factories || []));
    this._blueprintAssignments = new Map();
    this._mode = 'blueprintSetup';
    if (this.sim) this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this._renderDrawGrid();        // becomes the slot grid in blueprint-setup
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    this._refreshSteps();
  }

  _exitBlueprintSetup() {
    if (this._mode !== 'blueprintSetup') return;
    this._dismissStepAdvanceBanner();
    if (this.exportPanel) { this.exportPanel.destroy(); this.exportPanel = null; }
    // Restore the solution snapshot so the user can keep editing the design.
    if (this._solutionSnapshot) {
      this.level.factories = JSON.parse(JSON.stringify(this._solutionSnapshot));
    }
    this._blueprintAssignments = new Map();
    this._mode = 'design';
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    this._restartSim();
    this._resetVictoryTracking();
  }

  // True when every solution factory has been assigned to a unique blueprint
  // slot (per the export rule: each slot holds at most ONE factory).
  _blueprintExportReady() {
    if (this._mode !== 'blueprintSetup') return false;
    const total = (this._solutionSnapshot || []).length;
    if (total === 0) return false;
    if (this._blueprintAssignments.size !== total) return false;
    const slots = new Set();
    for (const v of this._blueprintAssignments.values()) {
      const k = `${v.slot.r},${v.slot.c}`;
      if (slots.has(k)) return false;
      slots.add(k);
    }
    return true;
  }

  // Open ExportPanel with the assembled level (initialFactories from
  // blueprint assignments, solution from the snapshot).
  _openExportPanel() {
    if (this.exportPanel) { this.exportPanel.destroy(); this.exportPanel = null; }
    const assembled = this._assembleExportLevel();
    this.exportPanel = new ExportPanel(this, {
      level: assembled,
      onSaved: (stamped) => {
        // Capture id/status into the live level so further saves update in place.
        this.level.id = stamped.id;
        this.level.status = stamped.status;
        this.level.author = stamped.author;
        this._designerLevelId = stamped.id;
      },
      onClose: () => {
        this.exportPanel = null;
        // Recompute step states — EXPORT pill drops back to "reachable" when
        // the panel closes.
        this._refreshSteps();
      },
      // EDIT MORE — rewinds out of blueprint-setup back into design so the
      // user can tweak factories / funnels before re-exporting. The panel
      // closes itself first; we then restore the solution snapshot.
      onEditMore: () => this._exitBlueprintSetup(),
    });
    // Tapping EXPORT opens the panel → EXPORT pill becomes current, and the
    // ring (if any) clears.
    if (this._stepNew) this._stepNew.delete('export');
    this._refreshSteps();
  }

  _assembleExportLevel() {
    const initialFactories = [];
    for (const fac of this._solutionSnapshot || []) {
      const a = this._blueprintAssignments.get(fac.id);
      if (!a) continue;
      // Embed the cells/funnels in their AUTHORED orientation; rotation
      // applies on top at play time. This keeps the JSON small and makes
      // hand-edits easier.
      initialFactories.push({
        id: fac.id,
        slot: { row: a.slot.r, col: a.slot.c },
        cells: fac.cells.map((c) => ({ ...c })),
        funnels: (fac.funnels || []).map((f) => ({ ...f })),
        rotation: a.rotation || 0,
      });
    }
    // Harden the board dimensions — the share string must round-trip the
    // level size. If the source level is missing `board.cols` / `board.rows`
    // for any reason, fall through to current runtime defaults so the
    // exported JSON is always import-valid.
    const rawBoard = this.level.board || {};
    const cols = Number.isFinite(rawBoard.cols) && rawBoard.cols > 0 ? rawBoard.cols : 6;
    const rows = Number.isFinite(rawBoard.rows) && rawBoard.rows > 0 ? rawBoard.rows : 6;
    const board = { cols, rows };
    return {
      ...this.level,
      id: this.level.id || undefined,   // ExportPanel saves will mint if missing
      origin: this.level.origin || 'local',
      status: this.level.status || 'private',
      author: this.level.author || null,
      number: this.level.number || 0,
      board,
      border: this.level.border,
      inputs: this.level.inputs,
      outputs: this.level.outputs,
      // Player-friendly layout — the blueprint the player starts with.
      initialFactories,
      // Solution = the editor-verified placement (for backend mod review).
      solution: { factories: this._solutionSnapshot || [] },
      likes: this.level.likes || 0,
    };
  }

  _persist() {
    if (this._designerMode) {
      // Mint the id synchronously so back-to-back persists don't race and
      // double-register the same level into the community index.
      if (!this.level.id) {
        this.level.id = genId();
        this._designerLevelId = this.level.id;
      }
      // Fresh levels (and levels whose export was never completed) are
      // tagged `unfinished` so they show up in the Community list as
      // resumable drafts. Status only advances to private/pending/public
      // via the ExportPanel actions.
      if (!this.level.status || this.level.status === 'unfinished') {
        this.level.status = 'unfinished';
      }
      saveCommunityLocal(this.level).then((stamped) => {
        this.level.origin = stamped.origin;
        this.level.status = stamped.status;
        this.level.author = stamped.author;
        this.level.createdAt = stamped.createdAt;
        this.level.updatedAt = stamped.updatedAt;
      });
    } else {
      saveLevel(this.level);
    }
  }

  // ===================================================================
  //   Layout
  // ===================================================================

  _layoutBoardAndDrawGrid() {
    const board = this.level.board;

    // All layout is expressed relative to a 9:20 portrait "content box" that
    // is fitted to the actual device viewport and then projected into the
    // Phaser logical canvas. Everything (TitleBar + board + blueprint +
    // icon island) lives inside that column. The canvas area outside the
    // column is picked up by the existing brown checker automatically.
    const contentBox = compute920Box(this);
    this.contentBox = contentBox;
    const { boxX, boxY, boxW, boxH } = contentBox;

    // Blueprint grid count follows the actual board — +1 col and +1 row of
    // breathing room over the interior — so it can still host drafts up to
    // that size. But the blueprint's OUTER size (below) is locked to the
    // 5×5 reference, so cells shrink at larger N and grow at smaller N.
    const REF_DIM = 5;
    const drawGridRows = Math.max(1, (board.rows - 2) + 1);
    const drawGridCols = Math.max(1, (board.cols - 2) + 1);
    this.drawGridRows = drawGridRows;
    this.drawGridCols = drawGridCols;

    // Vertical stack (top-down): TitleBar slot → board → blueprint → icon
    // island → bottom margin. Small explicit gaps, no half-region centering
    // — the board hugs the title, and the blueprint hugs the board.
    const topMargin      = TOOLBAR_H;   // reserves TitleBar + its 24px cap
    const titleToBoardGap = 4;
    const boardToBpGap   = 6;
    const bottomMargin   = 16;
    const availW = boxW - 40;

    // Total chrome within the blueprint+island column:
    //   blueprint padding + gap + island padding = 4*PAD + gap
    // Total cell-rows consumed vertically: drawGridRows (blueprint) + 1 (island).
    const chrome = BLUEPRINT_PAD * 4 + ISLAND_TO_GRID_GAP;

    // Two cell sizes:
    //   refPxCell — sized against a 5×5 reference board in the current 9:20
    //     box. Drives title bar width, blueprint width/height, island width,
    //     and the blueprint's own cell size (this.drawCellPx). These all
    //     stay identical for a given viewport regardless of the actual N.
    //   cellPx    — the rendered cell size on the board, derived so the
    //     board's outer width equals the refBoardW (the width 5×5 would
    //     occupy). This way the board outline is also fixed-width; only the
    //     cell *count* changes with N. A vertical fitCap keeps the stack
    //     inside the box at large N, trading a few px of board width for
    //     visibility.
    const stackFixed =
      topMargin + titleToBoardGap + boardToBpGap + bottomMargin + chrome;

    const fitPxCell = (boardDim, drawGridColsN, drawGridRowsN) => {
      const interior = Math.max(1, boardDim - 2);
      const wCellFactor = interior + 2 * SHAPE_SCALE;
      const wGapFactor  = Math.max(0, interior - 1);
      const cellW_board     = (availW - BOARD_GAP * wGapFactor) / wCellFactor;
      const cellW_blueprint = (availW - BLUEPRINT_PAD * 2) / drawGridColsN;
      const stackCellFactor = boardDim + (drawGridRowsN + 1);
      const stackGapFactor  = Math.max(0, boardDim - 1);
      const cellH_stack = (boxH - stackFixed - BOARD_GAP * stackGapFactor) / stackCellFactor;
      return Math.min(cellW_board, cellW_blueprint, cellH_stack);
    };

    const refDrawGridCols = (REF_DIM - 2) + 1;                // 4
    const refDrawGridRows = (REF_DIM - 2) + 1;                // 4
    const refPxCell  = Math.max(24, Math.floor(fitPxCell(REF_DIM, refDrawGridCols, refDrawGridRows)));
    const refBoardW  = REF_DIM * refPxCell + (REF_DIM - 1) * BOARD_GAP;
    const neededPx   = (refBoardW - (board.cols - 1) * BOARD_GAP) / board.cols;

    const cellPx = Math.max(24, Math.floor(neededPx));
    this.pxCell = cellPx;

    // Fixed (ref-based) outer dims — title, blueprint, island, island
    // height. The entire vertical stack therefore has a fixed height, so
    // the icon island stays anchored to the bottom of the box regardless
    // of N.
    const refInteriorCols = REF_DIM - 2;
    const refWidthGap     = Math.max(0, refInteriorCols - 1);
    const refLabelBoxW    = SHAPE_SCALE * refPxCell;
    const titleBarW = refInteriorCols * refPxCell + refWidthGap * BOARD_GAP + 2 * refLabelBoxW;
    const bpW       = refDrawGridCols * refPxCell;   // fixed
    const bpH       = refDrawGridRows * refPxCell;   // fixed
    const islandW   = bpW;                            // fixed
    this.islandH    = refPxCell;                      // fixed

    // Blueprint cell size shrinks/grows with the actual drawGridCols so
    // cells × count keeps the outer at bpW. Used for hit-testing, cell
    // rendering, and dotted-grid layout — everything inside the blueprint.
    this.drawCellPx = Math.min(bpW / drawGridCols, bpH / drawGridRows);

    // Board uses actual N and the possibly-shrunken cellPx (fitCap kicks in
    // at large N).
    const boardW = board.cols * cellPx + (board.cols - 1) * BOARD_GAP;
    const boardH = board.rows * cellPx + (board.rows - 1) * BOARD_GAP;

    this.boardW = boardW;
    this.titleBarW = Math.round(titleBarW);
    this.islandSlotW = bpW / ICON_SLOTS;
    this.boardOriginX = boxX + Math.round((boxW - boardW) / 2);
    this.boardOriginY = boxY + topMargin + titleToBoardGap;

    const blueprintTopY = this.boardOriginY + boardH + boardToBpGap;

    this.drawGridOriginX = boxX + Math.round((boxW - bpW) / 2);
    this.drawGridOriginY = Math.round(blueprintTopY + BLUEPRINT_PAD);

    this.iconIslandOriginX = boxX + Math.round((boxW - islandW) / 2);
    this.iconIslandOriginY = Math.round(
      this.drawGridOriginY + bpH + BLUEPRINT_PAD + ISLAND_TO_GRID_GAP + BLUEPRINT_PAD,
    );

    this.boardContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.interactiveContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.flowContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.shapeContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.funnelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.exteriorContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.shadowContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.borderFunnelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.frameContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.labelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.bufferMarkerContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.errorContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.placementContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.drawGridContainer.setPosition(this.drawGridOriginX, this.drawGridOriginY);
    this.iconIslandContainer.setPosition(this.iconIslandOriginX, this.iconIslandOriginY);
    this.hoverContainer.setPosition(this.drawGridOriginX, this.drawGridOriginY);
    this.boardHoverContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.ghostContainer.setPosition(0, 0); // moves per-frame in screen coords
  }

  // ===================================================================
  //   Render
  // ===================================================================

  _renderAll() {
    this._clearBoardDynamic();
    // Black outline around the playable interior (read as "puzzle area").
    // Pass 1 (back): peach floor on the interior only.
    renderInteriorFloor(this, this.boardContainer, {
      board: this.level.board, pxCell: this.pxCell,
    });
    // Buffer funnels (triangles only). Each funnel gets its own pulseWrap
    // centered on the cell so they breathe with the factory funnels. They
    // live in `borderFunnelContainer` (between shadow and frame outline)
    // so they read on top of the inner shadow but under the frame.
    const border = renderBorder(this, this.boardContainer, this.borderFunnelContainer, this.level, { pxCell: this.pxCell, pxGap: BOARD_GAP });
    this.borderFunnelWraps = border.wraps;
    for (const factory of this.level.factories) {
      const entry = this._drawFactory(factory);
      this.factoryRefs.set(factory.id, entry);
    }
    // Pass 2: brown checker covering buffer + beyond-the-board. Interior is
    // NOT filled — the hole lets the peach floor + sim visuals show through.
    renderExteriorCheckers(this, this.exteriorContainer, {
      board: this.level.board, pxCell: this.pxCell,
      boardOriginX: this.boardOriginX, boardOriginY: this.boardOriginY,
    });
    // Pass 3a: inner shadow into shadowContainer (below border funnels).
    renderFrameShadow(this, this.shadowContainer, { board: this.level.board, pxCell: this.pxCell });
    // Pass 3b: frame outline on top of everything board-side.
    renderFrameOutline(this, this.frameContainer, { board: this.level.board, pxCell: this.pxCell });
    // Buffer-funnel labels in their own high-depth container.
    this._renderBorderFunnelLabels();
  }

  // Label each buffer funnel with a form+color icon showing the typed shape
  // it accepts (inputs) / expects (outputs). Lives in frameContainer so the
  // labels read on top of the brown cut-out.
  _renderBorderFunnelLabels() {
    this.bufferLabelWraps = renderBufferLabels(this, this.labelContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
  }

  _drawFactory(factory) {
    // Spread the cell so per-cell `label` survives the absolute-coord remap.
    const absCells = factory.cells.map((cc) => ({ ...cc, r: factory.anchor.row + cc.r, c: factory.anchor.col + cc.c }));
    const absFunnels = (factory.funnels || []).map((f) => ({ ...f, r: factory.anchor.row + f.r, c: factory.anchor.col + f.c }));
    // Validate against the per-cell label rules; invalid factories paint a
    // red border + a short error label so the author can spot the issue at
    // a glance. Validation runs on the LOCAL (un-offset) cell/funnel set so
    // `cell.label` and `funnel.r/c` indices match up.
    const validity = validateFactory({ cells: factory.cells, funnels: factory.funnels || [] });
    // Two pulseWrap containers at the factory's center. The body lives in
    // interactiveContainer (behind shapes); the funnels live in funnelContainer
    // (in front of shapes) so shapes visibly slide under the triangles as
    // they enter. Each wrap scales independently → opposite-phase pulse.
    const [cx, cy] = this._factoryCenter(absCells, this.pxCell, BOARD_GAP);
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
      locked: !!factory.locked, invalid: !validity.valid,
    });
    body.setPosition(-cx, -cy);
    // Flow doesn't pulse — it lives in a separate container without a wrap.
    const flow = renderFlow(this, this.flowContainer, {
      cells: absCells, funnels: absFunnels, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.flowUpdaters.push(flow);
    if (!validity.valid) this._paintFactoryError(absCells, validity.error);
    return { bodyWrap, funnelWrap, body, funnels, absCells };
  }

  // Hovering red label placed just above the factory's top-left cell. The
  // error container is cleared + rebuilt each render pass so updates track
  // mutations immediately.
  _paintFactoryError(absCells, message) {
    if (!absCells || absCells.length === 0 || !message) return;
    let minR = Infinity, anchorC = 0;
    for (const cc of absCells) {
      if (cc.r < minR) { minR = cc.r; anchorC = cc.c; }
      else if (cc.r === minR && cc.c < anchorC) anchorC = cc.c;
    }
    const step = this.pxCell + BOARD_GAP;
    const x = anchorC * step + this.pxCell / 2;
    const y = minR * step - 4;
    const text = this.add.text(x, y, `\u26A0 ${message}`, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: '#ffffff', backgroundColor: '#d02020', padding: { x: 6, y: 2 },
    }).setOrigin(0.5, 1);
    this.errorContainer.add(text);
  }

  _factoryCenter(cells, pxCell, pxGap) {
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
    this.errorContainer.removeAll(true);
  }

  // ===================================================================
  //   Draw grid (factory-draft composer)
  // ===================================================================

  _renderDrawGrid() {
    // Drop references to flow updaters whose gfx is about to be destroyed
    // by the container removeAll — the new draft / slotted-factory render
    // re-creates them.
    this.draftFlow = null;
    if (this.slotFlows) this.slotFlows.length = 0;
    this.drawGridContainer.removeAll(true);

    // Blueprint = just the grid. Sized to match the playable interior so the
    // author space mirrors the play space. Icons live in a separate island
    // below (see _renderIconIsland). All coords are relative to
    // drawGridContainer (grid top-left = 0,0).
    const step = this.drawCellPx;
    const rows = this.drawGridRows;
    const cols = this.drawGridCols;
    const dgW = cols * step;
    const dgH = rows * step;
    const fx = -BLUEPRINT_PAD;
    const fy = -BLUEPRINT_PAD;
    const fw = dgW + BLUEPRINT_PAD * 2;
    const fh = dgH + BLUEPRINT_PAD * 2;
    const frame = this.make.graphics({ add: false });
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(fx, fy, fw, fh, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(fx, fy, fw, fh, BLUEPRINT_RADIUS);
    this.drawGridContainer.add(frame);

    // White dotted grid on the editable cells.
    const dots = this.make.graphics({ add: false });
    dots.fillStyle(BLUEPRINT_DOT, 0.9);
    const DOT_SPACING = 6;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        if (c < cols) stampEdge(dots, c * step, r * step, (c + 1) * step, r * step, DOT_SPACING);
        if (r < rows) stampEdge(dots, c * step, r * step, c * step, (r + 1) * step, DOT_SPACING);
      }
    }
    this.drawGridContainer.add(dots);

    if (this._mode === 'blueprintSetup') {
      this._renderSlottedFactories();
    } else {
      this._renderDraftShape();
    }
  }

  // Blueprint-setup mode: render every factory currently assigned to a
  // blueprint slot at its slot position with the chosen rotation. Each slot
  // accepts at most one factory (see _blueprintExportReady).
  _renderSlottedFactories() {
    const step = this.drawCellPx;
    if (!this.slotFlows) this.slotFlows = [];
    for (const [factoryId, assignment] of this._blueprintAssignments) {
      const fac = (this._solutionSnapshot || []).find((f) => f.id === factoryId);
      if (!fac) continue;
      // Skip the factory currently being dragged — the ghost takes over.
      if (this.drag && this.drag.factoryId === factoryId) continue;
      const rot = rotateFactoryShape({ cells: fac.cells, funnels: fac.funnels || [] }, assignment.rotation || 0);
      const ox = assignment.slot.c * step;
      const oy = assignment.slot.r * step;
      const cellsLocal = rot.cells.map((c) => ({ ...c }));
      // Cells in cellsLocal are normalized to start at (0,0); shift to slot.
      const cellsAtSlot = cellsLocal.map((c) => ({ ...c, r: c.r + assignment.slot.r, c: c.c + assignment.slot.c }));
      const funnelsLocal = rot.funnels.map((f) => ({ ...f }));
      const funnelsAtSlot = funnelsLocal.map((f) => ({ ...f, r: f.r + assignment.slot.r, c: f.c + assignment.slot.c }));
      const [cx, cy] = this._factoryCenter(cellsLocal, step, 0);
      const funnelWrap = this.add.container(ox + cx, oy + cy);
      const bodyWrap   = this.add.container(ox + cx, oy + cy);
      this.drawGridContainer.add(funnelWrap);
      this.drawGridContainer.add(bodyWrap);
      const funnels = renderFunnels(this, funnelWrap, funnelsLocal, { pxCell: step, pxGap: 0, scale: SHAPE_SCALE });
      funnels.setPosition(-cx, -cy);
      const body = renderFactoryBody(this, bodyWrap, {
        cells: cellsLocal, pxCell: step, pxGap: 0, scale: SHAPE_SCALE,
      });
      body.setPosition(-cx, -cy);
      // Animated dashes for the slotted factory — same look as a placed body.
      const flow = renderFlow(this, this.drawGridContainer, {
        cells: cellsAtSlot, funnels: funnelsAtSlot,
        pxCell: step, pxGap: 0, scale: SHAPE_SCALE,
      });
      this.slotFlows.push(flow);
    }
  }

  // Standalone icon island beneath the blueprint, full blueprint width.
  // ICON_SLOTS evenly divide that width; slot width (islandSlotW) may be
  // wider or narrower than a cell depending on blueprint size. The island
  // height stays one cell tall. Coords are relative to iconIslandContainer
  // (top-left = 0,0).
  _renderIconIsland() {
    this.iconIslandContainer.removeAll(true);
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
      slotsGfx.lineStyle(1, BLUEPRINT_STROKE, 0.5);
      slotsGfx.fillStyle(BLUEPRINT_BG, 1);
      slotsGfx.fillRoundedRect(s * slotW + slotPad, slotPad, slotW - slotPad * 2, islandH - slotPad * 2, 8);
    }
    this.iconIslandContainer.add(slotsGfx);

    // Icon glyph size based on the tighter of slotW / islandH so icons stay
    // readable when slots are very wide (big boards) or very narrow (small).
    const iconSize = Math.round(Math.min(slotW, islandH) * 0.6);
    const cy = islandH / 2;
    const addGlyph = (slot, drawFn) => {
      const g = this.make.graphics({ add: false });
      drawFn(g, slot * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
      this.iconIslandContainer.add(g);
    };
    addGlyph(SLOT_BACK,   drawBackChevron);
    addGlyph(SLOT_CLEAR,  drawTrash);
    addGlyph(SLOT_SHRINK, drawMinus);
    addGlyph(SLOT_GROW,   drawPlus);
    // EXPORT (replaces HINT in BOTH sandbox and designer mode). Lights up
    // when the test sim has satisfied every output (design mode) or every
    // solution factory is in a unique blueprint slot (setup mode).
    const exportEnabled = this._mode === 'blueprintSetup'
      ? this._blueprintExportReady()
      : !!this._victoryReady;
    const color = exportEnabled ? '#ffffff' : '#9aa6b2';
    const label = this.add.text(
      this.iconIslandOriginX + SLOT_HINT * slotW + slotW / 2,
      this.iconIslandOriginY + cy,
      'EXPORT',
      { fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold', color },
    ).setOrigin(0.5);
    this.iconIslandContainer.add(label);
  }

  _renderDraftShape() {
    // The previous draft flow's gfx was destroyed by drawGridContainer's
    // removeAll(true) — drop the stale reference before allocating a new one.
    this.draftFlow = null;
    this.draftPulse = null;
    if (this.draftCells.length === 0) return;
    // If a drag is in progress the draft is visually "picked up" — the ghost
    // takes over; nothing to render here.
    if (this.drag) return;

    // Two pulseWraps at draft's center (draw-grid-local coords), same split
    // as a placed factory so the opposite-phase pulse works here too.
    const [cx, cy] = this._factoryCenter(this.draftCells, this.drawCellPx, 0);
    const funnelWrap = this.add.container(cx, cy);
    const bodyWrap   = this.add.container(cx, cy);
    this.drawGridContainer.add(funnelWrap);
    this.drawGridContainer.add(bodyWrap);
    const funnels = renderFunnels(this, funnelWrap, this.draftFunnels, { pxCell: this.drawCellPx, pxGap: 0, scale: SHAPE_SCALE });
    funnels.setPosition(-cx, -cy);
    const validity = validateFactory({ cells: this.draftCells, funnels: this.draftFunnels });
    const body    = renderFactoryBody(this, bodyWrap, {
      cells: this.draftCells, pxCell: this.drawCellPx, pxGap: 0, scale: SHAPE_SCALE,
      invalid: !validity.valid,
    });
    body.setPosition(-cx, -cy);
    this.draftPulse = { bodyWrap, funnelWrap };
    // Flow doesn't pulse — add directly to the outer drawGridContainer. Track
    // the updater so the scene's update() loop can animate the dashes.
    this.draftFlow = renderFlow(this, this.drawGridContainer, {
      cells: this.draftCells, funnels: this.draftFunnels,
      pxCell: this.drawCellPx, pxGap: 0, scale: SHAPE_SCALE,
    });
    if (!validity.valid) {
      // Small inline error text above the draft in draw-grid coords. The
      // drawGridContainer will tear this down on the next render pass.
      let minR = Infinity, anchorC = 0;
      for (const cc of this.draftCells) {
        if (cc.r < minR) { minR = cc.r; anchorC = cc.c; }
        else if (cc.r === minR && cc.c < anchorC) anchorC = cc.c;
      }
      const step = this.drawCellPx;
      const x = anchorC * step + step / 2;
      const y = minR * step - 4;
      const text = this.add.text(x, y, `\u26A0 ${validity.error}`, {
        fontFamily: 'system-ui, sans-serif', fontSize: '10px', fontStyle: 'bold',
        color: '#ffffff', backgroundColor: '#d02020', padding: { x: 5, y: 2 },
      }).setOrigin(0.5, 1);
      this.drawGridContainer.add(text);
    }
  }

  // ===================================================================
  //   Hit-testing — unified via { kind: 'draft' | 'board' }
  // ===================================================================

  _cellAt(px, py) {
    const draft = this._drawGridCellAt(px, py);
    if (draft) return { ...draft, kind: 'draft' };
    const board = this._boardCellAt(px, py);
    if (board) return { ...board, kind: 'board' };
    return null;
  }

  _edgeAt(px, py) {
    const border = this._borderEdgeAt(px, py);
    if (border) return { ...border, kind: 'border' };
    // The buffer-label square next to each existing border funnel also acts
    // as a click target — easier to hit than the narrow edge strip. Only
    // triggers for already-placed funnels (empty buffer edges have no label).
    const bufferLabel = this._bufferLabelAt(px, py);
    if (bufferLabel) return { ...bufferLabel, kind: 'border' };
    const draft = this._draftEdgeAt(px, py);
    if (draft) return { ...draft, kind: 'draft' };
    return null;
  }

  // Returns the border funnel whose buffer-label box contains (px, py), or
  // null. The label box sits OUTSIDE the interior frame — on the buffer
  // side — so it doesn't overlap the normal edge-strip hitbox.
  _bufferLabelAt(px, py) {
    const funnels = (this.level && this.level.border && this.level.border.funnels) || [];
    if (funnels.length === 0) return null;
    const lx = px - this.boardOriginX;
    const ly = py - this.boardOriginY;
    for (const f of funnels) {
      const box = computeBufferLabelBox(this.level, f, this.pxCell, BOARD_GAP);
      const half = box.size / 2;
      if (lx >= box.x - half && lx <= box.x + half &&
          ly >= box.y - half && ly <= box.y + half) {
        return { r: f.r, c: f.c, side: f.side };
      }
    }
    return null;
  }

  _boardCellAt(px, py) {
    const lx = px - this.boardOriginX;
    const ly = py - this.boardOriginY;
    const step = this.pxCell + BOARD_GAP;
    const c = Math.floor(lx / step);
    const r = Math.floor(ly / step);
    if (r < 0 || c < 0 || r >= this.level.board.rows || c >= this.level.board.cols) return null;
    const localX = lx - c * step;
    const localY = ly - r * step;
    if (localX > this.pxCell || localY > this.pxCell) return null;
    return { r, c };
  }

  _borderEdgeAt(px, py) {
    const cell = this._boardCellAt(px, py);
    if (!cell) return null;
    if (!isBorderCell(this.level.board, cell.r, cell.c)) return null;
    const side = innerSideOf(this.level.board, cell.r, cell.c);
    if (!side) return null;
    const lx = px - this.boardOriginX - cell.c * (this.pxCell + BOARD_GAP);
    const ly = py - this.boardOriginY - cell.r * (this.pxCell + BOARD_GAP);
    // Funnel-edge hitbox = up to ~half the cell. Larger than the original
    // 14px so taps near the buffer cell read as funnel-place instead of
    // sliding off; capped so opposite edges don't overlap on tiny cells.
    const T = Math.min(Math.floor(this.pxCell / 2), 24);
    if (side === 'top'    && ly > T) return null;
    if (side === 'bottom' && ly < this.pxCell - T) return null;
    if (side === 'left'   && lx > T) return null;
    if (side === 'right'  && lx < this.pxCell - T) return null;
    return { r: cell.r, c: cell.c, side };
  }

  _drawGridCellAt(px, py) {
    const lx = px - this.drawGridOriginX;
    const ly = py - this.drawGridOriginY;
    const c = Math.floor(lx / this.drawCellPx);
    const r = Math.floor(ly / this.drawCellPx);
    if (r < 0 || c < 0 || r >= this.drawGridRows || c >= this.drawGridCols) return null;
    return { r, c };
  }

  _draftEdgeAt(px, py) {
    if (this.draftCells.length === 0) return null;
    const cell = this._drawGridCellAt(px, py);
    if (!cell) return null;
    const lx = px - this.drawGridOriginX - cell.c * this.drawCellPx;
    const ly = py - this.drawGridOriginY - cell.r * this.drawCellPx;
    const T = Math.min(Math.floor(this.drawCellPx / 2), 18);
    // Only perimeter edges of cells that are ON the draft factory.
    for (const side of ['top', 'bottom', 'left', 'right']) {
      if (!isPerimeterEdge(this.draftCells, cell.r, cell.c, side)) continue;
      if (side === 'top'    && ly <= T) return { r: cell.r, c: cell.c, side };
      if (side === 'bottom' && ly >= this.drawCellPx - T) return { r: cell.r, c: cell.c, side };
      if (side === 'left'   && lx <= T) return { r: cell.r, c: cell.c, side };
      if (side === 'right'  && lx >= this.drawCellPx - T) return { r: cell.r, c: cell.c, side };
    }
    return null;
  }

  _isDraftCell(r, c) {
    return this.draftCells.some((x) => x.r === r && x.c === c);
  }

  // Factory at an absolute board cell, or null if that cell is empty / border.
  _factoryAtBoardCell(r, c) {
    for (const fac of this.level.factories) {
      const rel = fac.cells.find((cc) => fac.anchor.row + cc.r === r && fac.anchor.col + cc.c === c);
      if (rel) return fac;
    }
    return null;
  }

  // ===================================================================
  //   Gesture handlers
  // ===================================================================

  _onToggleCell(info) {
    if (!info) return;
    if (this._mode === 'blueprintSetup') {
      // Setup-mode taps: slot tap rotates the factory assigned there;
      // board tap is a no-op (use drag to move into a slot).
      if (info.kind === 'draft') {
        const a = this._findAssignmentAt(info.r, info.c);
        if (a) this._rotateSlotted(a.factoryId);
      }
      return;
    }
    if (info.kind === 'draft') {
      this._toggleDraftCell(info.r, info.c);
    } else if (info.kind === 'board') {
      // Tap on a placed factory's cell → open the per-cell label picker.
      // To remove a factory, drag it back into the draft composer.
      const hit = this.level.factories.find((fac) =>
        fac.cells.some((cc) => fac.anchor.row + cc.r === info.r && fac.anchor.col + cc.c === info.c),
      );
      if (hit) this._openCellLabelPicker(hit, info.r, info.c);
    }
  }

  // Find the assignment whose rotated footprint covers the given slot, not
  // just the anchor. A multi-cell factory in the blueprint spans multiple
  // slots — tapping or dragging on any of them should resolve to the same
  // factory. Returns `{ factoryId, slot, rotation, localCell }` where
  // `localCell` is the cell-within-factory (post-rotation) that was hit —
  // used by drag-start to compute the grab offset.
  _findAssignmentAt(slotR, slotC) {
    // Prefer an exact anchor match first so a factory whose (0,0) cell sits
    // on the slot wins over a neighboring factory whose tail happens to
    // overlap here.
    let anchorHit = null;
    let footprintHit = null;
    for (const [factoryId, a] of this._blueprintAssignments) {
      const fac = (this._solutionSnapshot || []).find((f) => f.id === factoryId);
      if (!fac) continue;
      const rot = rotateFactoryShape({ cells: fac.cells, funnels: fac.funnels || [] }, a.rotation || 0);
      for (const cc of rot.cells) {
        if (a.slot.r + cc.r === slotR && a.slot.c + cc.c === slotC) {
          const hit = { factoryId, slot: { ...a.slot }, rotation: a.rotation || 0, localCell: { r: cc.r, c: cc.c } };
          if (cc.r === 0 && cc.c === 0) anchorHit = hit;
          else if (!footprintHit) footprintHit = hit;
        }
      }
    }
    return anchorHit || footprintHit;
  }

  _rotateSlotted(factoryId) {
    const a = this._blueprintAssignments.get(factoryId);
    if (!a) return;
    const nextRotation = ((a.rotation || 0) + 1) % 4;
    // Reject rotations that would knock the factory out of bounds or into
    // another assignment. Tap is a no-op in that case (user can drag to a
    // roomier slot first, then rotate).
    if (!this._assignmentFits(factoryId, a.slot, nextRotation)) return;
    a.rotation = nextRotation;
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
  }

  // Per-cell label editor. Single-cell factory: setting a label means
  // "wildcard input, labeled output". Multi-cell: each labeled cell binds
  // its funnels to that label.
  _openCellLabelPicker(factory, absR, absC) {
    if (this.cellLabelPicker) { this.cellLabelPicker.close(); this.cellLabelPicker = null; }
    const localR = absR - factory.anchor.row;
    const localC = absC - factory.anchor.col;
    const cell = factory.cells.find((cc) => cc.r === localR && cc.c === localC);
    if (!cell) return;
    const step = this.pxCell + BOARD_GAP;
    const cellCx = this.boardOriginX + absC * step + this.pxCell / 2;
    const cellCy = this.boardOriginY + absR * step + this.pxCell / 2;
    this.cellLabelPicker = new CellLabelPicker(this, {
      x: cellCx,
      y: cellCy,
      label: cell.label || null,
      onChange: (label) => {
        cell.label = { ...label };
        this._persist();
        this._renderAll();
        this._restartSim();
      },
      onClear: () => {
        delete cell.label;
        this._persist();
        this._renderAll();
        this._restartSim();
      },
      onClose: () => { this.cellLabelPicker = null; },
    });
  }

  _onToggleFunnel(info) {
    if (!info) return;
    if (info.kind === 'border') this._cycleBorderFunnel(info.r, info.c, info.side);
    else if (info.kind === 'draft') this._cycleDraftFunnel(info.r, info.c, info.side);
  }

  _toggleDraftCell(r, c) {
    const has = this._isDraftCell(r, c);
    if (!has) {
      if (!isAdjacentToFactory(this.draftCells, r, c)) return;
      this.draftCells.push({ r, c });
      this._renderDrawGrid();
      return;
    }
    // Existing draft cell: open the label picker so the author can set /
    // clear the cell's label, or REMOVE CELL to drop it from the draft.
    this._openDraftCellLabelPicker(r, c);
  }

  _removeDraftCellAt(r, c) {
    const candidate = this.draftCells.filter((x) => !(x.r === r && x.c === c));
    if (!isContiguous(candidate)) return;
    this.draftCells = candidate;
    // Prune funnels on removed cells and on edges that are now internal.
    this.draftFunnels = this.draftFunnels.filter((f) => {
      if (f.r === r && f.c === c) return false;
      return isPerimeterEdge(this.draftCells, f.r, f.c, f.side);
    });
    this._renderDrawGrid();
  }

  _openDraftCellLabelPicker(r, c) {
    if (this.cellLabelPicker) { this.cellLabelPicker.close(); this.cellLabelPicker = null; }
    const cell = this.draftCells.find((cc) => cc.r === r && cc.c === c);
    if (!cell) return;
    const step = this.drawCellPx;
    const cellCx = this.drawGridOriginX + c * step + step / 2;
    const cellCy = this.drawGridOriginY + r * step + step / 2;
    this.cellLabelPicker = new CellLabelPicker(this, {
      x: cellCx, y: cellCy,
      label: cell.label || null,
      onChange: (label) => {
        cell.label = { ...label };
        this._renderDrawGrid();
      },
      onClear: () => {
        delete cell.label;
        this._renderDrawGrid();
      },
      onRemove: () => this._removeDraftCellAt(r, c),
      onClose: () => { this.cellLabelPicker = null; },
    });
  }

  _cycleDraftFunnel(r, c, side) {
    const idx = this.draftFunnels.findIndex((f) => f.r === r && f.c === c && f.side === side);
    if (idx < 0) this.draftFunnels.push({ r, c, side, role: 'input' });
    else if (this.draftFunnels[idx].role !== 'output') this.draftFunnels[idx].role = 'output';
    else this.draftFunnels.splice(idx, 1);
    this._renderDrawGrid();
  }

  _cycleBorderFunnel(r, c, side) {
    if (!this.level.border) this.level.border = { funnels: [] };
    const arr = this.level.border.funnels;
    const idx = arr.findIndex((f) => f.r === r && f.c === c && f.side === side);
    if (idx < 0) {
      // Fresh funnel: create as input with the default shape type. Subsequent
      // taps on the label open the FunnelTypePicker (handled below).
      arr.push({ r, c, side, role: 'input' });
      this._upsertTypedEntry('input', r, c, side, { ...DEFAULT_SHAPE_TYPE });
      this._persist();
      this._renderAll();
      this._restartSim();
      return;
    }
    this._openFunnelPicker(arr[idx]);
  }

  // Open the FunnelTypePicker over a buffer funnel. Closes any existing one
  // first; commits live so each pick re-renders + restarts the sim.
  _openFunnelPicker(funnel) {
    if (this.funnelPicker) { this.funnelPicker.close(); this.funnelPicker = null; }
    // If this funnel has no typed entry yet (legacy save, or a funnel that
    // pre-dates the picker), persist the default now. Otherwise the picker
    // would *display* circle/blue while the sim treats the funnel as a
    // wildcard — opening + dismissing without clicking would silently leave
    // it untyped and any shape would pass through.
    let type = this._lookupBorderType(funnel);
    if (!type) {
      type = { ...DEFAULT_SHAPE_TYPE };
      this._upsertTypedEntry(funnel.role, funnel.r, funnel.c, funnel.side, type);
      this._persist();
      this._restartSim();
    }
    const step = this.pxCell + BOARD_GAP;
    const cellCx = this.boardOriginX + funnel.c * step + this.pxCell / 2;
    const cellCy = this.boardOriginY + funnel.r * step + this.pxCell / 2;
    this.funnelPicker = new FunnelTypePicker(this, {
      x: cellCx,
      y: cellCy,
      type,
      role: funnel.role,
      onChange: (patch) => {
        if (patch.role && patch.role !== funnel.role) {
          funnel.role = patch.role;
          // Move the typed entry between inputs[] and outputs[] to match.
          this._removeTypedEntry(funnel.r, funnel.c, funnel.side);
          this._upsertTypedEntry(funnel.role, funnel.r, funnel.c, funnel.side, type);
        }
        if (patch.type) {
          Object.assign(type, patch.type);
          this._upsertTypedEntry(funnel.role, funnel.r, funnel.c, funnel.side, type);
        }
        this._persist();
        this._renderAll();
        this._restartSim();
      },
      onDelete: () => {
        const arr = this.level.border.funnels;
        const idx = arr.findIndex((f) => f.r === funnel.r && f.c === funnel.c && f.side === funnel.side);
        if (idx >= 0) arr.splice(idx, 1);
        this._removeTypedEntry(funnel.r, funnel.c, funnel.side);
        this._persist();
        this._renderAll();
        this._restartSim();
      },
      onClose: () => { this.funnelPicker = null; },
    });
  }

  _lookupBorderType(f) {
    const bucket = f.role === 'output' ? this.level.outputs : this.level.inputs;
    if (!Array.isArray(bucket)) return null;
    const hit = bucket.find((e) => e.r === f.r && e.c === f.c && e.side === f.side);
    return hit ? { ...hit.type } : null;
  }

  _upsertTypedEntry(role, r, c, side, type) {
    const key = role === 'output' ? 'outputs' : 'inputs';
    if (!Array.isArray(this.level[key])) this.level[key] = [];
    const bucket = this.level[key];
    const idx = bucket.findIndex((e) => e.r === r && e.c === c && e.side === side);
    const entry = { r, c, side, type: { ...type } };
    if (idx < 0) bucket.push(entry);
    else bucket[idx] = entry;
  }

  _removeTypedEntry(r, c, side) {
    for (const key of ['inputs', 'outputs']) {
      if (!Array.isArray(this.level[key])) continue;
      this.level[key] = this.level[key].filter((e) => !(e.r === r && e.c === c && e.side === side));
    }
  }

  _removeFactory(id) {
    this.level.factories = this.level.factories.filter((fac) => fac.id !== id);
    this._persist();
    this._renderAll();
    this._restartSim();
  }

  // ===================================================================
  //   Drag-to-place
  // ===================================================================

  _onDragStart({ grabR, grabC, kind }) {
    // Resolve the factory + grab offset based on where the drag started.
    //   • draft: snapshot the draft (normalized), grab is within it.
    //   • board: find the factory under the grabbed cell, stash it so the
    //     drag can be canceled, and use the factory's (already-normalized)
    //     shape.
    //   • blueprint-setup mode special-case: a 'draft' grab on a slot picks
    //     up the assigned factory; a 'board' grab moves the placed factory.
    let source, shape, grab, origFactory = null;
    let factoryId = null, assignmentRotation = 0, originAssignment = null;
    if (this._mode === 'blueprintSetup' && kind === 'draft') {
      const a = this._findAssignmentAt(grabR, grabC);
      if (!a) return;
      const fac = (this._solutionSnapshot || []).find((f) => f.id === a.factoryId);
      if (!fac) return;
      source = 'slot';
      factoryId = fac.id;
      assignmentRotation = a.rotation || 0;
      originAssignment = { slot: { ...a.slot }, rotation: a.rotation || 0 };
      this._blueprintAssignments.delete(fac.id);     // pop while in hand
      const rot = rotateFactoryShape({ cells: fac.cells, funnels: fac.funnels || [] }, assignmentRotation);
      // Grab at the cell the user actually tapped so the ghost tracks under
      // the pointer for multi-cell factories (any cell = move handle).
      grab = { r: a.localCell.r, c: a.localCell.c };
      shape = { cells: rot.cells, funnels: rot.funnels };
      this._renderDrawGrid();
      // Picking up from a slot always breaks completeness — drop the
      // BLUEPRINT READY banner until everything is re-slotted.
      this._refreshSteps();
    } else if (kind === 'draft') {
      source = 'draft';
      let minR = Infinity, minC = Infinity;
      for (const x of this.draftCells) {
        if (x.r < minR) minR = x.r;
        if (x.c < minC) minC = x.c;
      }
      grab  = { r: grabR - minR, c: grabC - minC };
      shape = normalizeFactory(this.draftCells, this.draftFunnels);
    } else if (kind === 'board') {
      const factory = this._factoryAtBoardCell(grabR, grabC);
      if (!factory) return;
      source = 'board';
      origFactory = factory;
      grab  = { r: grabR - factory.anchor.row, c: grabC - factory.anchor.col };
      shape = { cells: factory.cells, funnels: factory.funnels || [], converter: factory.converter };
      // Remove from the level so placement validity and rendering reflect
      // that the factory is "in hand". Sim restarts so it stops emitting
      // from this factory's funnels. Restored on drag cancel.
      this.level.factories = this.level.factories.filter((fac) => fac.id !== factory.id);
      this._renderAll();
      this._restartSim();
    } else {
      return;
    }

    // Build a ghost: body + funnels + animated flow at board scale (drop
    // preview look). Flow tracked separately so the scene update loop can
    // tick its dashes — without that the ghost would look "dead" mid-drag.
    this.ghostContainer.removeAll(true);
    this.ghostFlow = null;
    const [cx, cy] = this._factoryCenter(shape.cells, this.pxCell, BOARD_GAP);
    const funnelWrap = this.add.container(cx, cy);
    const bodyWrap   = this.add.container(cx, cy);
    this.ghostContainer.add(funnelWrap);
    this.ghostContainer.add(bodyWrap);
    const funnels = renderFunnels(this, funnelWrap, shape.funnels, { pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
    funnels.setPosition(-cx, -cy);
    const body    = renderFactoryBody(this, bodyWrap, { cells: shape.cells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
    body.setPosition(-cx, -cy);
    this.ghostFlow = renderFlow(this, this.ghostContainer, {
      cells: shape.cells, funnels: shape.funnels,
      pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.ghostPulse = { bodyWrap, funnelWrap };
    this.ghostContainer.setAlpha(0.9);

    this.drag = {
      source, grab, shape, origFactory,
      // setup-mode bookkeeping (unused in design mode)
      factoryId: factoryId || (origFactory && origFactory.id) || null,
      assignmentRotation,
      originAssignment,
    };
    this._clearHoverPreview();

    // Seed ghost position at the pointer so there's no first-frame jump. The
    // update loop then eases it toward the target (snap-smoothing).
    const pointer = this.input.activePointer;
    if (pointer) {
      this.ghostContainer.x = pointer.x - (grab.c * (this.pxCell + BOARD_GAP) + this.pxCell / 2);
      this.ghostContainer.y = pointer.y - (grab.r * (this.pxCell + BOARD_GAP) + this.pxCell / 2);
      this.ghostTargetX = this.ghostContainer.x;
      this.ghostTargetY = this.ghostContainer.y;
    }
    this._renderDrawGrid(); // re-render hides the draft now that drag is active
  }

  _onDragMove(x, y) {
    if (!this.drag) return;
    const step = this.pxCell + BOARD_GAP;
    const grab = this.drag.grab;
    const boardCell = this._boardCellAt(x, y);

    // Over a board cell → snap the TARGET to the cell's center. Elsewhere the
    // target follows the pointer. Either way the actual ghost position eases
    // toward the target each frame (see update()), which makes both the
    // snap-on and snap-between-cells transitions look smooth.
    let targetX = x, targetY = y;
    if (boardCell) {
      targetX = this.boardOriginX + boardCell.c * step + this.pxCell / 2;
      targetY = this.boardOriginY + boardCell.r * step + this.pxCell / 2;
    }
    this.ghostTargetX = targetX - (grab.c * step + this.pxCell / 2);
    this.ghostTargetY = targetY - (grab.r * step + this.pxCell / 2);

    this._updatePlacementPreview(boardCell, x, y);
  }

  _onDragEnd({ boardRC }) {
    if (!this.drag) { this._clearDrag(); return; }
    const pointer = this.input.activePointer;
    const px = pointer ? pointer.x : 0;
    const py = pointer ? pointer.y : 0;

    if (this._mode === 'blueprintSetup') {
      // Setup-mode goal: move every solution factory into a unique blueprint
      // slot. The only valid drop target is an empty slot. Drops elsewhere
      // (including back on the board) cancel and restore the origin.
      const slot = this._drawGridCellAt(px, py);
      if (slot && this._assignToSlot(slot)) { this._clearDrag(); return; }
      this._cancelDrag();
      this._clearDrag();
      return;
    }

    // Drop-destination priority: board cell → draw grid → cancel.
    if (boardRC && this._tryPlaceOnBoard(boardRC)) {
      this._clearDrag();
      return;
    }
    if (this._drawGridCellAt(px, py)) {
      this._moveToDraft();
      this._clearDrag();
      return;
    }
    // No valid target — cancel: if we picked up a placed factory, put it back.
    this._cancelDrag();
    this._clearDrag();
  }

  // Assign the dragged factory to a blueprint slot. `slot` is the pointer-
  // under slot; we subtract the grab offset so the exact cell the user
  // grabbed lands under the pointer (critical for multi-cell factories).
  // Returns false (caller cancels) when the resulting footprint would
  // collide with another assignment or spill out of bounds.
  _assignToSlot(slot) {
    if (!this.drag) return false;
    const factoryId = this.drag.factoryId || (this.drag.origFactory && this.drag.origFactory.id);
    if (!factoryId) return false;
    const rotation = this.drag.assignmentRotation || 0;
    const grab = this.drag.grab || { r: 0, c: 0 };
    const anchor = { r: slot.r - grab.r, c: slot.c - grab.c };
    if (!this._assignmentFits(factoryId, anchor, rotation)) return false;
    // Make sure the factory is removed from the board (might already be gone
    // if the drag started from a slot or from the board with the standard
    // pickup path).
    this.level.factories = this.level.factories.filter((f) => f.id !== factoryId);
    this._blueprintAssignments.set(factoryId, { slot: { ...anchor }, rotation });
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    // When the last factory lands in its slot, the step indicator lights
    // EXPORT red and the 5s "tap EXPORT" banner fires via _refreshSteps.
    this._refreshSteps();
    return true;
  }

  // True when the dragged factory's rotated footprint, anchored here, fits
  // inside the blueprint slot grid AND doesn't overlap any OTHER already-
  // assigned factory (the dragged one has been popped before drag-start).
  _assignmentFits(factoryId, anchor, rotation) {
    const fac = (this._solutionSnapshot || []).find((f) => f.id === factoryId);
    if (!fac) return false;
    const rot = rotateFactoryShape({ cells: fac.cells, funnels: fac.funnels || [] }, rotation || 0);
    const rows = this.drawGridRows;
    const cols = this.drawGridCols;
    const occupied = new Set();
    for (const [otherId, a] of this._blueprintAssignments) {
      if (otherId === factoryId) continue;
      const other = (this._solutionSnapshot || []).find((f) => f.id === otherId);
      if (!other) continue;
      const orot = rotateFactoryShape({ cells: other.cells, funnels: other.funnels || [] }, a.rotation || 0);
      for (const cc of orot.cells) occupied.add(`${a.slot.r + cc.r},${a.slot.c + cc.c}`);
    }
    for (const cc of rot.cells) {
      const r = anchor.r + cc.r, c = anchor.c + cc.c;
      if (r < 0 || c < 0 || r >= rows || c >= cols) return false;
      if (occupied.has(`${r},${c}`)) return false;
    }
    return true;
  }

  _tryPlaceOnBoard(boardRC) {
    const { grab, shape, source } = this.drag;
    const anchorR = boardRC.r - grab.r;
    const anchorC = boardRC.c - grab.c;
    if (!this._placementValid(anchorR, anchorC, shape.cells)) return false;
    this.level.factories.push({
      id: genId(),
      anchor: { row: anchorR, col: anchorC },
      cells: shape.cells,
      funnels: shape.funnels,
    });
    this._persist();
    if (source === 'draft') {
      this.draftCells = [];
      this.draftFunnels = [];
    }
    this._renderAll();
    this._renderDrawGrid();
    this._restartSim();
    return true;
  }

  // Drop on the draw grid: the dragged factory becomes the new draft. Any
  // existing draft (if dragging from board) is replaced. If the drag came
  // from the board the source factory is discarded (already removed on start).
  _moveToDraft() {
    const { shape } = this.drag;
    this.draftCells = shape.cells.map((c) => ({ ...c }));
    this.draftFunnels = (shape.funnels || []).map((f) => ({ ...f }));
    this._persist();
    this._renderAll();
    this._renderDrawGrid();
    this._restartSim();
  }

  // Drag canceled (dropped on nothing). A draft-drag needs no restoration —
  // the draft was never mutated. A board-drag removed the factory on start,
  // so we re-insert it at its original anchor.
  _cancelDrag() {
    if (this.drag.source === 'slot' && this.drag.factoryId && this.drag.originAssignment) {
      // Restore the slot assignment we popped on drag-start.
      this._blueprintAssignments.set(this.drag.factoryId, {
        slot: { ...this.drag.originAssignment.slot },
        rotation: this.drag.originAssignment.rotation || 0,
      });
      this._renderDrawGrid();
      this._refreshSteps();
      return;
    }
    if (this.drag.source === 'board' && this.drag.origFactory) {
      this.level.factories.push(this.drag.origFactory);
      this._renderAll();
      this._restartSim();
    }
  }

  _placementValid(anchorR, anchorC, cells) {
    const occupied = this._occupiedCells();
    const { cols, rows } = this.level.board;
    for (const { r, c } of cells) {
      const br = anchorR + r, bc = anchorC + c;
      if (br < 0 || br >= rows || bc < 0 || bc >= cols) return false;
      if (occupied.has(`${br},${bc}`)) return false;
    }
    return true;
  }

  _occupiedCells() {
    const set = new Set();
    // Border walls.
    const { cols, rows } = this.level.board;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (isBorderCell(this.level.board, r, c)) set.add(`${r},${c}`);
    }
    for (const fac of this.level.factories) {
      for (const { r, c } of fac.cells) set.add(`${fac.anchor.row + r},${fac.anchor.col + c}`);
    }
    return set;
  }

  // Validity feedback while dragging: when the drop would fail on a board
  // cell, paint a big red X in every cell of the dragged shape that's
  // intersecting a wall or occupied cell. Ghost stays fully opaque so the
  // shape is still readable.
  _updatePlacementPreview(boardCell, pointerX, pointerY) {
    this.placementContainer.removeAll(true);
    if (!this.drag) return;
    this.ghostContainer.setAlpha(0.95);
    if (!boardCell) return;

    const { grab, shape } = this.drag;
    const anchorR = boardCell.r - grab.r;
    const anchorC = boardCell.c - grab.c;
    if (this._placementValid(anchorR, anchorC, shape.cells)) return;

    // Paint an X in each intersecting cell.
    const occupied = this._occupiedCells();
    const { cols, rows } = this.level.board;
    const step = this.pxCell + BOARD_GAP;
    const gfx = this.make.graphics({ add: false });
    const lineW = Math.max(3, Math.round(this.pxCell * 0.12));
    gfx.lineStyle(lineW, 0xe63946, 1);
    const pad = this.pxCell * 0.2;
    for (const { r, c } of shape.cells) {
      const br = anchorR + r, bc = anchorC + c;
      const outOfBounds = br < 0 || br >= rows || bc < 0 || bc >= cols;
      if (!outOfBounds && !occupied.has(`${br},${bc}`)) continue; // not this cell
      // Draw the X — even for out-of-bounds cells, anchor it where the cell
      // WOULD be so the player sees exactly which parts of the shape conflict.
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

  _clearDrag() {
    this.drag = null;
    this.ghostPulse = null;
    this.ghostFlow = null;             // gfx destroyed by ghostContainer.removeAll
    this.ghostContainer.removeAll(true);
    this.placementContainer.removeAll(true);
    this._renderDrawGrid();
  }

  // ===================================================================
  //   Hover preview
  // ===================================================================

  _clearHoverPreview() {
    if (this.hoverContainer)      this.hoverContainer.removeAll(true);
    if (this.boardHoverContainer) this.boardHoverContainer.removeAll(true);
  }

  _updateHoverPreview(px, py) {
    if (!this.ready) return;
    this._clearHoverPreview();
    if (this.drag) return;

    // Edge preview (funnel cycling) takes priority over cell preview.
    const edge = this._edgeAt(px, py);
    if (edge && edge.kind === 'draft') {
      this._previewFunnel(this.hoverContainer, edge.r, edge.c, edge.side, this.drawCellPx, 0, this._nextDraftFunnelRole(edge.r, edge.c, edge.side));
      return;
    }
    if (edge && edge.kind === 'border') {
      this._previewFunnel(this.boardHoverContainer, edge.r, edge.c, edge.side, this.pxCell, BOARD_GAP, this._nextBorderFunnelRole(edge.r, edge.c, edge.side), 1);
      return;
    }
    // Fallback to cell add preview inside the draw grid.
    const cell = this._drawGridCellAt(px, py);
    if (!cell) return;
    const already = this._isDraftCell(cell.r, cell.c);
    if (already) return;
    if (!isAdjacentToFactory(this.draftCells, cell.r, cell.c)) return;
    this._previewDraftCell(cell.r, cell.c);
  }

  _nextDraftFunnelRole(r, c, side) {
    const existing = this.draftFunnels.find((f) => f.r === r && f.c === c && f.side === side);
    if (!existing)               return 'input';
    if (existing.role === 'input') return 'output';
    return null; // next is removal
  }

  _nextBorderFunnelRole(r, c, side) {
    const arr = (this.level.border && this.level.border.funnels) || [];
    const existing = arr.find((f) => f.r === r && f.c === c && f.side === side);
    if (!existing)               return 'input';
    if (existing.role === 'input') return 'output';
    return null;
  }

  _previewDraftCell(r, c) {
    const gfx = this.make.graphics({ add: false });
    const inner = this.drawCellPx * SHAPE_SCALE;
    const m = (this.drawCellPx - inner) / 2;
    gfx.fillStyle(0xcccccc, 0.35);
    gfx.fillRoundedRect(c * this.drawCellPx + m, r * this.drawCellPx + m, inner, inner, 6);
    gfx.lineStyle(2, 0xffffff, 0.4);
    gfx.strokeRoundedRect(c * this.drawCellPx + m, r * this.drawCellPx + m, inner, inner, 6);
    this.hoverContainer.add(gfx);
  }

  _previewFunnel(container, r, c, side, pxCell, pxGap, nextRole, scale = SHAPE_SCALE) {
    // nextRole === null → next click removes the funnel, no preview to show.
    if (!nextRole) return;
    const pts = funnelPolyPoints(r, c, side, pxCell, pxGap, scale);
    if (pts.length < 3) return;
    const fill = nextRole === 'input' ? 0x6fcf7b : 0xff8a6a;
    const gfx = this.make.graphics({ add: false });
    gfx.fillStyle(fill, 0.5);
    gfx.lineStyle(2, 0xffffff, 0.6);
    gfx.beginPath();
    gfx.moveTo(pts[0][0], pts[0][1]);
    gfx.lineTo(pts[1][0], pts[1][1]);
    gfx.lineTo(pts[2][0], pts[2][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
    container.add(gfx);
  }

  // ===================================================================
  //   Toolbar
  // ===================================================================

  _buildToolbar() {
    this._buildTitleBar();
    this._setupIconSlotHandlers();
  }

  _buildTitleBar() {
    // TitleBar hugs the "labels-aware" width. Editor uses the `standalone-
    // steps` variant — three bare pills, no surrounding frame, no HOME
    // button. The icon-island BACK slot remains the only way out.
    if (this.titleBar) this.titleBar.destroy();
    const boxY = (this.contentBox && this.contentBox.boxY) || 0;
    this.titleBar = new TitleBar(this, {
      x: this.boardOriginX + this.boardW / 2,
      y: boxY + TitleBar.HEIGHT / 2 + 12,
      width: this.titleBarW,
      levelNumber: this.level.number,
      levelName: this.level.name,
      designerMode: this._designerMode,
      variant: 'standalone-steps',
      steps: {
        states: this._computeStepStates(),
        onStep: (key) => this._onStepTap(key),
      },
    });
  }

  // Map runtime state to the three step pills. Each entry is a
  // { reachable, current, isNew } tuple — see StepIndicator.
  //   • reachable: user can legally jump here.
  //   • current:   the pill the user is actively on (single-selection).
  //   • isNew:     scene-tracked; sticky green ring until the user taps it.
  _computeStepStates() {
    const blocksReady  = !!this._victoryReady;
    const inSetup      = this._mode === 'blueprintSetup';
    const panelOpen    = !!this.exportPanel;
    const setupReady   = inSetup && this._blueprintExportReady && this._blueprintExportReady();

    const reachable = {
      blocks:    true,                            // always reachable (it's the design mode)
      blueprint: blocksReady || inSetup || panelOpen,
      export:    setupReady || panelOpen,
    };
    const current = {
      blocks:    !inSetup && !panelOpen,
      blueprint: inSetup  && !panelOpen,
      export:    panelOpen,
    };
    const newSet = this._stepNew || new Set();
    return [
      { reachable: reachable.blocks,    current: current.blocks,    isNew: newSet.has('blocks')    },
      { reachable: reachable.blueprint, current: current.blueprint, isNew: newSet.has('blueprint') },
      { reachable: reachable.export,    current: current.export,    isNew: newSet.has('export')    },
    ];
  }

  _onStepTap(key) {
    // Tapping a pill always clears its "new" highlight — whether the tap
    // actually advances mode or not (e.g. tapping a currently-active pill).
    if (this._stepNew) this._stepNew.delete(key);
    if (key === 'blocks') {
      if (this._mode === 'blueprintSetup') this._exitBlueprintSetup();
      return;
    }
    if (key === 'blueprint') {
      if (this._mode === 'design' && this._victoryReady) this._enterBlueprintSetup();
      return;
    }
    if (key === 'export') {
      if (this._mode === 'blueprintSetup' && this._blueprintExportReady()) this._openExportPanel();
    }
  }

  // Repaint the step indicator with the current states. Two side-effects:
  //   1. Maintain `this._stepNew` — add a key on locked→reachable transition
  //      (the user hasn't seen this step yet), remove on reachable→locked
  //      (regression invalidates the cue).
  //   2. Fire a 5-second banner on the same transitions so the user gets
  //      explicit "tap BLUEPRINT / EXPORT to continue" copy.
  _refreshSteps() {
    if (!this.titleBar || !this.titleBar.setStepStates) return;
    if (!this._stepNew) this._stepNew = new Set();
    const prev = this._lastStepReachable || { blocks: true, blueprint: false, export: false };
    const states = this._computeStepStates();
    const reach = {
      blocks:    states[0].reachable,
      blueprint: states[1].reachable,
      export:    states[2].reachable,
    };
    // Transitions drive the "new" flag + banner.
    if (!prev.blueprint && reach.blueprint) {
      this._stepNew.add('blueprint');
      this._showStepAdvanceBanner('Blocks done \u2014 tap BLUEPRINT to continue');
    } else if (prev.blueprint && !reach.blueprint) {
      this._stepNew.delete('blueprint');
      this._dismissStepAdvanceBanner();
    }
    if (!prev.export && reach.export) {
      this._stepNew.add('export');
      this._showStepAdvanceBanner('Blueprint done \u2014 tap EXPORT to publish');
    } else if (prev.export && !reach.export) {
      this._stepNew.delete('export');
      this._dismissStepAdvanceBanner();
    }
    // Paint AFTER maintaining _stepNew so the ring reflects the latest set.
    this.titleBar.setStepStates(this._computeStepStates());
    this._lastStepReachable = reach;
  }

  _showStepAdvanceBanner(message) {
    this._dismissStepAdvanceBanner();
    const w = Math.min(420, this.boardW - 16);
    const h = 48;
    const cx = this.boardOriginX + this.boardW / 2;
    const cy = this.boardOriginY + h / 2 + 8;
    const depth = 8500;
    const bg = this.add.graphics().setDepth(depth);
    bg.fillStyle(0x3b66b8, 1);
    bg.lineStyle(2, 0x1a2332, 1);
    bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 12);
    bg.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 12);
    const label = this.add.text(cx, cy, message, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(depth);
    this._stepAdvanceBanner = { bg, label };
    // Auto-fade after 5s, then remove.
    this._stepAdvanceTween = this.tweens.add({
      targets: [bg, label], alpha: 0,
      delay: 5000, duration: 500,
      onComplete: () => this._dismissStepAdvanceBanner(),
    });
  }

  _dismissStepAdvanceBanner() {
    if (this._stepAdvanceTween) {
      try { this._stepAdvanceTween.stop(); } catch (e) {}
      this._stepAdvanceTween = null;
    }
    if (!this._stepAdvanceBanner) return;
    const { bg, label } = this._stepAdvanceBanner;
    bg && bg.destroy(); label && label.destroy();
    this._stepAdvanceBanner = null;
  }

  // Designer mode — open the SAVE dropdown (Save Locally / Save Publicly /
  // Download JSON). Anchored beneath the SAVE button.
  _openSaveMenu() {
    if (this.saveMenu) { this.saveMenu.close(); this.saveMenu = null; }
    const anchor = this.titleBar && this.titleBar.getNameAnchor
      ? { x: this.boardOriginX + this.boardW / 2 - this.titleBarW / 2 + 50,
          y: (this.contentBox.boxY || 0) + TitleBar.HEIGHT + 12 }
      : { x: this.scale.width / 2, y: 100 };
    this.saveMenu = new SaveMenu(this, {
      x: anchor.x,
      y: anchor.y,
      level: this.level,
      onClose: () => { this.saveMenu = null; },
      onAfterSave: (stamped) => {
        // Refresh local id + chrome so the next SAVE updates in place.
        this.level.id = stamped.id;
        this.level.author = stamped.author;
        this.level.status = stamped.status;
        this._designerLevelId = stamped.id;
        if (this.titleBar) this.titleBar.setLevel(this.level.number, this.level.name);
      },
    });
  }

  // Designer mode — open the editable level-name input over the title bar.
  _openNameInput() {
    if (this.nameInput) { this.nameInput.destroy(); this.nameInput = null; }
    const anchor = this.titleBar && this.titleBar.getNameAnchor && this.titleBar.getNameAnchor();
    if (!anchor) return;
    this.nameInput = new TextInputOverlay(this, {
      x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height,
      value: this.level.name || '',
      placeholder: 'level name',
      maxLength: 32,
      onCommit: (v) => {
        const name = (v || '').trim() || 'untitled';
        this.level.name = name;
        if (this.titleBar) this.titleBar.setLevel(this.level.number, name);
        this._persist();
        this.nameInput = null;
      },
      onCancel: () => { this.nameInput = null; },
    });
  }

  // Transparent hit-rects sitting over the icon island's slots, so BACK /
  // HINT / −/+ / CLEAR are tappable without interfering with the draft-grid
  // DragController. Rebuilt each time the layout runs.
  _setupIconSlotHandlers() {
    if (this.iconSlotHits) for (const h of this.iconSlotHits) h.destroy();
    this.iconSlotHits = [];
    const slotW = this.islandSlotW;
    const islandH = this.islandH;
    const iconY = this.iconIslandOriginY + islandH / 2;
    const makeHit = (slot, onTap) => {
      const cx = this.iconIslandOriginX + slot * slotW + slotW / 2;
      const rect = this.add.rectangle(cx, iconY, slotW - 6, islandH - 6, 0xffffff, 0)
        .setInteractive({ useHandCursor: true });
      rect.on('pointerup', onTap);
      this.iconSlotHits.push(rect);
    };
    makeHit(SLOT_BACK, () => {
      // BACK in blueprint-setup cancels setup and restores the play area;
      // BACK anywhere else exits the scene to Community / Home.
      if (this._mode === 'blueprintSetup') { this._exitBlueprintSetup(); return; }
      this.sim && this.sim.stop();
      fadeTo(this, this._designerMode ? 'Community' : 'Home');
    });
    makeHit(SLOT_HINT, () => {
      // EXPORT progression — same for sandbox and designer mode. Design +
      // victory → switch to blueprint-setup. Setup + all-slotted → open
      // the ExportPanel.
      if (this._mode === 'design') {
        if (this._victoryReady) this._enterBlueprintSetup();
      } else if (this._mode === 'blueprintSetup') {
        if (this._blueprintExportReady()) this._openExportPanel();
      }
    });
    makeHit(SLOT_SHRINK, () => { if (this._mode !== 'blueprintSetup') this._resizeBoard(-1); });
    makeHit(SLOT_GROW,   () => { if (this._mode !== 'blueprintSetup') this._resizeBoard(+1); });
    makeHit(SLOT_CLEAR, () => {
      if (this._mode === 'blueprintSetup') return;
      this.level.factories = [];
      this._persist();
      this._renderAll();
      this._restartSim();
    });
  }

  // Grow or shrink the interior board by one cell in each dimension. Wipes
  // funnels / inputs / outputs / factories (fresh slate), reseeds a default
  // typed input + output, re-lays out the scene, rebuilds the title bar,
  // and triggers a screenwide fade-in via the main camera.
  _resizeBoard(delta) {
    const dim = this.level.board.rows + delta;
    if (dim < BOARD_MIN_DIM || dim > BOARD_MAX_DIM) return;
    this.level.board.rows = dim;
    this.level.board.cols = dim;
    seedDefaultFunnels(this.level);
    this.draftCells = [];
    this.draftFunnels = [];
    this._persist();

    this._layoutBoardAndDrawGrid();

    // Simulation + ShapeRenderer cache pxCell at construction — rebuild both
    // so new spawn coordinates use the new cell size. Stop the old sim and
    // drop its shapes first.
    if (this.sim) this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (accepted && funnel.ownerId === 'border') {
          this._onEditorOutputSatisfied(funnel);
        }
      },
    });

    if (this.iconSlotHits) for (const h of this.iconSlotHits) h.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._restartSim();
    // pxCell changed but Phaser's scale didn't — refresh the letterbox CSS.
    if (this._reapplyLetterbox) this._reapplyLetterbox();
    this._playResizeFade();
  }

  // Screenwide fade-in via a viewport-sized DOM overlay: covers the canvas
  // AND the HTML letterbox (which the Phaser camera can't touch). Brown
  // BG_COLOR so the fade-through blends with the existing checker.
  _playResizeFade() {
    let overlay = document.getElementById('blockyard-fade-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'blockyard-fade-overlay';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = '#412722';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '9999';
      document.body.appendChild(overlay);
    }
    const state = { a: 0.75 };
    overlay.style.opacity = String(state.a);
    this.tweens.add({
      targets: state, a: 0, duration: RESIZE_FADE_MS, ease: 'Sine.Out',
      onUpdate: () => { overlay.style.opacity = String(state.a); },
      onComplete: () => { overlay.style.opacity = '0'; },
    });
  }

  // Viewport resized: the 9:20 content box changed, so re-run layout, re-
  // render chrome, and rebuild the TitleBar at the new width. No board-
  // dimension change, so level state and sim stay intact (except sim /
  // ShapeRenderer need to know the new pxCell).
  _relayoutForViewport() {
    if (!this.ready || !this.level) return;
    this._layoutBoardAndDrawGrid();
    if (this.sim) this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => this.shapeRenderer.spawn(shape),
      onRemove: (shape, pop) => this.shapeRenderer.remove(shape, pop),
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (accepted && funnel.ownerId === 'border') {
          this._onEditorOutputSatisfied(funnel);
        }
      },
    });
    if (this.titleBar) this.titleBar.destroy();
    if (this.iconSlotHits) for (const h of this.iconSlotHits) h.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._restartSim();
    if (this._reapplyLetterbox) this._reapplyLetterbox();
  }

  // Hit-test for the icon island. Returns `{ slot }` with slot in
  // [0, ICON_SLOTS) if the pointer is inside the island, else null.
  _iconSlotAt(px, py) {
    const slotW = this.islandSlotW;
    const islandH = this.islandH;
    const lx = px - this.iconIslandOriginX;
    const ly = py - this.iconIslandOriginY;
    if (ly < 0 || ly >= islandH) return null;
    if (lx < 0 || lx >= ICON_SLOTS * slotW) return null;
    return { slot: Math.floor(lx / slotW) };
  }
}

// Defensive normalizer for community-loaded levels — adds any missing
// schema fields the editor expects to exist (border / inputs / outputs /
// factories / initialFactories / lockedFactories) so an old or imported
// level never crashes rendering. Mutates + returns the level.
function normalizeForEditor(level) {
  if (!level.board) level.board = { cols: 6, rows: 6 };
  if (!Array.isArray(level.factories))         level.factories = [];
  if (!Array.isArray(level.initialFactories))  level.initialFactories = [];
  if (!Array.isArray(level.lockedFactories))   level.lockedFactories = [];
  if (!level.border || !Array.isArray(level.border.funnels)) level.border = { funnels: [] };
  if (!Array.isArray(level.inputs))  level.inputs  = [];
  if (!Array.isArray(level.outputs)) level.outputs = [];
  if (typeof level.name !== 'string')   level.name   = 'untitled';
  if (typeof level.number !== 'number') level.number = 0;
  return level;
}

// Stamp dots along an axis-aligned edge, with `spacing` px between dots.
// Used by _renderDrawGrid for the blueprint's white dotted grid.
function stampEdge(gfx, x1, y1, x2, y2, spacing) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    gfx.fillCircle(x1 + dx * t, y1 + dy * t, 1.3);
  }
}
