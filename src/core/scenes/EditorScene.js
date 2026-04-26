import Phaser from 'phaser';
import {
  loadLevel, saveLevel, genId, seedDefaultFunnels, defaultLevel,
  defaultBossLevel, defaultBossRound,
  applyBossRoundToWorking, snapshotWorkingToBossRound,
} from '../model/level.js';
import { BossPhaseIndicator } from '../ui/BossPhaseIndicator.js';
import { FunnelParticleSystem, collectFunnelsForParticles, collectFactoryFunnelsForParticles } from '../render/FunnelParticleSystem.js';
import { getCommunityLevelById, saveLocal as saveCommunityLocal } from '../community.js';
import { resumeMusic, resetLayersToInitial } from '../audio/MusicEngine.js';
import {
  playOnce, wireUiClicks, spawnEmptyClickParticles,
  playSfxSound, createLoopingSfx,
} from '../audio/sfx.js';
import { SaveMenu } from '../ui/SaveMenu.js';
import { TextInputOverlay } from '../ui/TextInputOverlay.js';
import {
  isAdjacentToFactory, isPerimeterEdge,
  normalizeFactory, isBorderCell, innerSideOf, funnelPolyPoints,
  validateFactory, isObstacleFactory,
} from '../model/shape.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody, renderLockedTint, drawBoltInto } from '../render/FactoryBodyRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderFlow } from '../render/FlowRenderer.js';
import { renderBufferLabels, computeBufferLabelBox } from '../render/BufferLabelRenderer.js';
import { renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline } from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { LaserRenderer } from '../render/LaserRenderer.js';
import { BufferMarkerRenderer } from '../render/BufferMarkerRenderer.js';
import { TitleBar } from '../ui/TitleBar.js';
import { StagePillStrip } from '../ui/StagePillStrip.js';
import {
  stageColor, CURRENT_STAGE_COLOR, FUTURE_STAGE_ALPHA, PAST_STAGE_ALPHA, CELL_TINT_ALPHA,
} from '../ui/stageColors.js';
import { renderAcidPits } from '../render/AcidPitRenderer.js';
import { ExportPanel } from '../ui/ExportPanel.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import { rotateFactoryShape } from '../model/shape.js';
import { DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import { UndoStack } from '../editor/UndoStack.js';
import { PaletteBar } from '../editor/PaletteBar.js';
import { PalettePopup } from '../editor/PalettePopup.js';
import { HelpModal } from '../editor/HelpModal.js';
import { ConfirmModal } from '../editor/ConfirmModal.js';
import { TOOLS_BY_SLOT, SLOT, findTool } from '../editor/tools.js';
import { applyToolAt } from '../editor/applyTool.js';
import { drawBackChevron, drawHome, drawQuestion, drawTrash, drawPlus, drawMinus, drawGear } from '../ui/Icons.js';
import { SettingsModal } from '../ui/SettingsModal.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { themeForSectionIdx } from '../themes/sectionThemes.js';
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

const TOOLBAR_H = TitleBar.HEIGHT + 8;    // space reserved above the play area
const ICON_SLOTS = 5;                     // fixed — HOME, START_OVER, -, +, GEAR

// Blueprint (draft-composer) chrome. Grid + a small separate icon island
// sitting below the grid in its own rounded-rect panel.
const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;
// Vertical gap between the new palette band and the composer's draw grid
// inside the blueprint area. Small — they share the same blueprint panel.
const PALETTE_TO_GRID_GAP = 6;

// Used by _snapFactoryEdge / _snapBorderEdge / _snapComposerEdge.
const EDGE_SIDES = ['top', 'bottom', 'left', 'right'];

// Midpoint (in scene coords) of one side of a cell positioned at top-left
// (cellX, cellY) with size `cellSize`.
function _edgeMidpoint(cellX, cellY, cellSize, side) {
  const half = cellSize / 2;
  switch (side) {
    case 'top':    return [cellX + half, cellY];
    case 'bottom': return [cellX + half, cellY + cellSize];
    case 'left':   return [cellX,        cellY + half];
    case 'right':  return [cellX + cellSize, cellY + half];
  }
  return [cellX, cellY];
}

// Which slot holds which icon. Reduced from the legacy 6-slot layout
// (HOME / BACK / EXPORT / SHRINK / GROW / CLEAR) to 4 — Back and Export
// behaviors are deferred until they're re-surfaced via another UI affordance.
const SLOT_HOME       = 0;
const SLOT_START_OVER = 1;
const SLOT_SHRINK     = 2;
const SLOT_GROW       = 3;
const SLOT_GEAR       = 4;

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
    // Boss mode: the editor authors an N-stage boss level (2..5). The level's
    // `boss.rounds[]` holds per-stage data; the top-level fields mirror the
    // currently-active stage so the existing design/blueprint plumbing keeps
    // working. `stageCount` is locked at entry.
    // Boss mode is only supported in designer mode — the sandbox key has
    // no schema for it. Drop the flag silently if entered non-designer.
    this._bossMode = !!(data && data.bossMode) && this._designerMode;
    this._bossStageCount = Math.max(2, Math.min(5, (data && data.stageCount) | 0 || 3));
    this._bossStageIdx = 0;
    this._bossMaxVisitedIdx = 0;
    this._bossNeedsInvalidation = false;
  }

  async create() {
    wireUiClicks(this);
    disableMenuBg();
    fadeIn(this);
    // The music bed plays everywhere; PlayerScene pauses it while the
    // sim is idle and resumes on sim start. In the editor the sim is
    // always auto-running (for live funnel output), so we just force
    // the bed back on in case it was paused by a prior PlayerScene
    // transition that didn't cleanly release it. resetLayersToInitial
    // then snaps layers 2..N back to muted + layer 1 to DEFAULT_VOL so
    // the editor always sounds like "layer 1 only" regardless of what
    // state the MusicEngine was left in by the previous scene (e.g.
    // mid-fade after a victory swell).
    try { resumeMusic(); } catch (e) {}
    try { resetLayersToInitial(); } catch (e) {}
    // Synchronous field init BEFORE the await so update() never sees undefined
    // state on the first frame.
    this.ready = false;
    this.level = null;
    this.draftCells = [];
    this.draftFunnels = [];
    this.drag = null;

    // Layer order (back to front). Back-drop chrome (brown exterior, inner
    // shadow, black frame outline) sits at LOW depths so sim visuals —
    // shapes + laser beams — render ON TOP of the black border and the
    // brown buffer checker. Factories/funnels are still layered above
    // shapes/lasers, so the relative z-order inside the play area is
    // preserved. The "cut-out" trick is gone; stray factories in the
    // buffer region are legitimately visible (matches ghost-drag previews).
    this.boardContainer        = this.add.container(0, 0).setDepth(0);
    this.exteriorContainer     = this.add.container(0, 0).setDepth(2);
    this.shadowContainer       = this.add.container(0, 0).setDepth(4);
    this.frameContainer        = this.add.container(0, 0).setDepth(5);
    // Acid pits paint over the interior floor but under sim visuals.
    this.acidPitContainer      = this.add.container(0, 0).setDepth(7);
    // Ambient funnel-inhale/exhale dots sit BELOW shapes so an emerging
    // shape paints over its own preview particles instead of being veiled by
    // them.
    this.factoryFunnelParticleContainer = this.add.container(0, 0).setDepth(8);
    this.borderFunnelParticleContainer  = this.add.container(0, 0).setDepth(9);
    this.shapeContainer        = this.add.container(0, 0).setDepth(10);
    // Laser beams sit BELOW the funnels + factory bodies but ABOVE the
    // black frame / brown exterior so they read across the buffer region.
    this.laserContainer        = this.add.container(0, 0).setDepth(12);
    this.funnelContainer       = this.add.container(0, 0).setDepth(15);
    this.interactiveContainer  = this.add.container(0, 0).setDepth(20);
    // Flow dashes sit on top of the factory body so the manifold pattern is
    // visible (the body is opaque mid-grey; at depth < body the dashes were
    // hidden).
    this.flowContainer         = this.add.container(0, 0).setDepth(22);
    // Border funnels + emitter glyphs, buffer label tiles, and sink-resolve
    // markers all render ABOVE the black frame outline so the centered box
    // cluster (triangle + tile + marker) reads as ONE piece on top of the
    // border line — rather than the frame cutting through each of them.
    this.borderFunnelContainer = this.add.container(0, 0).setDepth(163);
    this.labelContainer        = this.add.container(0, 0).setDepth(165);
    this.bufferMarkerContainer = this.add.container(0, 0).setDepth(168);
    // Error badges (red text over invalid factories) sit above the frame
    // outline so they're always legible.
    this.errorContainer        = this.add.container(0, 0).setDepth(170);
    this.drawGridContainer    = this.add.container(0, 0).setDepth(50);
    // Palette bar sits between the composer (drawGridContainer) and the
    // icon island, in the top band of the blueprint area. Renders the
    // 6 white pill slots holding the currently-armed tool per category.
    this.paletteContainer     = this.add.container(0, 0).setDepth(51);
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
    this._renderPaletteBar();
    this._renderIconIsland();
    this._buildToolbar();

    this._reapplyLetterbox = wireLetterboxChecker(this, () => ({
      pxCell: this.pxCell,
      boardOriginX: this.boardOriginX,
      boardOriginY: this.boardOriginY,
    }));

    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      ...this._simCallbacks(),
    });
    this.factoryFunnelParticles = new FunnelParticleSystem(this, this.factoryFunnelParticleContainer, { pxCell: this.pxCell });
    this.borderFunnelParticles  = new FunnelParticleSystem(this, this.borderFunnelParticleContainer,  { pxCell: this.pxCell });
    this._refreshFunnelParticles();

    this._satisfiedOutputs = new Set();
    this._satisfiedCatchers = new Set();
    this._victoryReady = false;
    this._mode = 'design';                  // 'design' | 'blueprintSetup'
    this._blueprintAssignments = new Map(); // factoryId -> { slot:{r,c}, rotation }
    this._solutionSnapshot = null;
    // Blueprint-setup-only: factory ids the author has toggled to "locked"
    // on the play area (via click-to-lock). Locked factories stay pinned
    // on the board at play time instead of being dragged into a blueprint
    // slot; in the exported level they land in `lockedFactories`.
    this._lockedFactoryIds = new Set();

    // Snapshot-based undo. Push happens at the start of each user-initiated
    // mutation handler (drag-end, tap-rotate, popup pick, board resize,
    // start-over) — NOT inside _persist, which also runs during init/load
    // where snapshotting would corrupt the stack on first edit.
    this._undoStack = new UndoStack();

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
          if (info.kind === 'board') {
            const fac = this._factoryAtBoardCell(info.r, info.c);
            // A locked factory stays put — taps toggle unlock, drags no-op.
            // In boss mode, carry-over factories (fac.locked) never unlock.
            return !!fac && !fac.locked && !this._lockedFactoryIds.has(fac.id);
          }
          return false;
        }
        if (info.kind === 'draft') return this._isDraftCell(info.r, info.c);
        if (info.kind === 'board') {
          const fac = this._factoryAtBoardCell(info.r, info.c);
          if (fac && !fac.locked) return true;
          // Pits and border funnels are pickup-able — press-drag moves them.
          if (this._acidPitAt(info.r, info.c)) return true;
          const bfArr = (this.level.border && this.level.border.funnels) || [];
          if (bfArr.some((f) => f.r === info.r && f.c === info.c)) return true;
          return false;
        }
        return false;
      },
      // Modal overlays use a fullscreen shield to capture taps; gate the
      // drag controller on each so taps inside an overlay don't also fire
      // edge / cell handlers behind it.
      isPlaying:       () => !!this.saveMenu || !!this.exportPanel || !!this.nameInput || !!this._palettePopup || !!this._helpModal || !!this._confirmModal,
    });

    // Sim auto-runs in the editor so funnels emit shapes as you design. Any
    // level mutation (place/remove factory, cycle border funnel, clear) calls
    // _restartSim() to pick up the new funnel/wall layout.
    this._restartSim();

    // Finished levels opened from the Community list drop straight into
    // blueprint-setup so the author sees their authored initialFactories
    // in their slots. Unfinished drafts restore in plain design mode so
    // the editor reopens exactly as it was left.
    const isFinished = this._designerMode
      && this.level && this.level.status
      && this.level.status !== 'unfinished';
    if (isFinished) this._restoreBlueprintSetupFromLevel();

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
      if (this._settingsModal) { try { this._settingsModal.destroy(); } catch (e) {} this._settingsModal = null; }
      if (this._laserBeamSound) {
        try { this._laserBeamSound.stop(); this._laserBeamSound.destroy(); } catch (e) {}
        this._laserBeamSound = null;
      }
      if (this._laserPrev) this._laserPrev.clear();
      this.dragCtrl && this.dragCtrl.destroy();
      if (this.saveMenu)  { this.saveMenu.close(); this.saveMenu = null; }
      if (this.nameInput) { this.nameInput.destroy(); this.nameInput = null; }
      if (this._acidPits)       { this._acidPits.destroy();      this._acidPits = null; }
      if (this.exportPanel)     { this.exportPanel.destroy();   this.exportPanel = null; }
      if (this.bossPhaseIndicator) { this.bossPhaseIndicator.destroy(); this.bossPhaseIndicator = null; }
      if (this.factoryFunnelParticles) { this.factoryFunnelParticles.destroy(); this.factoryFunnelParticles = null; }
      if (this.borderFunnelParticles)  { this.borderFunnelParticles.destroy();  this.borderFunnelParticles  = null; }
      if (this.draftParticles) { this.draftParticles.destroy(); this.draftParticles = null; }
      if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
      if (this.slotParticleSystems) { for (const s of this.slotParticleSystems) s.destroy(); this.slotParticleSystems = null; }
      if (this._paletteBar)   { this._paletteBar.destroy();   this._paletteBar = null; }
      if (this._palettePopup) { this._palettePopup.close();   this._palettePopup = null; }
      if (this._helpModal)    { this._helpModal.close();      this._helpModal = null; }
      if (this._confirmModal) { this._confirmModal.close();   this._confirmModal = null; }
      if (this._paletteHit)   { this._paletteHit.destroy();   this._paletteHit = null; }
      if (this._paletteGhost) { this._paletteGhost.destroy(); this._paletteGhost = null; }
      if (this._pendingPaletteTap) {
        this._pendingPaletteTap.timer.remove(false);
        this._pendingPaletteTap = null;
      }
      if (this._paletteMoveHandler) { this.input.off('pointermove', this._paletteMoveHandler); this._paletteMoveHandler = null; }
      if (this._paletteUpHandler)   { this.input.off('pointerup',   this._paletteUpHandler);   this._paletteUpHandler   = null; }
      this._dismissStepAdvanceBanner && this._dismissStepAdvanceBanner();
      if (this._stepNew) this._stepNew.clear();
      this._lastStepReachable = null;
      if (this._onScaleResize) this.scale.off('resize', this._onScaleResize);
    });

    this.ready = true;
  }

  update(time) {
    if (!this.ready) return;
    const dt = this._lastUpdateTime != null ? Math.min(100, time - this._lastUpdateTime) : 16;
    this._lastUpdateTime = time;
    // 30fps cosmetic tick — flow repaint and the squash/stretch sweep are
    // purely visual and don't need to run every frame. Gate them on an
    // accumulator so at 60fps they fire every other frame (still smooth),
    // and at <30fps they fire every frame (no worse than before). Cuts
    // per-frame mobile GPU cost roughly in half.
    this._cosmeticAccum = (this._cosmeticAccum || 0) + dt;
    const cosmeticTick = this._cosmeticAccum >= 32;
    if (cosmeticTick) this._cosmeticAccum = 0;
    if (cosmeticTick) {
      const t = (time % CYCLE_MS) / CYCLE_MS;
      // Subtle squash-and-stretch. Each factory has two wrap containers
      // positioned at the factory's center: one for the body, one for the
      // funnels. The funnels run in opposite phase so they react against
      // the body as it deforms. Both wraps scale around their shared
      // center so nothing drifts.
      const sq = shapeSquash(t);
      const applyPair = (entry) => {
        // Powered-type factories stay STILL until fully powered — the idle
        // (unpowered) body reads as "inert" rather than breathing with the
        // rest of the board. Once the aggregate bolt glow is full, the
        // factory rejoins the normal pulse.
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
      for (const entry of this.factoryRefs.values()) applyPair(entry);
      if (this.draftPulse) applyPair(this.draftPulse);
      if (this.ghostPulse) applyPair(this.ghostPulse);
      // Border funnel triangles pulse like factory funnels; buffer label
      // boxes pulse like factory BODIES — so the triangle and its label
      // box alternate the same way a factory's body and its funnels do.
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

      // Pass raw `time` so the dash pattern is monotonic (no cycle-boundary
      // jump). Animate every factory copy on screen — placed body, draft
      // composer, ghost during drag, and blueprint-setup slot previews —
      // even when the sim isn't actively spawning shapes.
      for (const f of this.flowUpdaters) f.update(time);
      if (this.draftFlow) this.draftFlow.update(time);
      if (this.ghostFlow) this.ghostFlow.update(time);
      if (this.slotFlows) for (const f of this.slotFlows) f.update(time);
      if (this._acidPits) this._acidPits.tick(time);
    }

    // Smooth-lerp the drag ghost toward its target using a dt-based
    // exponential: alpha = 1 - exp(-dt / tau). `tau` is the time constant
    // in ms — how long it takes the ghost to close ~63% of the remaining
    // distance. Frame-rate-independent: at 60fps this lerps ~24% per frame
    // (matching the old feel), and at 10fps it lerps ~63% per frame so the
    // ghost doesn't visibly drag behind the pointer under mobile lag.
    if (this.drag) {
      const alpha = 1 - Math.exp(-dt / 60);
      this.ghostContainer.x += (this.ghostTargetX - this.ghostContainer.x) * alpha;
      this.ghostContainer.y += (this.ghostTargetY - this.ghostContainer.y) * alpha;
    }

    this.sim.update(time);
    if (this.laserRenderer) this.laserRenderer.update(time, this.sim.lasers, this.sim.emitters);
    this._updateLaserSounds();
    this._updateBoltVisuals();
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.update(time);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.update(time);
    if (this.draftParticles)         this.draftParticles.update(time);
    if (this.ghostParticles)         this.ghostParticles.update(time);
    if (this.slotParticleSystems) for (const s of this.slotParticleSystems) s.update(time);
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

  // Per-frame refresh of bolt + factory-perimeter electricity. Each bolt
  // lerps its `glow` toward the sim-reported target. The factory's aggregate
  // Build the sim-callback bundle with SFX wired in. The editor's sim
  // runs continuously (live preview), so every callback branches to
  // playOnce with aggressive throttles — one shape_exit / shape_pop /
  // zap / acid_bubble per cycle at most, and a per-funnel first-hit
  // dedupe on red border funnels that resets whenever the author
  // restarts the sim.
  _simCallbacks() {
    return {
      onSpawn: (shape) => {
        this.shapeRenderer.spawn(shape);
        this._playShapeExitOnce();
      },
      onRemove: (shape, pop, cause) => {
        this.shapeRenderer.remove(shape, pop, cause);
        if (pop) this._playShapePopOnce();
      },
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        if (!this._borderFunnelSounded) this._borderFunnelSounded = new Set();
        if (funnel.ownerId === 'border' && !this._borderFunnelSounded.has(funnel.key)) {
          this._borderFunnelSounded.add(funnel.key);
          playOnce(this.game, accepted ? 'funnel_right' : 'funnel_wrong', { throttleMs: 120, volume: 0.5 });
        }
        if (accepted && funnel.ownerId === 'border') {
          this._onEditorOutputSatisfied(funnel);
        }
      },
      onSinkHit: (funnel) => {
        if (funnel.ownerId !== 'border') {
          playOnce(this.game, 'factory_pass', { throttleMs: 90, volume: 0.15 });
        }
      },
      onShapeApproachSink: () => {
        playOnce(this.game, 'funnel_suck', { throttleMs: 40, volume: 0.22 });
      },
      onShapeElectrocuted: () => {
        playOnce(this.game, 'zap', { throttleMs: 100, volume: 0.5 });
      },
      onShapeEnterAcid: () => {
        playOnce(this.game, 'acid_bubble', { throttleMs: 120, volume: 0.22 });
      },
      onCollectorSatisfied: (c) => {
        if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.mark(c, true);
        this._onEditorCatcherSatisfied(c);
      },
    };
  }

  // Cycle-throttled shape-exit chirp. Wall-clock CYCLE_MS buckets keep
  // multiple same-cycle spawns (border inputs + any factory whose sinks
  // latched last tick) down to one audible click.
  _playShapeExitOnce() {
    if (!this.game) return;
    const cycleIdx = Math.floor(this.time.now / CYCLE_MS);
    if (this._lastShapeExitCycle === cycleIdx) return;
    this._lastShapeExitCycle = cycleIdx;
    playSfxSound(this.game, 'shape_exit', { volume: 0.5 });
  }

  // Multi-shape wall / laser / wrong-sink pops collapse to one sound
  // per 80ms window — matches PlayerScene's behavior.
  _playShapePopOnce() {
    if (!this.game) return;
    const now = this.game.loop.time;
    if (this._shapePopCooldownUntil && now < this._shapePopCooldownUntil) return;
    this._shapePopCooldownUntil = now + 80;
    playSfxSound(this.game, 'shape_pop', { volume: 0.5 });
  }

  // Per-frame laser sound state machine — same contract as PlayerScene.
  // The editor's sim runs continuously for live preview, so these fire
  // whenever an emitter the author just placed begins charging / firing.
  _updateLaserSounds() {
    const emitters = this.sim && this.sim.emitters;
    if (!emitters) return;
    if (!this._laserPrev) this._laserPrev = new Map();
    let anyFiring = false;
    for (const e of emitters) {
      const curPower = e.power || 0;
      const curFiring = !!e.firing;
      const prev = this._laserPrev.get(e.key) || { power: 0, firing: false };
      if (prev.power === 0 && curPower > 0) {
        playOnce(this.game, 'laser_charge', { throttleMs: 60, volume: 0.45 });
      }
      if (!prev.firing && curFiring) {
        playOnce(this.game, 'laser_fire',   { throttleMs: 60, volume: 0.55 });
      }
      if (curFiring) anyFiring = true;
      prev.power = curPower;
      prev.firing = curFiring;
      this._laserPrev.set(e.key, prev);
    }
    if (anyFiring && !this._laserBeamSound) {
      this._laserBeamSound = createLoopingSfx(this.game, 'laser_beam', 0.3);
    } else if (!anyFiring && this._laserBeamSound) {
      this._laserBeamSound.destroy();
      this._laserBeamSound = null;
    }
  }

  // power (max across its bolts) drives the animated perimeter electricity
  // on "powered" factories.
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
        // The body only reads as "powered" when EVERY bolt on it is fully
        // lit — any partial state keeps the factory inert.
        entry.body.poweredGlow.alpha = minGlow >= 1 ? 1 : 0;
      }
    }
  }

  _restartSim() {
    if (!this.sim) return;
    this.sim.stop();
    // Drop laser SFX state: emitter keys can change when factories are
    // added/removed and the running beam loop must stop if the mutation
    // removed the only firing emitter.
    if (this._laserPrev) this._laserPrev.clear();
    if (this._laserBeamSound) {
      this._laserBeamSound.destroy();
      this._laserBeamSound = null;
    }
    // Fresh preview cycle — let red-border funnels chirp again on their
    // first hit so the author hears whether a tweak re-breaks the flow.
    if (this._borderFunnelSounded) this._borderFunnelSounded.clear();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    // Mutations may invalidate the previously-captured solution; force the
    // user to re-satisfy outputs before EXPORT lights up again.
    this._resetVictoryTracking && this._resetVictoryTracking();
    this._refreshFunnelParticles();
    if (this._designerMode) {
      // Refresh the icon island so EXPORT dims back out after a mutation.
      this._renderIconIsland && this._renderIconIsland();
      this._setupIconSlotHandlers && this._setupIconSlotHandlers();
    }
    this.sim.start(this.level, this.time.now);
  }

  // Repopulate the two funnel particle systems from the current level state.
  // Called whenever the level's funnel set changes (factory added/removed,
  // border funnel cycled, board resized, etc.).
  _refreshFunnelParticles() {
    if (!this.factoryFunnelParticles || !this.borderFunnelParticles) return;
    const { factory, border } = collectFunnelsForParticles(
      this.level, this.pxCell, BOARD_GAP, SHAPE_SCALE,
    );
    this.factoryFunnelParticles.setFunnels(factory);
    this.borderFunnelParticles.setFunnels(border);
  }

  // ---------- Designer-mode plumbing (Milestone G) ----------

  // Sandbox: load the editor's localStorage level. Designer mode: load the
  // community level by id, or seed a fresh blank if none was passed (the
  // user pressed LEVEL DESIGNER from the Community scene with no draft yet).
  async _resolveInitialLevel() {
    if (!this._designerMode) return loadLevel();
    if (this._designerLevelId) {
      const existing = await getCommunityLevelById(this._designerLevelId);
      if (existing) {
        const normalized = normalizeForEditor(existing);
        // If the stored draft already has boss data, re-enter boss mode.
        if (normalized.boss && Array.isArray(normalized.boss.rounds) && normalized.boss.rounds.length >= 2) {
          this._bossMode = true;
          this._bossStageCount = normalized.boss.rounds.length;
          applyBossRoundToWorking(normalized, 0);
        }
        return normalized;
      }
    }
    const fresh = this._bossMode
      ? defaultBossLevel(this._bossStageCount)
      : defaultLevel();
    fresh.name = 'untitled';
    fresh.number = 0;
    fresh.origin = 'local';
    // Drafts stay 'unfinished' until the user walks the level through
    // blueprint setup + ExportPanel, which flips to 'private'.
    fresh.status = 'unfinished';
    return fresh;
  }

  // Single funnel for every level mutation. Sandbox writes through the legacy
  // `blockyard.level` key; designer mode writes through community.saveLocal,
  // Editor's auto-running test sim resolves a border output → record it.
  // Recomputes victory once it's been recorded.
  _onEditorOutputSatisfied(funnel) {
    if (this._mode !== 'design') return;
    this._satisfiedOutputs.add(funnel.key);
    this._recomputeVictoryReady();
  }

  // Same idea for laser catchers (collector role on the border ring) —
  // when a laser hits one, record it. A level can be made win-able with
  // catchers ALONE (no standard outputs) so any catcher hit contributes
  // to the same shared victory check.
  _onEditorCatcherSatisfied(collector) {
    if (this._mode !== 'design') return;
    this._satisfiedCatchers.add(collector.key);
    this._recomputeVictoryReady();
  }

  // Victory rule:
  //   • Every required output (level.outputs) must have been satisfied.
  //   • Every required catcher (border funnel with role='collector') must
  //     have been satisfied.
  //   • A level with NEITHER outputs nor catchers can never be victory-
  //     ready (no win condition).
  // So a catcher-only level is valid as long as every catcher has been hit.
  _recomputeVictoryReady() {
    if (this._mode !== 'design') return;
    const reqOutputs = (this.level && this.level.outputs) || [];
    const reqCatchers = ((this.level && this.level.border && this.level.border.funnels) || [])
      .filter((f) => f.role === 'collector');
    if (reqOutputs.length === 0 && reqCatchers.length === 0) return;
    for (const o of reqOutputs) {
      if (!this._satisfiedOutputs.has(`border:${o.r},${o.c},${o.side}`)) return;
    }
    for (const c of reqCatchers) {
      if (!this._satisfiedCatchers.has(`border:${c.r},${c.c},${c.side}`)) return;
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

  // Restart the test sim and clear the satisfaction trackers (any level
  // mutation may invalidate the previous solution).
  _resetVictoryTracking() {
    this._satisfiedOutputs && this._satisfiedOutputs.clear();
    this._satisfiedCatchers && this._satisfiedCatchers.clear();
    this._victoryReady = false;
    this._refreshSteps();
  }

  // ---------- Blueprint-setup mode ----------

  // Re-enter blueprint-setup from a persisted finished level. Mirrors
  // _enterBlueprintSetup but skips the _victoryReady check (the level is
  // already known to solve) and seeds _blueprintAssignments /
  // _lockedFactoryIds from the saved initialFactories / lockedFactories
  // so factories open back in their authored slots.
  _restoreBlueprintSetupFromLevel() {
    if (this._mode === 'blueprintSetup') return;
    const source = (this.level.factories || [])
      .filter((f) => !(this._bossMode && f.locked));
    this._solutionSnapshot = JSON.parse(JSON.stringify(source));
    this._blueprintAssignments = new Map();
    for (const it of (this.level.initialFactories || [])) {
      if (!it.id || !it.slot) continue;
      this._blueprintAssignments.set(it.id, {
        slot: { r: it.slot.row, c: it.slot.col },
        rotation: it.rotation || 0,
      });
    }
    this._lockedFactoryIds = new Set(
      (this.level.lockedFactories || []).map((f) => f.id).filter(Boolean)
    );
    this._victoryReady = true;
    this._mode = 'blueprintSetup';
    if (this.sim) this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    this._refreshSteps();
    this._refreshBossIndicator && this._refreshBossIndicator();
  }

  _enterBlueprintSetup() {
    if (this._mode === 'blueprintSetup') return;
    if (!this._victoryReady) return;
    // Snapshot the solution (deep-clone factories) so we can rebuild the
    // play area on cancel and embed `solution` in the export payload. In
    // boss mode, only non-locked factories (i.e. this stage's own work)
    // participate in blueprint-setup; locked carry-over from prior stages
    // is restored back onto the board on exit.
    const source = (this.level.factories || [])
      .filter((f) => !(this._bossMode && f.locked));
    this._solutionSnapshot = JSON.parse(JSON.stringify(source));
    this._blueprintAssignments = new Map();
    this._lockedFactoryIds = new Set();
    this._mode = 'blueprintSetup';
    if (this.sim) this.sim.stop();
    if (this.shapeRenderer) this.shapeRenderer.clearAll();
    if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
    this._renderDrawGrid();        // becomes the slot grid in blueprint-setup
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    this._refreshSteps();
    this._refreshBossIndicator && this._refreshBossIndicator();
  }

  _exitBlueprintSetup() {
    if (this._mode !== 'blueprintSetup') return;
    this._dismissStepAdvanceBanner();
    if (this.exportPanel) { this.exportPanel.destroy(); this.exportPanel = null; }
    // Restore the solution snapshot so the user can keep editing the design.
    if (this._bossMode) {
      // Rebuild level.factories = cumulative locked carry-over + this
      // stage's unlocked snapshot.
      const rounds = (this.level.boss && this.level.boss.rounds) || [];
      const cumulative = [];
      for (let i = 0; i < this._bossStageIdx; i++) {
        const sf = (rounds[i] && rounds[i].solution && rounds[i].solution.factories) || [];
        for (const f of sf) {
          const fc = JSON.parse(JSON.stringify(f));
          fc.locked = true;
          cumulative.push(fc);
        }
      }
      const own = JSON.parse(JSON.stringify(this._solutionSnapshot || []));
      for (const f of own) f.locked = false;
      this.level.factories = [...cumulative, ...own];
    } else if (this._solutionSnapshot) {
      this.level.factories = JSON.parse(JSON.stringify(this._solutionSnapshot));
    }
    this._blueprintAssignments = new Map();
    this._lockedFactoryIds = new Set();
    this._mode = 'design';
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    this._restartSim();
    this._resetVictoryTracking();
    this._refreshBossIndicator && this._refreshBossIndicator();
  }

  // True when every solution factory has been either (a) assigned to a
  // unique blueprint slot OR (b) marked locked to the play area. Locked
  // factories skip the slot requirement entirely — they ship as
  // `lockedFactories` in the export.
  _blueprintExportReady() {
    if (this._mode !== 'blueprintSetup') return false;
    const total = (this._solutionSnapshot || []).length;
    if (total === 0) return false;
    const accountedFor = this._blueprintAssignments.size + this._lockedFactoryIds.size;
    if (accountedFor !== total) return false;
    for (const fac of (this._solutionSnapshot || [])) {
      const hasSlot = this._blueprintAssignments.has(fac.id);
      const isLocked = this._lockedFactoryIds.has(fac.id);
      if (!hasSlot && !isLocked) return false;
      if (hasSlot && isLocked) return false;   // invariant: never both
    }
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
    if (this._bossMode) return this._assembleBossExportLevel();
    const initialFactories = [];
    const lockedFactories = [];
    for (const fac of this._solutionSnapshot || []) {
      if (this._lockedFactoryIds.has(fac.id)) {
        // Locked = pinned to its authored anchor, no slot assignment.
        lockedFactories.push({
          id: fac.id,
          anchor: { ...fac.anchor },
          cells: fac.cells.map((c) => ({ ...c })),
          funnels: (fac.funnels || []).map((f) => ({ ...f })),
        });
        continue;
      }
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
      // Factories pinned to the play area from the start (click-to-lock
      // in blueprint-setup adds entries here; see _toggleLockAtBoardCell).
      lockedFactories,
      // Solution = the editor-verified placement (for backend mod review).
      solution: { factories: this._solutionSnapshot || [] },
      likes: this.level.likes || 0,
    };
  }

  // Boss mode: snapshot the current stage's working state back into
  // boss.rounds, then return the fully-assembled level with every stage's
  // data embedded. `boss.rounds[i]` is the runtime-consumed shape read by
  // PlayerScene.bossRoundLevel(); each round also carries an editor-only
  // `solution.factories` snapshot for review.
  _assembleBossExportLevel() {
    // We're on the Export step in the flat sequence — snapshot the last
    // visited stage (its Blueprint phase state lives on the scene right now)
    // into boss.rounds[stageIdx] so we don't drop the final assignments.
    this._bossSnapshotStage(this._bossStageIdx);

    const rawBoard = this.level.board || {};
    const cols = Number.isFinite(rawBoard.cols) && rawBoard.cols > 0 ? rawBoard.cols : 6;
    const rows = Number.isFinite(rawBoard.rows) && rawBoard.rows > 0 ? rawBoard.rows : 6;
    const board = { cols, rows };

    const clone = (v) => JSON.parse(JSON.stringify(v || null));
    const rounds = ((this.level.boss && this.level.boss.rounds) || [])
      .slice(0, this._bossStageCount)
      .map((r) => ({
        border: clone(r.border) || { funnels: [] },
        inputs: clone(r.inputs) || [],
        outputs: clone(r.outputs) || [],
        initialFactories: clone(r.initialFactories) || [],
        instructionalText: r.instructionalText || null,
        solution: { factories: clone((r.solution && r.solution.factories) || []) },
      }));

    // Mirror round-0 fields at the top level so importers that don't
    // understand boss still see a valid single-level shape. PlayerScene
    // reads boss.rounds[0] first anyway (bossRoundLevel), so runtime play
    // is driven entirely by the rounds array.
    const r0 = rounds[0] || { border: { funnels: [] }, inputs: [], outputs: [] };
    return {
      ...this.level,
      id: this.level.id || undefined,
      origin: this.level.origin || 'local',
      status: this.level.status || 'private',
      author: this.level.author || null,
      number: this.level.number || 0,
      board,
      border: r0.border,
      inputs: r0.inputs,
      outputs: r0.outputs,
      initialFactories: r0.initialFactories,
      lockedFactories: [],
      solution: r0.solution,
      boss: { rounds },
      likes: this.level.likes || 0,
    };
  }

  // Capture the current editor state (level + composer draft + blueprint
  // slot assignments + mode) as one undo entry. Caller is responsible for
  // invoking this BEFORE applying a mutation. Map values round-trip via
  // JSON because the serialized form is what we restore from.
  _snapshotForUndo() {
    if (!this._undoStack) return;
    this._undoStack.push({
      level: JSON.stringify(this.level),
      assignments: JSON.stringify(Array.from(this._blueprintAssignments.entries())),
      draftCells: JSON.stringify(this.draftCells),
      draftFunnels: JSON.stringify(this.draftFunnels),
      mode: this._mode,
    });
  }

  // Pop the latest snapshot and restore. Returns true if anything was
  // restored, false if the stack was empty (call site can no-op or beep).
  // Restoration covers level + blueprint state AND triggers the same
  // re-render pipeline a normal mutation would (board, composer, sim) so
  // every layer reflects the restored state.
  _undo() {
    if (!this._undoStack) return false;
    const snap = this._undoStack.pop();
    if (!snap) return false;
    this.level = JSON.parse(snap.level);
    this._blueprintAssignments = new Map(JSON.parse(snap.assignments));
    this.draftCells = JSON.parse(snap.draftCells);
    this.draftFunnels = JSON.parse(snap.draftFunnels);
    this._mode = snap.mode;
    this._persist();
    if (typeof this._renderAll === 'function')     this._renderAll();
    if (typeof this._renderDrawGrid === 'function') this._renderDrawGrid();
    if (typeof this._renderIconIsland === 'function') this._renderIconIsland();
    if (typeof this._restartSim === 'function')    this._restartSim();
    return true;
  }

  _persist() {
    // Boss: any mutation while revisiting a prior stage invalidates the
    // stages after it. Fire once per back-nav edit cycle.
    this._bossOnMutate && this._bossOnMutate();
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
    const availW = boxW - 8;

    // Total chrome within the blueprint+island column:
    //   blueprint padding + gap + island padding = 4*PAD + gap
    // Plus the new palette band's gap below itself (palette occupies one
    // refPxCell row inside the blueprint, accounted for in fitPxCell's
    // stack factor below).
    const chrome = BLUEPRINT_PAD * 4 + ISLAND_TO_GRID_GAP + PALETTE_TO_GRID_GAP;

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
      // Cell-size derivation. Width: the board's OUTER width (all cells at
      // full pxCell, including the buffer ring) must fit availW. Height:
      // the full vertical stack (board + blueprint + 1 island row + chrome)
      // must fit boxH. The smaller of the two wins so the whole stack
      // stays in-view on every aspect.
      const wCellFactor = boardDim;
      const wGapFactor  = Math.max(0, boardDim - 1);
      const cellW_board     = (availW - BOARD_GAP * wGapFactor) / wCellFactor;
      const cellW_blueprint = (availW - BLUEPRINT_PAD * 2) / drawGridColsN;
      // Stack rows: board (boardDim) + composer (drawGridRowsN) + palette (1) + island (1).
      const stackCellFactor = boardDim + (drawGridRowsN + 2);
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
    // Palette band height — one reference cell row, sits inside the
    // blueprint area above the composer's draw grid.
    // Palette band sits at ~95% of a cell row — enough to host a square
    // icon plus a comfortable text label above and a chevron below.
    this.paletteH   = Math.round(refPxCell * 0.95);
    this.paletteW   = bpW;

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
    // Center the full stack vertically inside the content box so leftover
    // slack (canvas tuned close to content aspect but not exact) splits
    // evenly top + bottom. With availW trimmed to boxW-8 the horizontal
    // slack also matches, giving a slim margin on all four sides.
    const stackH =
      topMargin + titleToBoardGap +
      boardH + boardToBpGap +
      (BLUEPRINT_PAD * 2) + this.paletteH + PALETTE_TO_GRID_GAP + bpH +
      ISLAND_TO_GRID_GAP + (BLUEPRINT_PAD * 2) + this.islandH +
      bottomMargin;
    const verticalSlack = Math.max(0, Math.floor((boxH - stackH) / 2));
    const stackTop = boxY + verticalSlack;
    this.stackTop = stackTop;              // used by _buildTitleBar
    this.boardOriginX = boxX + Math.round((boxW - boardW) / 2);
    this.boardOriginY = stackTop + topMargin + titleToBoardGap;

    const blueprintTopY = this.boardOriginY + boardH + boardToBpGap;

    this.drawGridOriginX = boxX + Math.round((boxW - bpW) / 2);
    // Palette sits at the top of the blueprint pad; composer's draw grid
    // is shifted down by paletteH + the palette/grid gap.
    this.paletteOriginX = boxX + Math.round((boxW - bpW) / 2);
    this.paletteOriginY = Math.round(blueprintTopY + BLUEPRINT_PAD);
    this.drawGridOriginY = Math.round(this.paletteOriginY + this.paletteH + PALETTE_TO_GRID_GAP);

    this.iconIslandOriginX = boxX + Math.round((boxW - islandW) / 2);
    this.iconIslandOriginY = Math.round(
      this.drawGridOriginY + bpH + BLUEPRINT_PAD + ISLAND_TO_GRID_GAP + BLUEPRINT_PAD,
    );

    this.boardContainer.setPosition(this.boardOriginX, this.boardOriginY);
    if (this.acidPitContainer) this.acidPitContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.interactiveContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.flowContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.shapeContainer.setPosition(this.boardOriginX, this.boardOriginY);
    if (this.factoryFunnelParticleContainer) this.factoryFunnelParticleContainer.setPosition(this.boardOriginX, this.boardOriginY);
    if (this.borderFunnelParticleContainer)  this.borderFunnelParticleContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.funnelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    if (this.laserContainer) this.laserContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.exteriorContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.shadowContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.borderFunnelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.frameContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.labelContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.bufferMarkerContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.errorContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.placementContainer.setPosition(this.boardOriginX, this.boardOriginY);
    this.drawGridContainer.setPosition(this.drawGridOriginX, this.drawGridOriginY);
    this.paletteContainer.setPosition(this.paletteOriginX, this.paletteOriginY);
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
      board: this.level.board, pxCell: this.pxCell, theme: themeForSectionIdx(0),
    });
    // Acid pits layer into their own container between the floor and the
    // shapes. Returns a {destroy, tick} handle so the cosmetic update loop
    // can re-wobble the perimeter each frame.
    if (this._acidPits) { this._acidPits.destroy(); this._acidPits = null; }
    this._acidPits = renderAcidPits(this, this.acidPitContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    // Buffer funnels (triangles only). Each funnel gets its own pulseWrap
    // centered on the cell so they breathe with the factory funnels. They
    // live in `borderFunnelContainer` (between shadow and frame outline)
    // so they read on top of the inner shadow but under the frame.
    let border;
    if (this._bossMode && this.level.boss && Array.isArray(this.level.boss.rounds)) {
      border = this._renderBossBorderEditor();
    } else {
      border = renderBorder(this, this.boardContainer, this.borderFunnelContainer, this.level, { pxCell: this.pxCell, pxGap: BOARD_GAP });
    }
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
      theme: themeForSectionIdx(0),
    });
    // Pass 3a: inner shadow into shadowContainer (below border funnels).
    renderFrameShadow(this, this.shadowContainer, { board: this.level.board, pxCell: this.pxCell });
    // Pass 3b: frame outline on top of everything board-side.
    renderFrameOutline(this, this.frameContainer, { board: this.level.board, pxCell: this.pxCell });
    // Buffer-funnel labels in their own high-depth container.
    this._renderBorderFunnelLabels();
  }

  // Render every stage's border funnels with stage-colored cell tints. The
  // current stage is fully opaque; other stages render dimmed as read-only
  // locked previews. The authoring `applyBossRoundToWorking` only loads the
  // current stage's border into the working level, so this method also
  // includes other stages' funnels as decorative overlays.
  _renderBossBorderEditor() {
    const rounds = (this.level.boss && this.level.boss.rounds) || [];
    const currentIdx = this._bossStageIdx | 0;
    const keyOf = (f) => `${f.r},${f.c},${f.side},${f.role}`;
    const display = [];
    const stageByKey = new Map();
    // Current stage = what's currently in `this.level.border` (working slots).
    for (const f of ((this.level.border && this.level.border.funnels) || [])) {
      const k = keyOf(f);
      if (stageByKey.has(k)) continue;
      stageByKey.set(k, currentIdx);
      display.push(f);
    }
    for (let i = 0; i < rounds.length; i++) {
      if (i === currentIdx) continue;
      const fs = (rounds[i] && rounds[i].border && rounds[i].border.funnels) || [];
      for (const f of fs) {
        const k = keyOf(f);
        if (stageByKey.has(k)) continue;
        stageByKey.set(k, i);
        display.push(f);
      }
    }
    const getOpts = (f) => {
      const sIdx = stageByKey.get(keyOf(f));
      const isCurrent = sIdx === currentIdx;
      const stageBg = isCurrent ? CURRENT_STAGE_COLOR : stageColor(sIdx != null ? sIdx : 0);
      const alpha = isCurrent ? 1 : (sIdx < currentIdx ? PAST_STAGE_ALPHA : FUTURE_STAGE_ALPHA);
      return { stageBg, stageBgAlpha: CELL_TINT_ALPHA, alpha };
    };
    return renderBorder(this, this.boardContainer, this.borderFunnelContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
      funnels: display,
      getOpts,
    });
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
      invalid: !validity.valid,
      caution: isObstacleFactory(factory.funnels),
    });
    body.setPosition(-cx, -cy);
    // Locked visual: full-cell floor tint below the body so the dim
    // doesn't fade when the body is alpha-reduced. In design mode
    // `factory.locked` carries the authored flag; in blueprintSetup,
    // the session-level `_lockedFactoryIds` Set decides what is locked.
    const isLocked = !!factory.locked ||
      (this._lockedFactoryIds && this._lockedFactoryIds.has(factory.id));
    let tintGfx = null;
    if (isLocked) {
      tintGfx = renderLockedTint(this, this.boardContainer, {
        cells: absCells, pxCell: this.pxCell, pxGap: BOARD_GAP,
      });
      // Dim the body so the dark grid underneath reads through — matches
      // PlayerScene's idle-state dim (the editor has no "play" state here).
      bodyWrap.alpha = 0.65;
    }
    // Flow doesn't pulse — it lives in a separate container without a wrap.
    const flow = renderFlow(this, this.flowContainer, {
      cells: absCells, funnels: absFunnels, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    this.flowUpdaters.push(flow);
    if (!validity.valid) this._paintFactoryError(absCells, validity.error);
    return { bodyWrap, funnelWrap, body, funnels, absCells, tintGfx, locked: isLocked, factoryId: factory.id };
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
    // re-creates them. Same story for any transient particle systems
    // attached to drawGridContainer: destroy them explicitly before the
    // container wipe so their gfx is safely released first.
    this.draftFlow = null;
    if (this.slotFlows) this.slotFlows.length = 0;
    if (this.draftParticles) { this.draftParticles.destroy(); this.draftParticles = null; }
    if (this.slotParticleSystems) {
      for (const s of this.slotParticleSystems) s.destroy();
      this.slotParticleSystems.length = 0;
    }
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

    // Boss-mode: overlay the stage pill strip on the blueprint's top row.
    // No boss levels use row 0 for blueprint slots, so this strip visually
    // claims that row without colliding with author data.
    if (this._bossStagePills) { this._bossStagePills.destroy(); this._bossStagePills = null; }
    if (this._bossMode && this.level.boss && Array.isArray(this.level.boss.rounds)) {
      const currentIdx = this._bossStageIdx | 0;
      const stripHost = this.add.container(0, 0);
      this.drawGridContainer.add(stripHost);
      this._bossStagePills = new StagePillStrip(this, {
        x: 0, y: 0, width: dgW, height: step,
        stageCount: this.level.boss.rounds.length,
        currentIdx,
        hintText: (this.level.instructionalText || ''),
        hintVisible: false,
        parent: stripHost,
        pillsInteractive: true,
        onPillTap: (idx) => this._bossJumpToStage(idx),
      });
    }
  }

  _bossJumpToStage(idx) {
    if (!this._bossMode || !this.level.boss) return;
    if (idx < 0 || idx >= (this.level.boss.rounds || []).length) return;
    if (idx === this._bossStageIdx) return;
    if (typeof this._bossEnterStage === 'function') {
      this._bossEnterStage(idx);
    }
  }

  // Blueprint-setup mode: render every factory currently assigned to a
  // blueprint slot at its slot position with the chosen rotation. Each slot
  // accepts at most one factory (see _blueprintExportReady).
  _renderSlottedFactories() {
    const step = this.drawCellPx;
    if (!this.slotFlows) this.slotFlows = [];
    if (!this.slotParticleSystems) this.slotParticleSystems = [];
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
      // Per-slot funnel particle system — created FIRST so its gfx sits
      // behind the funnel and body in the container's child order. Funnels
      // are given in slot-offset absolute coords so particle origins land
      // on each funnel's actual render position.
      const slotParticles = new FunnelParticleSystem(this, this.drawGridContainer, { pxCell: step });
      slotParticles.setFunnels(
        collectFactoryFunnelsForParticles(cellsAtSlot, funnelsAtSlot, step, 0, SHAPE_SCALE),
      );
      this.slotParticleSystems.push(slotParticles);
      const [cx, cy] = this._factoryCenter(cellsLocal, step, 0);
      const funnelWrap = this.add.container(ox + cx, oy + cy);
      const bodyWrap   = this.add.container(ox + cx, oy + cy);
      this.drawGridContainer.add(funnelWrap);
      this.drawGridContainer.add(bodyWrap);
      const funnels = renderFunnels(this, funnelWrap, funnelsLocal, { pxCell: step, pxGap: 0, scale: SHAPE_SCALE });
      funnels.setPosition(-cx, -cy);
      const body = renderFactoryBody(this, bodyWrap, {
        cells: cellsLocal, pxCell: step, pxGap: 0, scale: SHAPE_SCALE,
        caution: isObstacleFactory(funnelsLocal),
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

  // Build (or rebuild on layout change) the palette bar that occupies the
  // top band of the blueprint area. The PaletteBar instance owns its own
  // graphics inside paletteContainer; we destroy and recreate on layout
  // shifts so width/height come from the latest layout pass.
  _renderPaletteBar() {
    if (!this.paletteContainer) return;
    if (this._paletteBar) { this._paletteBar.destroy(); this._paletteBar = null; }
    this.paletteContainer.removeAll(true);
    this._paletteBar = new PaletteBar(this, this.paletteContainer, {
      width:  this.paletteW,
      height: this.paletteH,
    });
    this._installPaletteHitArea();
  }

  // Transparent hit-rect over the palette pill. Implements a drag-vs-tap
  // state machine so a quick tap opens the popup (re-arm) and a press-and-
  // drag carries the armed tool's ghost out to a drop target. The pointer
  // movement past PALETTE_DRAG_THRESHOLD switches the gesture to a drag;
  // pointerup decides which terminator runs. Scene-level pointermove /
  // pointerup listeners handle the case where the pointer leaves the rect.
  _installPaletteHitArea() {
    if (this._paletteHit) { this._paletteHit.destroy(); this._paletteHit = null; }
    if (this._paletteMoveHandler) this.input.off('pointermove', this._paletteMoveHandler);
    if (this._paletteUpHandler)   this.input.off('pointerup',   this._paletteUpHandler);

    const hit = this.add.rectangle(
      this.paletteOriginX + this.paletteW / 2,
      this.paletteOriginY + this.paletteH / 2,
      this.paletteW,
      this.paletteH,
      0xffffff,
      0.001,
    ).setDepth(53).setInteractive({ useHandCursor: true });

    const PALETTE_DRAG_THRESHOLD = 6;
    this._paletteGesture = null;   // null | { slot, downX, downY, dragStarted }

    hit.on('pointerdown', (p, lx, ly, e) => {
      const slot = this._paletteBar ? this._paletteBar.slotAt(lx, ly) : -1;
      if (slot < 0) return;
      // Undo is tap-only: fire immediately and don't enter gesture state.
      if (slot === SLOT.UNDO) {
        if (e && e.stopPropagation) e.stopPropagation();
        this._undo && this._undo();
        return;
      }
      // Stop the same pointerdown from also reaching scene-level DragController.
      if (e && e.stopPropagation) e.stopPropagation();
      this._paletteGesture = { slot, downX: p.x, downY: p.y, dragStarted: false };
    });

    this._paletteMoveHandler = (p) => {
      const g = this._paletteGesture;
      if (!g) return;
      if (g.dragStarted) {
        this._paletteDragMove(p.x, p.y);
        return;
      }
      const moved = Math.hypot(p.x - g.downX, p.y - g.downY);
      if (moved >= PALETTE_DRAG_THRESHOLD) {
        g.dragStarted = true;
        this._paletteDragStart(g.slot, p.x, p.y);
      }
    };
    this._paletteUpHandler = (p) => {
      const g = this._paletteGesture;
      if (!g) return;
      this._paletteGesture = null;
      if (g.dragStarted) {
        this._paletteDragEnd(p.x, p.y);
      } else {
        this._onPaletteSlotTap(g.slot);
      }
    };
    this.input.on('pointermove', this._paletteMoveHandler);
    this.input.on('pointerup',   this._paletteUpHandler);

    this._paletteHit = hit;
  }

  // Begin a drag of the slot's currently-armed tool. Renders a ghost icon
  // in placementContainer (depth 80) following the pointer — same depth
  // the existing factory-drag uses.
  _paletteDragStart(slotIdx, x, y) {
    if (this._palettePopup) { this._palettePopup.close(); this._palettePopup = null; }
    const toolId = this._paletteBar ? this._paletteBar.getArmed(slotIdx) : null;
    const tool = toolId ? findTool(toolId) : null;
    if (!tool) return;
    this._paletteDrag = { slotIdx, tool };
    // Pickup click — same ui_click the rest of the editor fires when
    // a GameObject is pressed. Keeps the palette feeling tactile when
    // you lift a tool out of its slot.
    playOnce(this.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
    // Fresh ghost graphics — own object so we can reposition cheaply.
    if (this._paletteGhost) { this._paletteGhost.destroy(); this._paletteGhost = null; }
    const g = this.make.graphics({ add: false });
    if (tool.drawIcon) tool.drawIcon(g, 0, 0, Math.max(28, this.pxCell * 0.7));
    g.setDepth(80);
    this.add.existing(g);
    this._paletteGhost = g;
    this._paletteDragMove(x, y);
  }

  _paletteDragMove(x, y) {
    if (this._paletteGhost) {
      this._paletteGhost.x = x;
      this._paletteGhost.y = y;
    }
    this._updatePalettePlacementPreview(x, y, this._paletteDrag && this._paletteDrag.tool);
  }

  _paletteDragEnd(x, y) {
    const drag = this._paletteDrag;
    this._paletteDrag = null;
    this._clearPalettePlacementPreview();
    if (this._paletteGhost) { this._paletteGhost.destroy(); this._paletteGhost = null; }
    if (!drag) return;
    const target = this._paletteHitTest(x, y, drag.tool);
    if (!target) return;
    this._snapshotForUndo();
    const result = applyToolAt(this, drag.tool, target);
    if (result && result.mutated) {
      // Palette-drop SFX:
      //   • Acid-pit targets or tools that CREATE an acid pit → splash.
      //   • Border targets or tools that CREATE a border funnel → metal hit.
      //   • Anything else → plain ui_click so every successful drop
      //     lands with a tactile cue.
      const payload = drag.tool && drag.tool.payload;
      const payloadKind = payload && payload.kind;
      const isAcid = target.kind === 'acidPit' || payloadKind === 'acid';
      const isBorder = target.kind === 'borderFunnel' ||
                       target.kind === 'borderEdge' ||
                       payloadKind === 'borderFunnel';
      if (isAcid) {
        playSfxSound(this.game, 'acid_pit_tap', { volume: 0.5 });
      } else if (isBorder) {
        playSfxSound(this.game, 'border_item_tap', { volume: 0.5 });
      } else {
        playOnce(this.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
      }
      this._persist();
      this._renderAll();
      this._renderDrawGrid();
      this._restartSim();
    }
  }

  // ---------- Pickup drag (acid pit / border funnel) ----------
  //
  // When the user press-drags a board cell that has no factory but does
  // have a pit or border funnel, we lift that piece into a palette-style
  // ghost and re-place via applyToolAt on drop. The original entry is
  // removed up-front so collision checks treat the cell as empty during
  // the move, and is restored if the drop falls on no valid target (or
  // back on the original cell). Snapshot taken at pickup start so undo
  // reverts the entire move; pop the snapshot on cancel so a no-op move
  // doesn't pollute the undo stack.

  _beginPickupDrag(grabR, grabC) {
    // Acid pit?
    const pit = this._acidPitAt(grabR, grabC);
    if (pit) {
      playSfxSound(this.game, 'acid_pit_tap', { volume: 0.5 });
      this._snapshotForUndo();
      this._pickupDrag = {
        kind: 'acidPit',
        toolId: 'board.acid',
        origin: { r: pit.r, c: pit.c, label: pit.label ? { ...pit.label } : null },
        lastX: 0, lastY: 0,
      };
      this.level.acidPits = this.level.acidPits.filter((p) => !(p.r === pit.r && p.c === pit.c));
      this._renderAll();
      this._restartSim();
      this._buildPickupGhost('board.acid');
      this._activateTrashIsland();
      return true;
    }
    // Border funnel?
    const bfArr = (this.level.border && this.level.border.funnels) || [];
    const bf = bfArr.find((f) => f.r === grabR && f.c === grabC);
    if (bf) {
      playSfxSound(this.game, 'border_item_tap', { volume: 0.5 });
      const typedEntry = this._lookupBorderType(bf);
      const toolId =
        bf.role === 'input'   ? 'board.borderInput'   :
        bf.role === 'output'  ? 'board.borderOutput'  :
        bf.role === 'emitter' ? 'board.borderEmitter' :
                                'board.borderCatcher';
      this._snapshotForUndo();
      this._pickupDrag = {
        kind: 'borderFunnel',
        toolId,
        origin: { r: bf.r, c: bf.c, side: bf.side, role: bf.role },
        typedEntry: typedEntry ? { ...typedEntry } : null,
        lastX: 0, lastY: 0,
      };
      this.level.border.funnels = bfArr.filter((f) => !(f.r === bf.r && f.c === bf.c && f.side === bf.side));
      this._removeTypedEntry(bf.r, bf.c, bf.side);
      this._renderAll();
      this._restartSim();
      this._buildPickupGhost(toolId);
      this._activateTrashIsland();
      return true;
    }
    return false;
  }

  // Swap the icon island into the red "DELETE" trash zone for any drag
  // that supports island-drop deletion (factory, draft, or pickup). Tears
  // down the per-slot interactive hit rects so the underlying buttons
  // can't fire mid-drag. Counterpart: _deactivateTrashIsland().
  _activateTrashIsland() {
    this._factoryDragActive = true;
    if (this.iconSlotHits) {
      for (const h of this.iconSlotHits) h.destroy();
      this.iconSlotHits = null;
    }
    this._renderIconIsland();
  }
  _deactivateTrashIsland() {
    if (!this._factoryDragActive) return;
    this._factoryDragActive = false;
    this._renderIconIsland();
    this._setupIconSlotHandlers();
  }

  _buildPickupGhost(toolId) {
    if (this._paletteGhost) { this._paletteGhost.destroy(); this._paletteGhost = null; }
    const tool = findTool(toolId);
    if (!tool || !tool.drawIcon) return;
    const g = this.make.graphics({ add: false });
    tool.drawIcon(g, 0, 0, Math.max(28, this.pxCell * 0.7));
    g.setDepth(80);
    this.add.existing(g);
    this._paletteGhost = g;
  }

  _endPickupDrag() {
    const pickup = this._pickupDrag;
    this._pickupDrag = null;
    this._clearPalettePlacementPreview();
    if (this._paletteGhost) { this._paletteGhost.destroy(); this._paletteGhost = null; }
    if (!pickup) { this._deactivateTrashIsland(); return; }

    // Prefer the live pointer position so a quick release after the last
    // pointermove doesn't fall back to a slightly stale coord.
    const pointer = this.input.activePointer;
    const px = pointer ? pointer.x : pickup.lastX;
    const py = pointer ? pointer.y : pickup.lastY;

    // Drop on the trash island → delete the picked-up piece. The start
    // already removed it from level state, so we just keep that removal
    // and persist. Pickup-start snapshot is kept so undo restores it.
    if (this._iconSlotAt(px, py)) {
      // Rustle (no click) — same delete cue as factory/draft deletes.
      playOnce(this.game, 'click_empty', { throttleMs: 60, volume: 0.22 });
      spawnEmptyClickParticles(this, px, py);
      this._deactivateTrashIsland();
      this._persist();
      this._renderAll();
      this._restartSim();
      return;
    }

    const tool = findTool(pickup.toolId);
    const target = tool ? this._paletteHitTest(px, py, tool) : null;

    // Drop on the original location, off-target, or no target → restore
    // the picked-up item and discard the pickup-start snapshot so the
    // undo stack stays clean.
    const sameOrigin = target && this._pickupTargetMatchesOrigin(pickup, target);
    if (!target || sameOrigin) {
      this._restorePickup(pickup);
      this._renderAll();
      this._restartSim();
      this._deactivateTrashIsland();
      if (this._undoStack) this._undoStack.pop();
      return;
    }

    const result = applyToolAt(this, tool, target);
    if (!result || !result.mutated) {
      this._restorePickup(pickup);
      this._renderAll();
      this._restartSim();
      this._deactivateTrashIsland();
      if (this._undoStack) this._undoStack.pop();
      return;
    }
    // applyTool seeds default properties (acid: untyped, border funnel:
    // DEFAULT_SHAPE_TYPE). Reapply the picked-up item's original label /
    // typed entry so the move preserves what the user had configured.
    this._reapplyPickupProperties(pickup, target);
    this._persist();
    this._renderAll();
    this._restartSim();
    this._deactivateTrashIsland();
  }

  _pickupTargetMatchesOrigin(pickup, target) {
    if (pickup.kind === 'acidPit') {
      return target.kind === 'boardCell'
        && target.r === pickup.origin.r
        && target.c === pickup.origin.c;
    }
    if (pickup.kind === 'borderFunnel') {
      return target.kind === 'borderEdge'
        && target.r === pickup.origin.r
        && target.c === pickup.origin.c
        && target.side === pickup.origin.side;
    }
    return false;
  }

  _restorePickup(pickup) {
    if (pickup.kind === 'acidPit') {
      if (!Array.isArray(this.level.acidPits)) this.level.acidPits = [];
      const entry = { r: pickup.origin.r, c: pickup.origin.c };
      if (pickup.origin.label) entry.label = { ...pickup.origin.label };
      this.level.acidPits.push(entry);
    } else if (pickup.kind === 'borderFunnel') {
      if (!this.level.border) this.level.border = { funnels: [] };
      this.level.border.funnels.push({
        r: pickup.origin.r, c: pickup.origin.c,
        side: pickup.origin.side, role: pickup.origin.role,
      });
      if (pickup.typedEntry && (pickup.origin.role === 'input' || pickup.origin.role === 'output')) {
        const key = pickup.origin.role === 'output' ? 'outputs' : 'inputs';
        if (!Array.isArray(this.level[key])) this.level[key] = [];
        this.level[key].push({
          r: pickup.origin.r, c: pickup.origin.c, side: pickup.origin.side,
          type: { ...pickup.typedEntry },
        });
      }
    }
  }

  _reapplyPickupProperties(pickup, target) {
    if (pickup.kind === 'acidPit' && pickup.origin.label) {
      const pit = this._acidPitAt(target.r, target.c);
      if (pit) pit.label = { ...pickup.origin.label };
    } else if (pickup.kind === 'borderFunnel'
               && pickup.typedEntry
               && (pickup.origin.role === 'input' || pickup.origin.role === 'output')) {
      const key = pickup.origin.role === 'output' ? 'outputs' : 'inputs';
      if (!Array.isArray(this.level[key])) this.level[key] = [];
      const idx = this.level[key].findIndex((e) =>
        e.r === target.r && e.c === target.c && e.side === target.side);
      const entry = {
        r: target.r, c: target.c, side: target.side,
        type: { ...pickup.typedEntry },
      };
      if (idx < 0) this.level[key].push(entry);
      else         this.level[key][idx] = entry;
    }
  }

  // Resolve where in the editor a pointer landed for drop-dispatch. Tool
  // category determines the target priority:
  //   FACTORY  → cells (board interior, composer)
  //   FUNNEL   → factory perimeter edges (board placed factory, composer
  //              draft); does NOT drop on border edges (those use the
  //              dedicated Board pieces tools)
  //   BOARD    → varies by tool: acid pit on interior cells; border funnel
  //              variants on border edges
  //   LABEL    → factory cells (board factory cell, composer draft cell)
  //   TRASH    → smart resolution (wired in task 6)
  _paletteHitTest(x, y, tool) {
    if (!tool) {
      const boardCell = this._boardCellAt(x, y);
      if (boardCell) return { kind: 'boardCell', r: boardCell.r, c: boardCell.c };
      const draftCell = this._drawGridCellAt(x, y);
      if (draftCell) return { kind: 'composerCell', r: draftCell.r, c: draftCell.c };
      return null;
    }
    const slot = tool.category;
    if (slot === SLOT.FACTORY) {
      const boardCell = this._boardCellAt(x, y);
      if (boardCell) return { kind: 'boardCell', r: boardCell.r, c: boardCell.c };
      const draftCell = this._drawGridCellAt(x, y);
      if (draftCell) return { kind: 'composerCell', r: draftCell.r, c: draftCell.c };
      return null;
    }
    if (slot === SLOT.FUNNEL) {
      // Wide midpoint-snap (within one cell of any valid edge midpoint) so
      // the user doesn't need pixel-precision dropping on a perimeter strip.
      const factSnap  = this._snapFactoryEdge(x, y, this.pxCell);
      const draftSnap = this._snapComposerEdge(x, y, this.drawCellPx);
      // Take whichever is closer when both are in range — preserves intent
      // when the pointer hovers near the seam between board and composer.
      if (factSnap && (!draftSnap || factSnap.dist <= draftSnap.dist)) {
        return { kind: 'factoryEdge', factoryId: factSnap.factoryId, r: factSnap.r, c: factSnap.c, side: factSnap.side };
      }
      if (draftSnap) {
        return { kind: 'composerEdge', r: draftSnap.r, c: draftSnap.c, side: draftSnap.side };
      }
      return null;
    }
    if (slot === SLOT.BOARD_PIECE) {
      const isAcid = tool.payload && tool.payload.kind === 'acid';
      if (isAcid) {
        const boardCell = this._boardCellAt(x, y);
        if (boardCell) return { kind: 'boardCell', r: boardCell.r, c: boardCell.c };
        return null;
      }
      const borderSnap = this._snapBorderEdge(x, y, this.pxCell);
      if (borderSnap) {
        return { kind: 'borderEdge', r: borderSnap.r, c: borderSnap.c, side: borderSnap.side };
      }
      return null;
    }
    if (slot === SLOT.TRASH) {
      // Edges first (most specific). Snap distance matches the palette-
      // funnel snap so dropping near an edge midpoint is forgiving.
      const factSnap = this._snapFactoryEdge(x, y, this.pxCell);
      const draftSnap = this._snapComposerEdge(x, y, this.drawCellPx);
      const borderSnap = this._snapBorderEdge(x, y, this.pxCell);
      // Edge candidates only count if there's actually a funnel on them
      // (no point trashing an empty edge). Pick whichever in-range edge
      // has an actual funnel, with the closer one winning.
      const candidates = [];
      if (factSnap) {
        const fac = this.level.factories.find((f) => f.id === factSnap.factoryId);
        if (fac && (fac.funnels || []).some((f) => (f.r + fac.anchor.row) === factSnap.r && (f.c + fac.anchor.col) === factSnap.c && f.side === factSnap.side)) {
          candidates.push({ d: factSnap.dist, t: { kind: 'factoryEdge', factoryId: factSnap.factoryId, r: factSnap.r, c: factSnap.c, side: factSnap.side } });
        }
      }
      if (borderSnap) {
        const bfArr = (this.level.border && this.level.border.funnels) || [];
        if (bfArr.some((f) => f.r === borderSnap.r && f.c === borderSnap.c && f.side === borderSnap.side)) {
          candidates.push({ d: borderSnap.dist, t: { kind: 'borderEdge', r: borderSnap.r, c: borderSnap.c, side: borderSnap.side } });
        }
      }
      if (draftSnap) {
        if ((this.draftFunnels || []).some((f) => f.r === draftSnap.r && f.c === draftSnap.c && f.side === draftSnap.side)) {
          candidates.push({ d: draftSnap.dist, t: { kind: 'composerEdge', r: draftSnap.r, c: draftSnap.c, side: draftSnap.side } });
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.d - b.d);
        return candidates[0].t;
      }
      // No edge hit → cells. Try board first, then composer.
      const boardCell = this._boardCellAt(x, y);
      if (boardCell) {
        const fac = this._factoryAtBoardCell(boardCell.r, boardCell.c);
        if (fac) return { kind: 'factoryCell', factoryId: fac.id, r: boardCell.r, c: boardCell.c };
        const pit = this._acidPitAt(boardCell.r, boardCell.c);
        if (pit) return { kind: 'acidPit', r: boardCell.r, c: boardCell.c };
        const bfArr = (this.level.border && this.level.border.funnels) || [];
        const bf = bfArr.find((f) => f.r === boardCell.r && f.c === boardCell.c);
        if (bf) return { kind: 'borderFunnel', r: bf.r, c: bf.c, side: bf.side, role: bf.role };
      }
      const draftCell = this._drawGridCellAt(x, y);
      if (draftCell && this._isDraftCell(draftCell.r, draftCell.c)) {
        return { kind: 'composerCell', r: draftCell.r, c: draftCell.c };
      }
      return null;
    }
    if (slot === SLOT.LABEL) {
      const boardCell = this._boardCellAt(x, y);
      if (boardCell) {
        const fac = this._factoryAtBoardCell(boardCell.r, boardCell.c);
        if (fac) return { kind: 'factoryCell', factoryId: fac.id, r: boardCell.r, c: boardCell.c };
        // Acid pit on this cell — labelable; only the color is honored.
        const pit = this._acidPitAt(boardCell.r, boardCell.c);
        if (pit) return { kind: 'acidPit', r: boardCell.r, c: boardCell.c };
        // Border funnel on this cell — labels apply to the typed entry
        // (level.inputs / level.outputs). Emitter / collector are laser
        // entities and don't carry labels; the apply branch rejects them.
        const borderFunnels = (this.level.border && this.level.border.funnels) || [];
        const bf = borderFunnels.find((f) => f.r === boardCell.r && f.c === boardCell.c);
        if (bf) return { kind: 'borderFunnel', r: bf.r, c: bf.c, side: bf.side, role: bf.role };
      }
      const draftCell = this._drawGridCellAt(x, y);
      if (draftCell && this._isDraftCell(draftCell.r, draftCell.c)) {
        return { kind: 'composerCell', r: draftCell.r, c: draftCell.c };
      }
      return null;
    }
    return null;
  }

  // ---------- Wide midpoint-snap helpers (palette drag only) ----------
  //
  // The narrow `_factoryEdgeAt` / `_borderEdgeAt` / `_draftEdgeAt` require
  // the pointer to land inside the actual edge strip. For palette drags
  // that's punishingly precise — the user wants to drop "near" an edge
  // and have the funnel snap to the closest one. These helpers iterate
  // every valid edge, compute its midpoint in scene coords, and return
  // the nearest whose midpoint is within `maxDist`. Returns null if
  // nothing is in range.

  _snapFactoryEdge(px, py, maxDist) {
    let best = null;
    let bestD2 = maxDist * maxDist;
    const step = this.pxCell + BOARD_GAP;
    for (const fac of this.level.factories) {
      for (const cc of fac.cells) {
        const absR = fac.anchor.row + cc.r;
        const absC = fac.anchor.col + cc.c;
        const cellX = this.boardOriginX + absC * step;
        const cellY = this.boardOriginY + absR * step;
        for (const side of EDGE_SIDES) {
          if (!isPerimeterEdge(fac.cells, cc.r, cc.c, side)) continue;
          const [mx, my] = _edgeMidpoint(cellX, cellY, this.pxCell, side);
          const dx = px - mx, dy = py - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = { factoryId: fac.id, r: absR, c: absC, side, dist: Math.sqrt(d2) };
          }
        }
      }
    }
    return best;
  }

  _snapBorderEdge(px, py, maxDist) {
    let best = null;
    let bestD2 = maxDist * maxDist;
    const step = this.pxCell + BOARD_GAP;
    const board = this.level.board;
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (!isBorderCell(board, r, c)) continue;
        const side = innerSideOf(board, r, c);
        if (!side) continue;
        const cellX = this.boardOriginX + c * step;
        const cellY = this.boardOriginY + r * step;
        const [mx, my] = _edgeMidpoint(cellX, cellY, this.pxCell, side);
        const dx = px - mx, dy = py - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { r, c, side, dist: Math.sqrt(d2) };
        }
      }
    }
    return best;
  }

  _snapComposerEdge(px, py, maxDist) {
    if (!this.draftCells || this.draftCells.length === 0) return null;
    let best = null;
    let bestD2 = maxDist * maxDist;
    const step = this.drawCellPx;
    for (const cc of this.draftCells) {
      const cellX = this.drawGridOriginX + cc.c * step;
      const cellY = this.drawGridOriginY + cc.r * step;
      for (const side of EDGE_SIDES) {
        if (!isPerimeterEdge(this.draftCells, cc.r, cc.c, side)) continue;
        const [mx, my] = _edgeMidpoint(cellX, cellY, step, side);
        const dx = px - mx, dy = py - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { r: cc.r, c: cc.c, side, dist: Math.sqrt(d2) };
        }
      }
    }
    return best;
  }

  // Factory perimeter edge under (px, py). Returns the absolute board
  // (r, c, side) of the edge plus the owning factoryId, or null. The
  // pointer must be inside a board cell that's part of a factory AND
  // within the edge's hitbox AND the side must be on the factory's
  // perimeter (not an internal seam between two cells of the same factory).
  _factoryEdgeAt(px, py) {
    const cell = this._boardCellAt(px, py);
    if (!cell) return null;
    const fac = this._factoryAtBoardCell(cell.r, cell.c);
    if (!fac) return null;
    // Convert to factory-relative coords for isPerimeterEdge.
    const relR = cell.r - fac.anchor.row;
    const relC = cell.c - fac.anchor.col;
    const lx = px - this.boardOriginX - cell.c * (this.pxCell + BOARD_GAP);
    const ly = py - this.boardOriginY - cell.r * (this.pxCell + BOARD_GAP);
    const T = Math.min(Math.floor(this.pxCell / 2), 24);
    let chosen = null;
    if      (ly <= T)                  chosen = 'top';
    else if (ly >= this.pxCell - T)    chosen = 'bottom';
    else if (lx <= T)                  chosen = 'left';
    else if (lx >= this.pxCell - T)    chosen = 'right';
    if (!chosen) return null;
    if (!isPerimeterEdge(fac.cells, relR, relC, chosen)) return null;
    return { factoryId: fac.id, r: cell.r, c: cell.c, side: chosen };
  }

  // Light blue placement indicator at the would-place target. Renders
  // into placementContainer (depth 80, anchored at boardOrigin). Cells
  // get a rect outline; edges get a thick stripe along the chosen side.
  // For composer / draft targets, coords are offset from board origin to
  // the draw grid's origin so a single container works for both areas.
  _updatePalettePlacementPreview(x, y, tool) {
    if (!this.placementContainer) return;
    this.placementContainer.removeAll(true);
    const target = this._paletteHitTest(x, y, tool);
    if (!target) return;
    const g = this.make.graphics({ add: false });
    // Trash drag uses red so the user reads it as a deletion preview;
    // every other tool uses the placement-blue.
    const isTrash = tool && tool.category === SLOT.TRASH;
    const previewColor = isTrash ? 0xff4040 : 0x4cb1ff;
    g.lineStyle(3, previewColor, 0.9);
    const offX = this.drawGridOriginX - this.boardOriginX;
    const offY = this.drawGridOriginY - this.boardOriginY;

    if (target.kind === 'boardCell' || target.kind === 'factoryCell' || target.kind === 'acidPit') {
      const step = this.pxCell + BOARD_GAP;
      g.strokeRect(target.c * step + 1, target.r * step + 1, this.pxCell - 2, this.pxCell - 2);
    } else if (target.kind === 'borderFunnel') {
      const step = this.pxCell + BOARD_GAP;
      g.strokeRect(target.c * step + 1, target.r * step + 1, this.pxCell - 2, this.pxCell - 2);
    } else if (target.kind === 'composerCell') {
      const step = this.drawCellPx;
      g.strokeRect(offX + target.c * step + 1, offY + target.r * step + 1, step - 2, step - 2);
    } else if (target.kind === 'borderEdge' || target.kind === 'factoryEdge') {
      const step = this.pxCell + BOARD_GAP;
      this._strokeEdgeMarker(g, target.c * step, target.r * step, this.pxCell, target.side);
    } else if (target.kind === 'composerEdge') {
      const step = this.drawCellPx;
      this._strokeEdgeMarker(g, offX + target.c * step, offY + target.r * step, step, target.side);
    }
    this.placementContainer.add(g);
  }

  // Thick blue stripe along the chosen side of a cell rect (cellX, cellY,
  // size). Used by the palette placement preview to mark a funnel edge.
  _strokeEdgeMarker(g, cellX, cellY, size, side) {
    const inset = 4;
    if (side === 'top') {
      g.strokeLineShape(new Phaser.Geom.Line(cellX + inset, cellY + 2, cellX + size - inset, cellY + 2));
    } else if (side === 'bottom') {
      g.strokeLineShape(new Phaser.Geom.Line(cellX + inset, cellY + size - 2, cellX + size - inset, cellY + size - 2));
    } else if (side === 'left') {
      g.strokeLineShape(new Phaser.Geom.Line(cellX + 2, cellY + inset, cellX + 2, cellY + size - inset));
    } else if (side === 'right') {
      g.strokeLineShape(new Phaser.Geom.Line(cellX + size - 2, cellY + inset, cellX + size - 2, cellY + size - inset));
    }
  }

  _clearPalettePlacementPreview() {
    if (this.placementContainer) this.placementContainer.removeAll(true);
  }

  // Open the popup for a multi-option slot, or run the slot's tap action
  // for single-option slots:
  //   UNDO    → undo last mutation (no popup)
  //   FACTORY → no-op (single option; only drag is meaningful)
  //   TRASH   → no-op (single option; only drag is meaningful)
  //
  // For multi-option slots, the popup OPEN is deferred by one double-click
  // window. A second tap on the same slot within the window cancels the
  // open and cycles to the next armed tool — so there's no popup flash on
  // a quick double-click. After the window elapses with no second tap, the
  // popup opens. The wired onShieldTap path stays as a redundant cycle
  // mechanism (tap origin slot again while popup is open).
  _onPaletteSlotTap(slotIdx) {
    if (slotIdx === SLOT.UNDO) {
      this._undo && this._undo();
      return;
    }
    if (slotIdx === SLOT.HELP) {
      this._openHelpModal();
      return;
    }
    // Single-option categories — no dropdown, no cycle. Tap is a no-op;
    // the user interacts via drag only.
    if (slotIdx === SLOT.FACTORY || slotIdx === SLOT.TRASH) return;

    const DOUBLE_TAP_MS = 250;
    // Second tap on the SAME slot inside the window → cycle, suppress popup.
    if (this._pendingPaletteTap && this._pendingPaletteTap.slot === slotIdx) {
      this._pendingPaletteTap.timer.remove(false);
      this._pendingPaletteTap = null;
      this._cyclePaletteSlot(slotIdx);
      return;
    }
    // First tap (or different slot) → cancel any pending, schedule open.
    if (this._pendingPaletteTap) {
      this._pendingPaletteTap.timer.remove(false);
      this._pendingPaletteTap = null;
    }
    const timer = this.time.delayedCall(DOUBLE_TAP_MS, () => {
      this._pendingPaletteTap = null;
      this._openPaletteSlotPopup(slotIdx);
    });
    this._pendingPaletteTap = { slot: slotIdx, timer };
  }

  // Actual popup-open path. Separated from _onPaletteSlotTap so the
  // deferred timer (above) and any future direct callers can both hit it
  // without re-running the double-tap detection.
  _openPaletteSlotPopup(slotIdx) {
    if (this._palettePopup) { this._palettePopup.close(); this._palettePopup = null; }
    const options = TOOLS_BY_SLOT[slotIdx] || [];
    if (options.length === 0) return;
    const layout = slotIdx === SLOT.LABEL ? 'labels' : 'row';
    const center = this._paletteBar ? this._paletteBar.slotCenter(slotIdx) : { x: 0, y: 0 };
    // Anchor at the BOTTOM of the slot so the popup drops down from there.
    const slotBottom = this._paletteBar ? this._paletteBar.bottomY() : this.paletteH;
    const anchor = {
      x: this.paletteOriginX + center.x,
      y: this.paletteOriginY + slotBottom,
    };
    const slotSize = this._paletteBar ? this._paletteBar.slotSize() : { w: this.paletteW / 6, h: this.paletteH };
    const selectedId = this._paletteBar ? this._paletteBar.getArmed(slotIdx) : null;
    // Screen-space rect of the originating slot — used by onShieldTap to
    // detect a "tap origin slot again" gesture (= cycle to next option).
    const slotRect = {
      x: this.paletteOriginX + center.x - slotSize.w / 2,
      y: this.paletteOriginY + center.y - slotSize.h / 2,
      w: slotSize.w,
      h: slotSize.h,
    };
    // Cycle-via-shield only counts within this window after the popup
    // opens. A click on the origin slot AFTER this window has elapsed is
    // treated as an ordinary dismissal — long pauses between clicks are
    // not a double-click.
    const SHIELD_CYCLE_WINDOW_MS = 500;
    const popupOpenedAt = this.time.now;
    this._palettePopup = new PalettePopup(this, {
      anchor,
      slotSize,
      layout,
      options,
      selectedId,
      onPick: (toolId) => {
        if (this._paletteBar) this._paletteBar.setArmed(slotIdx, toolId);
      },
      onShieldTap: (x, y) => {
        if (this.time.now - popupOpenedAt > SHIELD_CYCLE_WINDOW_MS) return;
        if (x >= slotRect.x && x < slotRect.x + slotRect.w &&
            y >= slotRect.y && y < slotRect.y + slotRect.h) {
          this._cyclePaletteSlot(slotIdx);
        }
      },
      onClose: () => {
        this._palettePopup = null;
      },
    });
  }

  // Open the click-through help modal. Single instance — re-opening
  // dismisses any pending palette popup so the modal isn't trapped
  // behind another overlay.
  _openHelpModal() {
    if (this._helpModal) { this._helpModal.close(); this._helpModal = null; }
    if (this._palettePopup) { this._palettePopup.close(); this._palettePopup = null; }
    this._helpModal = new HelpModal(this, {
      bossMode: !!this._bossMode,
      onClose: () => { this._helpModal = null; },
    });
  }

  // Confirm-then-reset the editor. The modal explains the destructive
  // action; YES wipes all factories / acid pits / border funnels / typed
  // entries / draft / blueprint assignments and reseeds the level with a
  // fresh sandbox-style default funnel pair (one input top-center, one
  // output bottom-center). Snapshots BEFORE the wipe so undo restores.
  _openStartOverConfirm() {
    if (this._confirmModal) { this._confirmModal.close(); this._confirmModal = null; }
    if (this._palettePopup) { this._palettePopup.close(); this._palettePopup = null; }
    this._confirmModal = new ConfirmModal(this, {
      title: 'Start over?',
      body:  'This wipes the entire level — every factory, label, acid pit, and border piece. The undo button can bring it back.',
      confirmLabel: 'START OVER',
      cancelLabel:  'CANCEL',
      danger: true,
      onConfirm: () => this._resetLevelToDefault(),
      onClose:   () => { this._confirmModal = null; },
    });
  }

  _resetLevelToDefault() {
    this._snapshotForUndo();
    // Preserve the current board size so the user doesn't lose their
    // resize choice — only the level CONTENTS are wiped, not its shape.
    const dim = (this.level && this.level.board && this.level.board.rows) || 6;
    this.level.factories = [];
    this.level.initialFactories = [];
    this.level.lockedFactories = [];
    this.level.acidPits = [];
    this.level.border = { funnels: [] };
    this.level.inputs = [];
    this.level.outputs = [];
    seedDefaultFunnels(this.level);
    // Local editor state.
    this.draftCells = [];
    this.draftFunnels = [];
    this._blueprintAssignments = new Map();
    this._lockedFactoryIds = new Set();
    this._mode = 'design';
    this._persist();
    this._renderAll();
    this._renderDrawGrid();
    this._restartSim();
    void dim;   // referenced for readability above; nothing else uses it
  }

  // Advance the slot's armed tool to the next option in TOOLS_BY_SLOT,
  // wrapping around. Single-option slots no-op.
  _cyclePaletteSlot(slotIdx) {
    const options = TOOLS_BY_SLOT[slotIdx] || [];
    if (options.length <= 1 || !this._paletteBar) return;
    const currentId = this._paletteBar.getArmed(slotIdx);
    const idx = options.findIndex((t) => t.id === currentId);
    const next = options[(idx + 1) % options.length];
    if (next) this._paletteBar.setArmed(slotIdx, next.id);
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

    // Drag-active mode: replace the whole island with a red drop zone
    // that just says "DELETE" in big bold letters, centered. Used for
    // factory drags, draft drags, and pickup drags (acid pit / border
    // funnel). Hit-testing is _iconSlotAt (any slot in the island).
    if (this._factoryDragActive) {
      const dropFrame = this.make.graphics({ add: false });
      dropFrame.fillStyle(0xa01818, 1);
      dropFrame.lineStyle(3, 0xffffff, 1);
      dropFrame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
      dropFrame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
      this.iconIslandContainer.add(dropFrame);
      // Use container-local coords — iconIslandContainer is already
      // positioned at iconIslandOriginX/Y, so the children just need
      // local 0..islandW / 0..islandH coordinates.
      const fontPx = Math.max(20, Math.round(islandH * 0.55));
      const label = this.add.text(
        islandW / 2,
        islandH / 2,
        'DELETE',
        {
          fontFamily: 'system-ui, sans-serif',
          fontSize: `${fontPx}px`,
          fontStyle: 'bold',
          color: '#ffffff',
        },
      ).setOrigin(0.5);
      this.iconIslandContainer.add(label);
      return;
    }

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
    addGlyph(SLOT_HOME,       drawHome);
    addGlyph(SLOT_START_OVER, drawTrash);
    addGlyph(SLOT_SHRINK,     drawMinus);
    addGlyph(SLOT_GROW,       drawPlus);
    addGlyph(SLOT_GEAR,       drawGear);
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

    // Ambient funnel particles — created FIRST so the gfx lands at the
    // back of drawGridContainer's child list (behind the funnel triangles).
    this.draftParticles = new FunnelParticleSystem(this, this.drawGridContainer, { pxCell: this.drawCellPx });
    this.draftParticles.setFunnels(
      collectFactoryFunnelsForParticles(this.draftCells, this.draftFunnels, this.drawCellPx, 0, SHAPE_SCALE),
    );

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
      caution: isObstacleFactory(this.draftFunnels),
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
    if (border) {
      // If the border edge already has a funnel, route the gesture to
      // the CELL path instead so press-drag can pick the funnel up. The
      // edge path only fires on bare border cells (no funnel yet) — but
      // those are now placed via the palette anyway, so the edge path's
      // legacy tap-to-cycle behavior is effectively a no-op outside of
      // backwards compatibility.
      const funnels = (this.level && this.level.border && this.level.border.funnels) || [];
      const occupied = funnels.some((f) => f.r === border.r && f.c === border.c && f.side === border.side);
      if (!occupied) return { ...border, kind: 'border' };
      // Fall through to draft-edge / null below.
    }
    // The buffer-label square next to each existing border funnel also acts
    // as a click target — easier to hit than the narrow edge strip. Only
    // triggers for already-placed funnels (empty buffer edges have no label).
    // SKIP it now too — picking up the funnel via cell-drag is the new path.
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

  // Blueprint-setup-only: click a board factory to pin it to the play area
  // (locked) or undo the pin. Locked factories skip the blueprint entirely
  // at play time — exported as `lockedFactories` — so the play-time chrome
  // renders them with a darkened floor and a dimmed body. A factory
  // assigned to a blueprint slot can't also be locked; tapping in that
  // case is a no-op so we don't silently clobber the slot assignment.
  _toggleLockAtBoardCell(r, c) {
    if (this._mode !== 'blueprintSetup') return;
    const fac = this._factoryAtBoardCell(r, c);
    if (!fac) return;
    // Boss mode: carry-over factories from earlier stages are permanently
    // locked — tapping them should do nothing.
    if (this._bossMode && fac.locked) return;
    if (this._blueprintAssignments.has(fac.id)) return;
    if (this._lockedFactoryIds.has(fac.id)) {
      this._lockedFactoryIds.delete(fac.id);
    } else {
      this._lockedFactoryIds.add(fac.id);
    }
    this._renderAll();
    this._renderIconIsland();
    this._refreshSteps();
  }

  // ===================================================================
  //   Gesture handlers
  // ===================================================================

  _onToggleCell(info) {
    if (!info) return;
    if (this._mode === 'blueprintSetup') {
      // Setup-mode taps:
      //   • Slot tap → rotate the factory assigned there.
      //   • Board tap → toggle the locked state of the factory under
      //     the pointer. A locked factory stays on the play area at
      //     play time (exported as `lockedFactories`) instead of
      //     starting in the blueprint. Tap again to unlock.
      if (info.kind === 'draft') {
        const a = this._findAssignmentAt(info.r, info.c);
        if (a) this._rotateSlotted(a.factoryId);
      } else if (info.kind === 'board') {
        this._toggleLockAtBoardCell(info.r, info.c);
      }
      return;
    }
    if (info.kind === 'draft') {
      // Tap on a draft cell → rotate the whole draft 90° CW around the
      // tapped cell. Tap on an empty composer cell that's a valid factory
      // position (adjacent to existing draft, or first cell anywhere) →
      // add a factory block there.
      if (this._isDraftCell(info.r, info.c)) {
        this._rotateDraftAround(info.r, info.c);
        return;
      }
      this._tryQuickAddFactory({ kind: 'composerCell', r: info.r, c: info.c });
      return;
    } else if (info.kind === 'board') {
      // Tap on a placed factory's cell → rotate the factory 90° CW. Tap
      // on an empty interior board cell that's a valid factory position
      // → add a factory block there. Other taps (acid pits, border
      // funnels, occupied cells) remain no-ops.
      const hit = this.level.factories.find((fac) =>
        fac.cells.some((cc) => fac.anchor.row + cc.r === info.r && fac.anchor.col + cc.c === info.c),
      );
      if (hit) { this._rotatePlacedFactory(hit); return; }
      this._tryQuickAddFactory({ kind: 'boardCell', r: info.r, c: info.c });
    }
  }

  // Click-to-place shortcut for the Factory tool — runs the same applyTool
  // dispatch a drag-end would run, snapshotting for undo and re-rendering
  // on success. No-op if applyTool rejects (occupied / invalid target).
  _tryQuickAddFactory(target) {
    const tool = findTool('factory.block');
    if (!tool) return;
    this._snapshotForUndo();
    const result = applyToolAt(this, tool, target);
    if (result && result.mutated) {
      this._persist();
      this._renderAll();
      this._renderDrawGrid();
      this._restartSim();
    } else if (this._undoStack) {
      // No mutation — discard the snapshot so the undo stack stays clean.
      this._undoStack.pop();
    }
  }

  // Rotate a board-placed factory 90° CW, snapshotting for undo first.
  // The rotation pivots around the factory's existing anchor — bounds
  // and overlap checks aren't enforced (the rotation is purely geometric);
  // if the rotated footprint spills off-board or collides with another
  // piece the user can drag it back into place or undo.
  _rotatePlacedFactory(factory) {
    if (factory.locked) return;
    this._snapshotForUndo();
    const rot = rotateFactoryShape({ cells: factory.cells, funnels: factory.funnels || [] }, 1);
    factory.cells = rot.cells;
    factory.funnels = rot.funnels;
    this._persist();
    this._renderAll();
    this._restartSim();
  }

  // Rotate the entire draft 90° CW around (pivotR, pivotC). Cells preserve
  // their label / bolt attributes; funnels rotate sides via SIDE_ROTATE_CW.
  // Cells that spill outside the draw grid are allowed (the user can rotate
  // partly off the blueprint), but the rotation is rejected if EVERY cell
  // would land off-grid — at least one cell has to stay visible / on the
  // blueprint so the user can keep manipulating the draft.
  _rotateDraftAround(pivotR, pivotC) {
    if (!Array.isArray(this.draftCells) || this.draftCells.length === 0) return;
    const SIDE_CW = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };
    // Visual CW in screen coords: (dr, dc) → (dc, -dr).
    const newCells = this.draftCells.map((cc) => {
      const dr = cc.r - pivotR, dc = cc.c - pivotC;
      return { ...cc, r: pivotR + dc, c: pivotC - dr };
    });
    const anyInside = newCells.some(
      (cc) => cc.r >= 0 && cc.c >= 0 && cc.r < this.drawGridRows && cc.c < this.drawGridCols,
    );
    if (!anyInside) return;
    const newFunnels = (this.draftFunnels || []).map((f) => {
      const dr = f.r - pivotR, dc = f.c - pivotC;
      return { ...f, r: pivotR + dc, c: pivotC - dr, side: SIDE_CW[f.side] || f.side };
    });
    this._snapshotForUndo();
    this.draftCells = newCells;
    this.draftFunnels = newFunnels;
    this._persist();
    this._renderDrawGrid();
  }

  // ===================================================================
  //   Acid pits
  // ===================================================================

  _acidPitAt(r, c) {
    const pits = (this.level && this.level.acidPits) || [];
    return pits.find((p) => p.r === r && p.c === c) || null;
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

  _onToggleFunnel(_info) {
    // No-op in the palette-drag model — funnel placement and editing
    // happen via the Funnels palette (factory edges) and the Board pieces
    // palette (border edges). Tap-to-cycle on edges is retired.
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
      // Snapshot BEFORE the drag mutates anything so undo can revert any
      // successful drop (place-on-board, move-to-draft, delete-zone) back
      // to this exact pre-drag state. Popped on cancel via _cancelDrag.
      this._snapshotForUndo();
    } else if (kind === 'board') {
      const factory = this._factoryAtBoardCell(grabR, grabC);
      if (factory) {
        source = 'board';
        origFactory = factory;
        grab  = { r: grabR - factory.anchor.row, c: grabC - factory.anchor.col };
        shape = { cells: factory.cells, funnels: factory.funnels || [], converter: factory.converter };
        // Snapshot WITH the factory still on the level — drag start
        // removes it next, but we want undo to put it back at the
        // original anchor regardless of how the drag ends.
        this._snapshotForUndo();
        // Remove from the level so placement validity and rendering reflect
        // that the factory is "in hand". Sim restarts so it stops emitting
        // from this factory's funnels. Restored on drag cancel.
        this.level.factories = this.level.factories.filter((fac) => fac.id !== factory.id);
        this._renderAll();
        this._restartSim();
      } else {
        // No factory under the grab cell — this drag is a "pickup" of an
        // acid pit or border funnel. Handled with a different ghost +
        // applyTool dispatch path; the rest of _onDragStart is skipped.
        if (this._beginPickupDrag(grabR, grabC)) return;
        return;
      }
    } else {
      return;
    }

    // Build a ghost: body + funnels + animated flow at board scale (drop
    // preview look). Flow tracked separately so the scene update loop can
    // tick its dashes — without that the ghost would look "dead" mid-drag.
    if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
    this.ghostContainer.removeAll(true);
    this.ghostFlow = null;
    // Ghost funnel particles — create FIRST so the gfx lands at the back
    // of ghostContainer's child list (behind funnel/body/flow).
    this.ghostParticles = new FunnelParticleSystem(this, this.ghostContainer, { pxCell: this.pxCell });
    this.ghostParticles.setFunnels(
      collectFactoryFunnelsForParticles(shape.cells, shape.funnels, this.pxCell, BOARD_GAP, SHAPE_SCALE),
    );
    const [cx, cy] = this._factoryCenter(shape.cells, this.pxCell, BOARD_GAP);
    const funnelWrap = this.add.container(cx, cy);
    const bodyWrap   = this.add.container(cx, cy);
    this.ghostContainer.add(funnelWrap);
    this.ghostContainer.add(bodyWrap);
    const funnels = renderFunnels(this, funnelWrap, shape.funnels, { pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE });
    funnels.setPosition(-cx, -cy);
    const body    = renderFactoryBody(this, bodyWrap, {
      cells: shape.cells, pxCell: this.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      caution: isObstacleFactory(shape.funnels),
    });
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

    // Swap the icon island into "DELETE" trash mode for the duration of
    // this drag — both for board factory drags AND for draft (composer)
    // drags, so dropping either onto the trash deletes them. (Slot drags
    // in blueprintSetup keep the normal island.)
    if (source === 'board' || source === 'draft') {
      this._activateTrashIsland();
    }

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
    // Pickup drag (acid pit / border funnel) takes precedence — it owns
    // its own ghost in placementContainer-relative coords and uses the
    // palette placement preview pipeline.
    if (this._pickupDrag) {
      this._pickupDrag.lastX = x;
      this._pickupDrag.lastY = y;
      if (this._paletteGhost) {
        this._paletteGhost.x = x;
        this._paletteGhost.y = y;
      }
      const tool = findTool(this._pickupDrag.toolId);
      this._updatePalettePlacementPreview(x, y, tool);
      return;
    }
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
    // Route pickup drags (pit / border funnel) to their own handler.
    if (this._pickupDrag) { this._endPickupDrag(); return; }
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

    // Drop-destination priority: delete-zone (icon island during a board
    // factory or draft drag) → board cell → draw grid → cancel.
    if (this._factoryDragActive && this._iconSlotAt(px, py)) {
      // Delete drop: rustle instead of a click. "With no click" — so
      // the whole delete cue is a quiet shape-leaves-the-board puff,
      // distinct from the clack of a placement snap.
      playOnce(this.game, 'click_empty', { throttleMs: 60, volume: 0.22 });
      spawnEmptyClickParticles(this, px, py);
      // No snapshot here — drag start already pushed one capturing the
      // pre-drag state (factory on the board / draft populated). Undo
      // will restore that.
      if (this.drag.source === 'board') {
        // Factory was already removed from level at drag start — don't
        // restore it. Sim was restarted then; persist + re-render now.
      } else if (this.drag.source === 'draft') {
        // Clear the draft entirely — the dragged shape goes away.
        this.draftCells = [];
        this.draftFunnels = [];
      }
      this._persist();
      this._renderAll();
      this._renderDrawGrid();
      this._restartSim();
      this._clearDrag();
      return;
    }
    // Any other drop (board placement, draft move, or cancel-restore)
    // is a "snap" — one shared click cue.
    playOnce(this.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
    if (boardRC && this._tryPlaceOnBoard(boardRC)) {
      this._clearDrag();
      return;
    }
    const dropCell = this._drawGridCellAt(px, py);
    if (dropCell) {
      this._moveToDraft(dropCell.r, dropCell.c);
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

  // Drop on the draw grid: the dragged factory becomes the new draft,
  // positioned so the GRABBED cell lands at the drop point (dropR, dropC).
  // Without that translation the cells would land at their normalized
  // origin (top-left) regardless of where the user dropped. Bounds-clamps
  // the offset so the bounding box stays inside drawGridRows × drawGridCols.
  _moveToDraft(dropR, dropC) {
    const { shape, grab } = this.drag;
    let offR = 0, offC = 0;
    if (dropR != null && dropC != null && grab) {
      offR = dropR - grab.r;
      offC = dropC - grab.c;
      // Bounds-clamp so every cell stays inside the draw grid.
      let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
      for (const cc of shape.cells) {
        if (cc.r < minR) minR = cc.r;
        if (cc.c < minC) minC = cc.c;
        if (cc.r > maxR) maxR = cc.r;
        if (cc.c > maxC) maxC = cc.c;
      }
      if (minR + offR < 0) offR = -minR;
      if (minC + offC < 0) offC = -minC;
      if (maxR + offR >= this.drawGridRows) offR = this.drawGridRows - 1 - maxR;
      if (maxC + offC >= this.drawGridCols) offC = this.drawGridCols - 1 - maxC;
    }
    this.draftCells = shape.cells.map((c) => ({ ...c, r: c.r + offR, c: c.c + offC }));
    this.draftFunnels = (shape.funnels || []).map((f) => ({ ...f, r: f.r + offR, c: f.c + offC }));
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
    // The drag pushed a snapshot at START for 'board' / 'draft' sources so
    // any successful drop has a pre-drag state to undo to. On cancel the
    // level returned to its original state, so pop that snapshot to keep
    // the undo stack free of no-op entries.
    if ((this.drag.source === 'board' || this.drag.source === 'draft') && this._undoStack) {
      this._undoStack.pop();
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
    // Acid pits block factory placement too — shapes pass over, factories don't.
    for (const pit of (this.level.acidPits || [])) {
      set.add(`${pit.r},${pit.c}`);
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
    if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
    this.ghostContainer.removeAll(true);
    this.placementContainer.removeAll(true);
    this._renderDrawGrid();
    this._deactivateTrashIsland();
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
    // Palette drag owns the placement preview; suppress composer hover.
    if (this._paletteDrag) return;

    // Funnel-edge hover previews are gone in the palette-drag editor —
    // funnels are now placed via the dedicated palette tool, so showing
    // a "next funnel role" preview on every edge mouseover is misleading.
    // Cell add preview on the composer is similarly retired (factory
    // placement is now drag-from-palette only).
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
    if (this.titleBar) { this.titleBar.destroy(); this.titleBar = null; }
    if (this.bossPhaseIndicator) {
      this.bossPhaseIndicator.destroy();
      this.bossPhaseIndicator = null;
    }
    // Use the centered stackTop so the title bar shifts with the stack
    // when the content box has vertical slack (keeps margins symmetric).
    const stackTop = this.stackTop != null
      ? this.stackTop
      : ((this.contentBox && this.contentBox.boxY) || 0);
    const barCX = this.boardOriginX + this.boardW / 2;
    const barCY = stackTop + TitleBar.HEIGHT / 2 + 12;

    if (this._bossMode) {
      // Boss mode: no title-bar step pills. A mid-canvas phase indicator
      // takes the same slot — left arrow, phase label, right arrow.
      this.bossPhaseIndicator = new BossPhaseIndicator(this, {
        x: barCX,
        y: barCY,
        width: this.titleBarW,
        height: TitleBar.HEIGHT,
        depth: 100,
        onNav: (delta) => this._bossNav(delta),
      });
      this._refreshBossIndicator();
      return;
    }

    // TitleBar hugs the "labels-aware" width. Editor uses the `standalone-
    // steps` variant — three bare pills, no surrounding frame, no HOME
    // button. The icon-island BACK slot remains the only way out.
    this.titleBar = new TitleBar(this, {
      x: barCX,
      y: barCY,
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
    // Even if victory is "ready" (no required outputs to satisfy), the
    // Blueprint phase only opens when there's at least one factory on
    // the playable area. Otherwise BLUEPRINT would be tappable on a
    // blank level, which is misleading — there's nothing to slot.
    const hasFactories = (this.level.factories || []).length > 0;
    const blocksReady  = !!this._victoryReady && hasFactories;
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

  // =====================================================================
  //   Boss-mode phase navigation
  // =====================================================================
  //
  // Flat sequence of 2N+1 positions:
  //   0: Edit 1, 1: Blueprint 1, 2: Edit 2, 3: Blueprint 2, ... 2N: Export
  //
  // _bossStageIdx drives the active stage (0..N-1). The current phase within
  // the flat sequence is derived from (_bossStageIdx * 2) + (_mode phase),
  // then the special "export" sentinel at the end. Arrows on the indicator
  // step ±1 through this sequence, calling _enterBlueprintSetup /
  // _exitBlueprintSetup / _bossAdvanceToStage / _openExportPanel as needed.

  _bossSeqPos() {
    if (!this._bossMode) return 0;
    if (this.exportPanel) return this._bossStageCount * 2;
    const phase = this._mode === 'blueprintSetup' ? 1 : 0;
    return this._bossStageIdx * 2 + phase;
  }

  _bossSeqLabel(pos) {
    if (pos >= this._bossStageCount * 2) return 'Export';
    const stage = Math.floor(pos / 2);
    const phase = pos % 2 === 0 ? 'Edit' : 'Blueprint';
    return `${phase} ${stage + 1} of ${this._bossStageCount}`;
  }

  _refreshBossIndicator() {
    if (!this.bossPhaseIndicator) return;
    const pos = this._bossSeqPos();
    const maxPos = this._bossStageCount * 2;   // Export is at `maxPos`
    const canBack = pos > 0;
    // Forward depends on current-phase readiness. Edit → needs design
    // victory. Blueprint → needs all factories slotted/locked. Export is
    // terminal.
    let canNext = false;
    if (pos < maxPos) {
      const isEdit = pos % 2 === 0;
      if (isEdit) canNext = !!this._victoryReady;
      else        canNext = this._blueprintExportReady && this._blueprintExportReady();
    }
    this.bossPhaseIndicator.setState({
      label: this._bossSeqLabel(pos),
      canBack,
      canNext,
    });
  }

  _bossNav(delta) {
    if (!this._bossMode) return;
    if (delta > 0) this._bossForward();
    else           this._bossBack();
  }

  _bossForward() {
    const pos = this._bossSeqPos();
    const maxPos = this._bossStageCount * 2;
    if (pos >= maxPos) return;
    const isEdit = pos % 2 === 0;
    if (isEdit) {
      if (!this._victoryReady) return;
      // Enter blueprint for the current stage — same as single-level's
      // _enterBlueprintSetup path but keyed to boss.rounds[stageIdx].
      this._enterBlueprintSetup();
      this._refreshBossIndicator();
      return;
    }
    // Blueprint → either advance to next stage's Edit, or open Export if
    // this was the last stage.
    if (!this._blueprintExportReady()) return;
    // Snapshot this stage's blueprint+solution into boss.rounds[stageIdx].
    this._bossSnapshotStage(this._bossStageIdx);
    const nextStage = this._bossStageIdx + 1;
    if (nextStage >= this._bossStageCount) {
      // Done authoring — open export panel.
      this._openExportPanel();
      this._refreshBossIndicator();
      return;
    }
    this._bossEnterStage(nextStage);
    if (nextStage > this._bossMaxVisitedIdx) this._bossMaxVisitedIdx = nextStage;
    this._refreshBossIndicator();
  }

  _bossBack() {
    const pos = this._bossSeqPos();
    if (pos <= 0) return;
    const maxPos = this._bossStageCount * 2;
    // Close the export panel if we're on it — and hop back into the last
    // stage's Blueprint phase (since that's what preceded Export).
    if (pos >= maxPos) {
      if (this.exportPanel) { this.exportPanel.destroy(); this.exportPanel = null; }
      // _bossStageIdx is still N-1; re-enter its blueprint phase. The
      // snapshot we captured on forward-advance is still in rounds[N-1].
      if (this._mode !== 'blueprintSetup') {
        // The working slots were loaded via applyBossRoundToWorking when
        // we entered stage N-1 for editing; re-snapshot solution is a
        // no-op because the sim will re-fire victory on the next cycle.
        this._enterBlueprintSetup();
      }
      this._refreshBossIndicator();
      return;
    }
    const isEdit = pos % 2 === 0;
    if (isEdit) {
      // Back from Edit k lands on Edit k-1. We skip past Blueprint k-1
      // because re-entering Blueprint requires the sim to re-satisfy the
      // stage's outputs, which happens asynchronously on the next cycle —
      // the user can tap forward once victory re-fires to revisit the
      // blueprint slots.
      this._bossSnapshotStage(this._bossStageIdx);
      const prevStage = this._bossStageIdx - 1;
      if (prevStage < 0) return;
      this._bossEnterStage(prevStage);
    } else {
      // Back from Blueprint k to Edit k — same stage, just switch phase.
      this._exitBlueprintSetup();
    }
    // Arrow-back into an earlier stage means later stages are pending
    // invalidation if/when the user mutates this one.
    this._bossNeedsInvalidation = this._bossStageIdx < this._bossMaxVisitedIdx;
    this._refreshBossIndicator();
  }

  // Snapshot the active working slots into boss.rounds[stageIdx]. Uses
  // whichever phase is live: in design mode we capture the canonical
  // solution; in blueprint-setup we also capture initialFactories (the
  // slot assignments) and the author's lockedFactoryIds choices.
  _bossSnapshotStage(stageIdx) {
    if (!this.level || !this.level.boss) return;
    const rounds = this.level.boss.rounds || [];
    const r = rounds[stageIdx];
    if (!r) return;
    const clone = (v) => JSON.parse(JSON.stringify(v || null));
    if (this._mode === 'blueprintSetup') {
      // Capture the blueprint assignments as the stage's initialFactories.
      const initial = [];
      for (const fac of (this._solutionSnapshot || [])) {
        if (this._lockedFactoryIds.has(fac.id)) continue;
        const a = this._blueprintAssignments.get(fac.id);
        if (!a) continue;
        initial.push({
          id: fac.id,
          slot: { row: a.slot.r, col: a.slot.c },
          cells: fac.cells.map((c) => ({ ...c })),
          funnels: (fac.funnels || []).map((f) => ({ ...f })),
          rotation: a.rotation || 0,
        });
      }
      // Border/inputs/outputs didn't change during blueprint-setup (the
      // picker is disabled in this mode) — copy through from the working
      // slots. Solution is the stage-own factories from the snapshot.
      r.border = clone(this.level.border) || { funnels: [] };
      r.inputs = clone(this.level.inputs) || [];
      r.outputs = clone(this.level.outputs) || [];
      r.instructionalText = this.level.instructionalText || null;
      r.initialFactories = initial;
      r.solution = { factories: clone(this._solutionSnapshot || []) };
    } else {
      // Edit-phase snapshot: level.factories has THIS stage's solution
      // (unlocked) plus locked carry-over from prior stages. snapshotWorking
      // filters out the locked ones.
      snapshotWorkingToBossRound(this.level, stageIdx);
    }
  }

  _bossEnterStage(stageIdx) {
    // Leave blueprint-setup if we're in it (without running the
    // solution-restore logic — boss stage changes do their own state swap).
    if (this._mode === 'blueprintSetup') {
      this._dismissStepAdvanceBanner && this._dismissStepAdvanceBanner();
      if (this.exportPanel) { this.exportPanel.destroy(); this.exportPanel = null; }
      this._blueprintAssignments = new Map();
      this._lockedFactoryIds = new Set();
      this._solutionSnapshot = null;
      this._mode = 'design';
    }
    this._bossStageIdx = stageIdx;
    applyBossRoundToWorking(this.level, stageIdx);
    this._renderAll();
    this._renderDrawGrid();
    this._renderIconIsland();
    this._setupIconSlotHandlers();
    // Reset per-stage tracking — _victoryReady will re-fire on the next
    // sim cycle if the stored solution satisfies the stage's outputs.
    this._satisfiedOutputs && this._satisfiedOutputs.clear();
    this._satisfiedCatchers && this._satisfiedCatchers.clear();
    this._victoryReady = false;
    this._restartSim();
  }

  // Called when the user mutates level state. In boss mode, if we're
  // revisiting a prior stage, flip the invalidation bit: later stages get
  // reset back to empty defaults the next time we advance past them.
  _bossOnMutate() {
    if (!this._bossMode) return;
    if (this._bossStageIdx >= this._bossMaxVisitedIdx) return;
    // First mutation on a prior stage — reset stages strictly AFTER this
    // one and notify the user.
    if (!this._bossNeedsInvalidation) return;
    for (let i = this._bossStageIdx + 1; i < this._bossStageCount; i++) {
      this.level.boss.rounds[i] = defaultBossRound(this.level.board.cols);
    }
    this._bossMaxVisitedIdx = this._bossStageIdx;
    this._bossNeedsInvalidation = false;
    this._showStepAdvanceBanner('Later stages reset — they depended on this one.');
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
    if (this._bossMode) {
      // Boss mode has no title-bar step pills — just refresh the mid-canvas
      // phase indicator so forward/back arrows enable/disable live as the
      // sim resolves outputs.
      this._refreshBossIndicator();
      return;
    }
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
    makeHit(SLOT_HOME, () => {
      // HOME always exits to the main menu, regardless of mode.
      this.sim && this.sim.stop();
      fadeTo(this, 'Home');
    });
    makeHit(SLOT_START_OVER, () => {
      // START OVER — opens a confirmation modal; on YES, completely
      // resets the editor to a fresh sandbox state. Disabled during
      // blueprint-setup mode (the user shouldn't lose their setup
      // mid-export).
      if (this._mode === 'blueprintSetup') return;
      this._openStartOverConfirm();
    });
    // Board resize is disabled in boss mode past stage 1 (size is locked
    // the moment the user advances past the first stage) and in any
    // blueprint-setup phase.
    makeHit(SLOT_SHRINK, () => {
      if (this._mode === 'blueprintSetup') return;
      if (this._bossMode && this._bossMaxVisitedIdx > 0) return;
      this._resizeBoard(-1);
    });
    makeHit(SLOT_GROW, () => {
      if (this._mode === 'blueprintSetup') return;
      if (this._bossMode && this._bossMaxVisitedIdx > 0) return;
      this._resizeBoard(+1);
    });
    makeHit(SLOT_GEAR, () => this._openSettings());
  }

  _openSettings() {
    if (this._settingsModal) return;
    this._settingsModal = new SettingsModal(this, {
      onClose: () => { this._settingsModal = null; },
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
    // Boss mode (only reachable at stage 0): also reseed every stage's
    // stored round so later stages' funnel positions stay valid at the new
    // board size. Since resize wipes factories anyway, replacing the
    // downstream rounds with fresh defaults is a reasonable reset.
    if (this._bossMode && this.level.boss && Array.isArray(this.level.boss.rounds)) {
      for (let i = 0; i < this.level.boss.rounds.length; i++) {
        this.level.boss.rounds[i] = defaultBossRound(dim);
      }
      applyBossRoundToWorking(this.level, 0);
      this._bossMaxVisitedIdx = 0;
      this._bossStageIdx = 0;
      this._bossNeedsInvalidation = false;
    }
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
    if (this.laserRenderer) this.laserRenderer.destroy();
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      ...this._simCallbacks(),
    });
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.resize(this.pxCell);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.resize(this.pxCell);

    if (this.iconSlotHits) for (const h of this.iconSlotHits) h.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderDrawGrid();
    this._renderPaletteBar();
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
    if (this.laserRenderer) this.laserRenderer.destroy();
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      ...this._simCallbacks(),
    });
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.resize(this.pxCell);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.resize(this.pxCell);
    if (this.titleBar) this.titleBar.destroy();
    if (this.iconSlotHits) for (const h of this.iconSlotHits) h.destroy();
    this._buildToolbar();
    this._renderAll();
    this._renderDrawGrid();
    this._renderPaletteBar();
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
