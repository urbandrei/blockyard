import Phaser from 'phaser';
import { loadLevel, genId, bossRoundLevel } from '../model/level.js';
import {
  rotateFactoryShape, isBorderCell, normalizeFactory, isObstacleFactory,
} from '../model/shape.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody, renderLockedTint, drawBoltInto } from '../render/FactoryBodyRenderer.js';
import { renderFactoryGears, spinFactoryGears } from '../render/FactoryGears.js';
import { renderAcidPits } from '../render/AcidPitRenderer.js';
import { disposeBakedGeometryCache } from '../render/textures/atlas.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderFlow } from '../render/FlowRenderer.js';
import { renderBufferLabels } from '../render/BufferLabelRenderer.js';
import { renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline } from '../render/PlayAreaFrame.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { LaserRenderer } from '../render/LaserRenderer.js';
import { FunnelParticleSystem, collectFunnelsForParticles, collectFactoryFunnelsForParticles } from '../render/FunnelParticleSystem.js';
import { BufferMarkerRenderer } from '../render/BufferMarkerRenderer.js';
import { TitleBar } from '../ui/TitleBar.js';
import { StagePillStrip } from '../ui/StagePillStrip.js';
import {
  stageColor, CURRENT_STAGE_COLOR,
  PAST_STAGE_ALPHA, FUTURE_STAGE_ALPHA, CELL_TINT_ALPHA,
} from '../ui/stageColors.js';
import { spawnFunnelFirework } from '../render/FunnelFirework.js';
import { HintConfirmModal } from '../ui/HintConfirmModal.js';
import { HintNudgePopup } from '../ui/HintNudgePopup.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { themeForLevelId } from '../themes/sectionThemes.js';
import { compute920Box } from '../ui/ContentBox.js';
import { Simulation } from '../sim/Simulation.js';
import { DragController } from '../input/DragController.js';
import { shapeSquash } from '../render/pulse.js';
import { drawHome, drawGrid, drawCircleArrow, drawPlayTriangle, drawFastForward, drawShareNet, drawGear } from '../ui/Icons.js';
import { SettingsModal } from '../ui/SettingsModal.js';
import { addDomBand } from '../ui/DomDim.js';
import { shareLevel as nativeShareLevel, encodeShareString as encodeShareForClient } from '../ui/socialShare.js';
import {
  resumeMusic, fadeInAllLayers,
  fadeOutToLayerOne, resetLayersToInitial,
} from '../audio/MusicEngine.js';
import {
  playOnce, wireUiClicks, spawnEmptyClickParticles,
  playSfxSound, createLoopingSfx, playTimedSfx,
} from '../audio/sfx.js';
import { getLevelById, nextLevelAfter, SECTIONS } from '../catalog/index.js';
import { markBeaten, markFeaturedCompleted, consumeSectionIntro } from '../progress.js';
import { SECTION_THEMES, MAIN_SECTION_COUNT } from '../themes/sectionThemes.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import {
  BOARD_GAP, CYCLE_MS, BEAT_MS, SHAPE_SCALE, motionWarp,
  BLUEPRINT_BG, BLUEPRINT_DOT, BLUEPRINT_STROKE,
} from '../constants.js';

const SHAPE_WARP_AMP = 0.15;
const TOOLBAR_H = TitleBar.HEIGHT + 8;

const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;

// Icon island — evenly-spread shortcuts. PLAY / RESET that drive the
// actual simulation have been promoted out of the island into a prominent
// overlay in the blueprint area (see _renderBlueprint). The `share` slot
// is omitted on campaign levels (see _iconSlotSpecs).

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
    // When the caller wants a post-victory rating prompt (remote community
    // levels), they pass `communityId` + `communityName` so we can stash
    // a pending-rating record on the game registry for CommunityScene to
    // pick up on return.
    this._communityId   = (data && data.communityId)   || null;
    this._communityName = (data && data.communityName) || null;
    // Daily-featured tag: when HomeScene's featured panel launches a level,
    // it passes the UTC date string so we can mark it completed on victory
    // (advancing the streak when it's today's, recording it for the
    // history list when it's a past day's catch-up). Null for any other
    // launch path.
    this._featuredUtcDate = (data && data.featuredUtcDate) || null;
    // Set by SectionIntroScene when it auto-advances back into the
    // player so we don't ping-pong back into the intro on every level
    // 41 entry — the intro only fires the first time anyway via
    // consumeSectionIntro, but this short-circuit is cheaper.
    this._skipIntroCheck = !!(data && data._skipIntroCheck);
  }

  async create() {
    wireUiClicks(this);
    disableMenuBg();
    fadeIn(this);

    // vibej.am portal arrival: PreloadScene stashed a PortalCover that
    // is still drawn on top of us. Trigger its reveal phase one frame
    // after our content paints so the swirl pulls back over a clean
    // first frame. Single-shot — clear the global so re-entries don't
    // try to dismiss a destroyed cover.
    if (typeof window !== 'undefined' && window.__blockyardPortalCover) {
      const cover = window.__blockyardPortalCover;
      window.__blockyardPortalCover = null;
      this.time.delayedCall(0, () => {
        try { cover.triggerExit(); } catch (e) { /* ignore */ }
      });
    }

    // First-time Wild West entry → redirect to the section-unlock
    // cinematic before the level loads. Detected by walking the
    // catalog's section index for our level id; a non-main section
    // (idx >= MAIN_SECTION_COUNT) plus an unseen 'wild-west' intro
    // means this is the first time the player has crossed the gate.
    if (!this._skipIntroCheck && this.sourceLevel && this.sourceLevel.id) {
      try {
        let mySectionIdx = -1;
        for (let i = 0; i < SECTIONS.length; i++) {
          if (SECTIONS[i].levels.some((l) => l.id === this.sourceLevel.id)) { mySectionIdx = i; break; }
        }
        if (mySectionIdx >= MAIN_SECTION_COUNT) {
          const sectionId = (SECTION_THEMES[MAIN_SECTION_COUNT] || {}).id;
          const alreadySeen = await consumeSectionIntro(sectionId);
          if (!alreadySeen) {
            fadeTo(this, 'SectionIntro', {
              sectionIdx: MAIN_SECTION_COUNT,
              nextLevelId: this.sourceLevel.id,
            });
            return;
          }
        }
      } catch (e) { console.warn('[player] wild west intro check failed', e); }
    }
    this.ready = false;
    this.simState = 'idle';        // 'idle' | 'running' | 'paused'
    this.simTime  = 0;             // virtual clock — only advances when running
    this._fastForwardActive = false; // blueprint >> button held → 2x sim speed
    this.satisfiedOutputs = new Set();
    this.satisfiedCollectors = new Set();
    // Red border funnels that have already played their right/wrong SFX
    // this play run — keyed by funnel.key. Reset on each _startPlay.
    this._borderFunnelSounded = new Set();
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
    // Decorative gear sprites scattered around factory perimeters. Sits
    // below shapes / funnels / the factory body so each gear only
    // shows the slice that pokes past the body edge — the rest hides
    // behind the body fill. One gearWrap child per factory; each wrap
    // moves / rotates with the factory's body via the same tween
    // targets used for bodyWrap + funnelWrap.
    // Depth 14 — below the factory funnels (15) and the factory body
    // (interactive at 20), so each gear peeks out only where it
    // extends past those layers. Sits above shape/laser/particle
    // layers so flowing shapes don't clip in front of the gears.
    this.gearContainer         = this.add.container(0, 0).setDepth(14);
    // Funnel particles render BELOW shapes so emerging shapes paint over
    // their own preview particles instead of being veiled by them.
    this.factoryFunnelParticleContainer = this.add.container(0, 0).setDepth(8);
    this.borderFunnelParticleContainer  = this.add.container(0, 0).setDepth(9);
    this.shapeContainer        = this.add.container(0, 0).setDepth(10);
    this.laserContainer        = this.add.container(0, 0).setDepth(12);
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
    // Persistent effects container — particles/bursts that should outlive
    // a _clearBoardDynamic sweep (e.g. the boss round-transition firework).
    this.fxContainer           = this.add.container(0, 0).setDepth(200);

    // Resolve the level. Priority: inline level (from CommunityScene) →
    // catalog level by id → editor sandbox fallback.
    let source = this._inlineLevel || (this._levelId ? getLevelById(this._levelId) : null);
    if (!source) source = await loadLevel();
    // Campaign levels come from getLevelById and don't set inlineLevel;
    // every other entry point (Community, deep-link, editor) passes an
    // inline level. We hide the island's social-share slot on campaign
    // runs since sharing a curated catalog level doesn't mean much.
    this._isCampaign = !this._inlineLevel;
    // Boss levels: keep the original around for future round transitions
    // and use the round-0 composition as the active sourceLevel. RESET
    // and scene shutdown both put the boss back at round 0 (no mid-boss
    // save state per the user's spec).
    if (source && source.boss) {
      this._sourceLevelOriginal = source;
      this._bossState = { roundIdx: 0, locked: [] };
      this._bossHintAutoShow = true;
      this.sourceLevel = bossRoundLevel(source, 0, []);
    } else {
      this._sourceLevelOriginal = source;
      this._bossState = null;
      this._bossHintAutoShow = false;
      this.sourceLevel = source;
    }

    // Anonymous play telemetry. Identified levels (campaign + community)
    // get a session id; editor-sandbox / unfinished imports skip — there's
    // no canonical id to bucket them under. Failures from the API are
    // swallowed in the platform adapter, so a network outage just leaves
    // _playSessionId null and the shutdown PATCH no-ops.
    this._playSessionId = null;
    this._playOpenedAt  = Date.now();
    this._playHintCount = 0;
    this._playCompleted = false;
    this._playKind      = null;
    this._playLevelId   = null;
    if (this._communityId) {
      this._playKind = 'community';
      this._playLevelId = this._communityId;
    } else if (this._isCampaign && this._sourceLevelOriginal && this._sourceLevelOriginal.id) {
      this._playKind = 'campaign';
      this._playLevelId = this._sourceLevelOriginal.id;
    }
    if (this._playKind && this._playLevelId) {
      const platform = this.game.registry.get('platform');
      if (platform && typeof platform.startPlay === 'function') {
        platform.startPlay(this._playKind, this._playLevelId)
          .then((sid) => { this._playSessionId = sid; })
          .catch(() => {});
      }
    }
    // Section theme drives interior/exterior/letterbox palettes for this
    // level. Inline (community) levels and unknown ids fall back to Block
    // Yard inside themeForLevelId.
    this._theme = themeForLevelId(this.sourceLevel && this.sourceLevel.id);

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
      theme: this._theme,
    }));

    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    this.bufferMarkerRenderer = new BufferMarkerRenderer(this, this.bufferMarkerContainer, this._composeLevel(), {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => {
        this.shapeRenderer.spawn(shape);
        this._playShapeExitOnce();
      },
      onRemove: (shape, pop, cause) => {
        this.shapeRenderer.remove(shape, pop, cause);
        // Laser-caused pop: the zap plays at electrocute-start via
        // onShapeElectrocuted, and the actual pop animation fires
        // ELECTROCUTE_MS (400ms) later here — so the two SFX land
        // in the correct order without explicit scheduling.
        if (pop) this._playShapePopOnce();
      },
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        // Red border funnels get exactly ONE right/wrong sound per play
        // run — the first shape to arrive. Later arrivals into the same
        // funnel still mark the buffer but stay silent, so a steady
        // stream of correct shapes doesn't chirp every cycle.
        if (funnel.ownerId === 'border' && !this._borderFunnelSounded.has(funnel.key)) {
          this._borderFunnelSounded.add(funnel.key);
          playOnce(this.game, accepted ? 'funnel_right' : 'funnel_wrong', { throttleMs: 120, volume: 0.5 });
        }
        if (accepted && funnel.ownerId === 'border') this._onOutputSatisfied(funnel);
      },
      onSinkHit: (funnel) => {
        // Factory input — whoosh as the shape enters the body.
        // Border sinks get their pull-in cue earlier via
        // onShapeApproachSink; no sound here would double up.
        if (funnel.ownerId !== 'border') {
          playOnce(this.game, 'factory_pass', { throttleMs: 90, volume: 0.15 });
        }
      },
      onShapeApproachSink: () => {
        // Shape has just entered its shrink zone toward a red border
        // funnel — play the suck-in pop here (ahead of the actual
        // sink-hit) so the audio matches the visual pull-in.
        playOnce(this.game, 'funnel_suck', { throttleMs: 40, volume: 0.22 });
      },
      onShapeElectrocuted: () => {
        playOnce(this.game, 'zap', { throttleMs: 100, volume: 0.5 });
      },
      onShapeEnterAcid: () => {
        playOnce(this.game, 'acid_bubble', { throttleMs: 120, volume: 0.22 });
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
      onToggleCell:    (info, pointer) => this._onTapCell(info, pointer),
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
      // Drop level-scoped baked textures (factory body blobs + acid pit
      // fills cached by atlas.js) so they don't leak into the next scene.
      try { disposeBakedGeometryCache(this); } catch (e) { /* ignore */ }
      // Telemetry: end the play session. Best-effort — platform adapter
      // swallows network errors; a missing _playSessionId (telemetry
      // disabled / startPlay failed / scene-swap before the POST resolved)
      // makes this a no-op.
      try {
        const platform = this.game.registry.get('platform');
        if (platform && typeof platform.endPlay === 'function' && this._playSessionId) {
          platform.endPlay({
            sessionId:   this._playSessionId,
            completed:   !!this._playCompleted,
            hintCount:   this._playHintCount | 0,
            timeSpentMs: Math.max(0, Date.now() - (this._playOpenedAt || Date.now())),
          });
        }
      } catch (e) {}
      this.sim && this.sim.stop();
      if (this._settingsModal) { try { this._settingsModal.destroy(); } catch (e) {} this._settingsModal = null; }
      // Stop the laser-beam loop so it doesn't continue into the next
      // scene. Other SFX are fire-and-forget and free themselves.
      if (this._laserBeamSound) {
        this._laserBeamSound.destroy();
        this._laserBeamSound = null;
      }
      if (this._rotateSfx) {
        this._rotateSfx.stop();
        this._rotateSfx = null;
      }
      if (this._laserPrev) this._laserPrev.clear();
      // Intentionally NOT snapping layers here — the victory fade-out
      // is scheduled on the MusicEngine's own step loop, which keeps
      // running across scene transitions. Snapping here would cut the
      // fade the instant the scene swap begins. The next _startPlay
      // will snap cleanly when the user presses PLAY on the new level.
      resumeMusic();
      this.dragCtrl && this.dragCtrl.destroy();
      this._resetStuckPopup();
      if (this._hintModal) { this._hintModal.destroy(); this._hintModal = null; }
      this._teardownBlueprintPlayButtons();
      if (this.factoryFunnelParticles) { this.factoryFunnelParticles.destroy(); this.factoryFunnelParticles = null; }
      if (this.borderFunnelParticles)  { this.borderFunnelParticles.destroy();  this.borderFunnelParticles  = null; }
      if (this.ghostParticles) { this.ghostParticles.destroy(); this.ghostParticles = null; }
      if (this.blueprintParticleSystems) { for (const s of this.blueprintParticleSystems) s.destroy(); this.blueprintParticleSystems = null; }
      if (this._victoryTextBg) { this._victoryTextBg.destroy(); this._victoryTextBg = null; }
      if (this._victoryBandDom) { try { this._victoryBandDom(); } catch (e) {} this._victoryBandDom = null; }
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

  _isBossLevel() {
    return !!this._bossState;
  }

  _currentStageIdx() {
    return this._bossState ? this._bossState.roundIdx : -1;
  }

  _bossStageCount() {
    if (!this._sourceLevelOriginal || !this._sourceLevelOriginal.boss) return 0;
    return (this._sourceLevelOriginal.boss.rounds || []).length;
  }

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

    const currentIdx = this._currentStageIdx();

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
        stageIdx: currentIdx,
        interactable: true,
      };
      this.blueprintFactories.set(id, def);
      this._pushToSlot(slot, id);
      this.startingState.blueprint.push({ id, slot: { ...slot }, rotation: def.rotation });
    }

    // Boss levels: also seed FUTURE rounds' initialFactories as read-only,
    // greyed, stage-colored previews in free blueprint slots. Past rounds
    // are already on the board as locked carry, so we skip them here.
    if (this._bossState && this._sourceLevelOriginal && this._sourceLevelOriginal.boss) {
      const rounds = this._sourceLevelOriginal.boss.rounds || [];
      for (let i = currentIdx + 1; i < rounds.length; i++) {
        const iFs = (rounds[i] && rounds[i].initialFactories) || [];
        for (const it of iFs) {
          const id = `preview:${i}:${it.id || genId()}`;
          const norm = normalizeFactory(it.cells, it.funnels || []);
          const requested = it.slot ? { r: it.slot.row, c: it.slot.col } : { r: 0, c: 0 };
          const slot = this._claimFreeSlot(requested);
          this.blueprintFactories.set(id, {
            id,
            baseCells: norm.cells, baseFunnels: norm.funnels,
            converter: it.converter,
            slot,
            defaultSlot: { ...slot },
            rotation: it.rotation || 0,
            defaultRotation: it.rotation || 0,
            stageIdx: i,
            interactable: false,
          });
          this._pushToSlot(slot, id);
        }
      }
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
  // Row 0 is reserved when the blueprint has a hint pill or a boss stage
  // pill strip in the top row.
  _claimFreeSlot(requested) {
    const rows = this._slotRows();
    const cols = this._slotCols();
    const topReserved = !!this._instructionText() || this._isBossLevel();
    const rowFloor = topReserved ? 1 : 0;
    const startR = Math.max(rowFloor, Math.min(rows - 1, (requested && requested.r) || rowFloor));
    const startC = Math.max(0, Math.min(cols - 1, (requested && requested.c) || 0));
    if (!this._slotOccupied(startR, startC)) return { r: startR, c: startC };
    for (let r = rowFloor; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!this._slotOccupied(r, c)) return { r, c };
      }
    }
    return { r: rowFloor, c: 0 };  // last-resort fallback (will stack)
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
        baseCells: p.baseCells,
        baseFunnels: p.baseFunnels,
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
    this.islandSlotW = bpW / this._iconSlotCount();
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
    if (this.gearContainer) setPos(this.gearContainer, this.boardOriginX, this.boardOriginY);
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
    renderInteriorFloor(this, this.boardContainer, { board: lvl.board, pxCell: this.pxCell, theme: this._theme });
    if (this._acidPits) { this._acidPits.destroy(); this._acidPits = null; }
    this._acidPits = renderAcidPits(this, this.acidPitContainer, this.sourceLevel, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    let border;
    if (this._isBossLevel() && this._sourceLevelOriginal && this._sourceLevelOriginal.boss) {
      border = this._renderBossBorder(lvl);
    } else {
      border = renderBorder(this, this.boardContainer, this.borderFunnelContainer, lvl, { pxCell: this.pxCell, pxGap: BOARD_GAP });
    }
    this.borderFunnelWraps = border.wraps;
    for (const fac of lvl.factories) {
      const entry = this._drawFactory(fac);
      this.factoryRefs.set(fac.id, entry);
    }
    renderExteriorCheckers(this, this.exteriorContainer, {
      board: lvl.board, pxCell: this.pxCell,
      boardOriginX: this.boardOriginX, boardOriginY: this.boardOriginY,
      theme: this._theme,
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
    // Gear wrap is anchored at the BASE factory's world center — fixed
    // across rotations — with `wrap.rotation = factory.rotation * π/2`
    // bringing the gears to their rotated visual positions. This keeps
    // every gear pinned to the same physical cell-edge through the
    // blueprint → ghost → board → rotate journey.
    const baseCells   = factory.baseCells   || factory.cells;
    const baseFunnels = factory.baseFunnels || factory.funnels || [];
    const baseAbsCells = baseCells.map((cc) => ({ ...cc, r: factory.anchor.row + cc.r, c: factory.anchor.col + cc.c }));
    const [bcx, bcy] = factoryCenter(baseAbsCells, this.pxCell, BOARD_GAP);
    const funnelWrap = this.add.container(cx, cy);
    const bodyWrap   = this.add.container(cx, cy);
    const gearWrap   = this.add.container(bcx, bcy);
    gearWrap.rotation = (factory.rotation || 0) * Math.PI / 2;
    this.interactiveContainer.add(bodyWrap);
    this.funnelContainer.add(funnelWrap);
    this.gearContainer.add(gearWrap);
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
    const gearSet = renderFactoryGears(this, gearWrap, {
      id: factory.id, cells: baseCells, funnels: baseFunnels,
    }, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
      seed: factory.id,
    });
    return {
      bodyWrap, funnelWrap, gearWrap,
      body, funnels, tintGfx,
      gears: gearSet.gears,
      locked: !!factory.locked,
      factoryId: factory.id,
    };
  }

  // Render every stage's border funnels with stage-colored cell tints. The
  // sim level `lvl` already carries the *active* subset (current + carried
  // greens) via bossRoundLevel — this method renders that active set PLUS
  // a visual-only preview of FUTURE stages' funnels (dimmed, stage colored).
  _renderBossBorder(lvl) {
    const rounds = (this._sourceLevelOriginal.boss && this._sourceLevelOriginal.boss.rounds) || [];
    const currentIdx = this._currentStageIdx();
    const activeFunnels = (lvl.border && lvl.border.funnels) || [];
    // Tag every active funnel with its authoring stage idx (look it up in
    // the original rounds — match by r,c,side,role).
    const key = (f) => `${f.r},${f.c},${f.side},${f.role}`;
    const originByKey = new Map();
    for (let i = 0; i < rounds.length; i++) {
      const fs = (rounds[i] && rounds[i].border && rounds[i].border.funnels) || [];
      for (const f of fs) {
        const k = key(f);
        if (!originByKey.has(k)) originByKey.set(k, i);
      }
    }
    const stageIdxFor = (f) => {
      const v = originByKey.get(key(f));
      return v == null ? currentIdx : v;
    };

    const display = [];
    const seen = new Set();
    for (const f of activeFunnels) {
      display.push(f);
      seen.add(key(f));
    }
    // Future rounds (> currentIdx): everything visible but dimmed.
    for (let i = currentIdx + 1; i < rounds.length; i++) {
      const fs = (rounds[i] && rounds[i].border && rounds[i].border.funnels) || [];
      for (const f of fs) {
        if (seen.has(key(f))) continue;
        display.push(f);
        seen.add(key(f));
      }
    }

    const getOpts = (f) => {
      const sIdx = stageIdxFor(f);
      const isCurrent = sIdx === currentIdx;
      const isFuture = sIdx > currentIdx;
      const stageBg = isCurrent ? CURRENT_STAGE_COLOR : stageColor(sIdx);
      // Active funnels (current round all + prior greens) render fully
      // opaque; future round previews are dimmed.
      const alpha = isFuture ? FUTURE_STAGE_ALPHA : 1;
      return { stageBg, stageBgAlpha: CELL_TINT_ALPHA, alpha };
    };

    return renderBorder(this, this.boardContainer, this.borderFunnelContainer, lvl, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
      funnels: display,
      getOpts,
    });
  }

  _clearBoardDynamic() {
    this.factoryRefs.clear();
    for (const f of this.flowUpdaters) f.destroy && f.destroy();
    this.flowUpdaters.length = 0;
    this.interactiveContainer.removeAll(true);
    this.funnelContainer.removeAll(true);
    if (this.gearContainer) this.gearContainer.removeAll(true);
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
    // Boss levels ALWAYS reserve the top row for the stage pill strip,
    // whether or not the active round has instructional text.
    const hint = this._instructionText();
    const isBoss = this._isBossLevel();
    const reservedRow = (hint || isBoss) ? 1 : 0;

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

    // Tear down any previous pill strip from the last render pass.
    if (this._stagePillStrip) { this._stagePillStrip.destroy(); this._stagePillStrip = null; }

    if (isBoss) {
      // Stage pill strip across the reserved top row. The strip draws
      // into a dedicated child container of blueprintContainer so the
      // usual blueprintContainer.removeAll(true) on re-render wipes it
      // along with everything else.
      const stripHost = this.add.container(0, 0);
      this.blueprintContainer.add(stripHost);
      const currentIdx = this._currentStageIdx();
      const showAutoHint =
        this._bossHintAutoShow !== false && !!this._instructionText();
      this._stagePillStrip = new StagePillStrip(this, {
        x: 0, y: 0, width: dgW, height: slotPx,
        stageCount: this._bossStageCount(),
        currentIdx,
        hintText: this._instructionText() || '',
        hintVisible: showAutoHint,
        parent: stripHost,
        pillsInteractive: false,
      });
    } else if (hint) {
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
    // While the sim is running the PLAY tile becomes a fast-forward (>>)
    // glyph: press-and-hold doubles sim speed. Idle/paused keep the classic
    // play triangle that starts/resumes on tap.
    const playIconColor = 0x4caf50;
    const playBg = makeTile(playCX, (g) => {
      if (running) drawFastForward(g, 0, 0, btnSize * 0.68, playIconColor);
      else         drawPlayTriangle(g, btnSize * 0.04, 0, btnSize * 0.68, playIconColor);
    });

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
      // One beat up, one beat down → 2-beat breath on the PLAY tiles,
      // same grid every other animated element lands on.
      duration: BEAT_MS, yoyo: true, repeat: -1, ease: 'Sine.InOut',
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
      .setInteractive({ useHandCursor: true }).setDepth(56);
    // Fast-forward gating: only the running tile holds the >> glyph and
    // toggles the speed flag on press. Idle/paused fall through to the
    // classic single-tap start/resume path.
    const releaseFastForward = () => {
      this._fastForwardActive = false;
      pop(playBg);
    };
    playHit.on('pointerdown', () => {
      squash(playBg);
      if (this.simState === 'running') this._fastForwardActive = true;
    });
    playHit.on('pointerout',     releaseFastForward);
    playHit.on('pointerupoutside', releaseFastForward);
    playHit.on('pointerup', () => {
      const wasRunning = this.simState === 'running';
      releaseFastForward();
      if (wasRunning) return;          // hold-only — no tap action while running
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

  // Force a play-button rebuild after a sim-state transition so the icon
  // swaps between play-triangle (idle/paused) and fast-forward (running).
  // No-op if the buttons aren't currently mounted (blueprint occupied or
  // a factory is being dragged).
  _refreshBlueprintPlayButtons() {
    if (!this._blueprintButtonsVisible) return;
    const m = this._blueprintButtonMetrics;
    if (!m) return;
    this._showBlueprintPlayButtons(m.dgW, m.dgH, false);
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

    // Boss levels: paint a stage-color tint on each cell the factory occupies
    // (under the factory body so the dotted grid + body sit on top). Current
    // stage → blue; non-current → that stage's color at lower alpha.
    const currentIdx = this._currentStageIdx();
    const isCurrentStage = def.stageIdx == null || def.stageIdx === currentIdx;
    if (this._isBossLevel() && def.stageIdx != null && isTop) {
      const tint = isCurrentStage ? CURRENT_STAGE_COLOR : stageColor(def.stageIdx);
      const tintAlpha = isCurrentStage ? CELL_TINT_ALPHA + 0.15 : CELL_TINT_ALPHA;
      const tintGfx = this.make.graphics({ add: false });
      tintGfx.fillStyle(tint, tintAlpha);
      const r = Math.max(4, Math.round(slotPx * 0.1));
      for (const c of cellsLocal) {
        const tx = (def.slot.c + c.c) * slotPx + layerFromTop * FAN_OFFSET;
        const ty = (def.slot.r + c.r) * slotPx + layerFromTop * FAN_OFFSET;
        tintGfx.fillRoundedRect(tx + 2, ty + 2, slotPx - 4, slotPx - 4, r);
      }
      this.blueprintContainer.add(tintGfx);
    }

    const funnelWrap = this.add.container(ox + cx, oy + cy);
    const bodyWrap   = this.add.container(ox + cx, oy + cy);
    // Gears sit at the BASE factory center (invariant under rotation)
    // with the wrap carrying `rotation * π/2`. Matches the board copy
    // so picking a factory off the blueprint reads as a seamless lift.
    const baseCellsLocal   = def.baseCells.map((c) => ({ ...c }));
    const baseFunnelsLocal = (def.baseFunnels || []).map((f) => ({ ...f }));
    const [baseCx, baseCy] = factoryCenter(baseCellsLocal, slotPx, 0);
    const gearWrap = this.add.container(ox + baseCx, oy + baseCy);
    gearWrap.rotation = (def.rotation || 0) * Math.PI / 2;
    // Non-current stage factories render transparent + non-interactive.
    if (!isTop) { funnelWrap.setAlpha(0.55); bodyWrap.setAlpha(0.55); gearWrap.setAlpha(0.55); }
    else if (!isCurrentStage) {
      const a = def.stageIdx < currentIdx ? PAST_STAGE_ALPHA : FUTURE_STAGE_ALPHA;
      funnelWrap.setAlpha(a); bodyWrap.setAlpha(a); gearWrap.setAlpha(a);
    }
    // Gears first → they sit BELOW funnels + body, same stacking as
    // the board (gearContainer at depth 14 is below funnelContainer 15
    // and interactiveContainer 20).
    this.blueprintBodyContainer.add(gearWrap);
    // Funnels next → they render BELOW the body (matches the board +
    // ghost stack, where funnelContainer sits below interactiveContainer).
    this.blueprintBodyContainer.add(funnelWrap);
    this.blueprintBodyContainer.add(bodyWrap);
    const bpGears = renderFactoryGears(this, gearWrap, {
      id: def.id, cells: baseCellsLocal, funnels: baseFunnelsLocal,
    }, {
      pxCell: slotPx, pxGap: 0, seed: def.id,
    });
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
    if (isTop) this.blueprintRefs.set(def.id, {
      bodyWrap, funnelWrap, gearWrap, body, funnels, gears: bpGears.gears,
    });
  }

  // ---------- Icon island — Home / Level Select / Reset ----------

  // Slot layout — `share` drops out on campaign runs so catalog levels
  // render a 3-slot island, everything else renders 4 slots.
  _iconSlotSpecs() {
    const specs = [
      { key: 'home',   draw: drawHome,        onTap: () => {
        this.sim && this.sim.stop();
        fadeTo(this, 'Home');
      }},
      { key: 'select', draw: drawGrid,        onTap: () => {
        this.sim && this.sim.stop();
        const isCommunity = this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported';
        fadeTo(this, isCommunity ? 'Community' : 'LevelSelect');
      }},
    ];
    if (!this._isCampaign) {
      specs.push({ key: 'share', draw: drawShareNet, onTap: () => this._nativeShareCurrentLevel() });
    }
    specs.push({ key: 'reset',  draw: drawCircleArrow, onTap: () => this._resetPlay() });
    specs.push({ key: 'gear',   draw: drawGear,        onTap: () => this._openSettings() });
    return specs;
  }

  _iconSlotCount() {
    return this._isCampaign ? 4 : 5;
  }

  _openSettings() {
    if (this._settingsModal) return;
    this._settingsModal = new SettingsModal(this, {
      onClose: () => { this._settingsModal = null; },
    });
  }

  _renderIconIsland() {
    this.iconIslandContainer.removeAll(true);
    if (this.iconHits) for (const h of this.iconHits) h.destroy();
    this.iconHits = [];

    const specs = this._iconSlotSpecs();
    const slotCount = specs.length;
    const slotW = this.islandSlotW;
    const islandW = slotW * slotCount;
    const islandH = this.islandH;

    const frame = this.make.graphics({ add: false });
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this.iconIslandContainer.add(frame);

    const slotsGfx = this.make.graphics({ add: false });
    const slotPad = 4;
    for (let s = 0; s < slotCount; s++) {
      slotsGfx.fillStyle(BLUEPRINT_BG, 1);
      slotsGfx.lineStyle(1, BLUEPRINT_STROKE, 0.5);
      slotsGfx.fillRoundedRect(s * slotW + slotPad, slotPad, slotW - slotPad * 2, islandH - slotPad * 2, 8);
    }
    this.iconIslandContainer.add(slotsGfx);

    const iconSize = Math.round(Math.min(slotW, islandH) * 0.55);
    const cy = islandH / 2;

    specs.forEach((spec, i) => {
      const icon = this.make.graphics({ add: false });
      spec.draw(icon, i * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
      this.iconIslandContainer.add(icon);
      const cx = this.iconIslandOriginX + i * slotW + slotW / 2;
      const ay = this.iconIslandOriginY + islandH / 2;
      const rect = this.add.rectangle(cx, ay, slotW - 6, islandH - 6, 0xffffff, 0)
        .setInteractive({ useHandCursor: true });
      rect.on('pointerup', spec.onTap);
      this.iconHits.push(rect);
    });
  }

  async _nativeShareCurrentLevel() {
    const source = this.sourceLevel;
    if (!source) return;
    try {
      const shareString = encodeShareForClient(source);
      await nativeShareLevel({
        scene: this,
        level: source,
        shareString,
        featuredUtcDate: this._featuredUtcDate || null,
        onStatus: () => {},   // navigator.share UI is self-explanatory; no local toast needed
      });
    } catch (e) {
      console.warn('[player] native share failed', e);
    }
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

    // Blueprint-to-board. Only consider factories that are ACTUALLY
    // in the blueprint right now. Any factory already on the board —
    // correctly placed OR misplaced — is handled by the misplaced
    // branch above (or, if correctly placed, skipped entirely).
    // Without this guard the hint can pick a well-placed factory,
    // fail to pop it from a stack that doesn't contain it, and fly a
    // ghost from the factory's old blueprint slot to its current
    // on-board spot — which reads as a ghost drifting into a piece
    // that's already correct.
    const candidates = [];
    for (const def of this.blueprintFactories.values()) {
      if (this.placed.has(def.id)) continue;
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
    // Telemetry: count only confirmed hint applications (not modal opens
    // that the player cancels). Bumped before the tween fires so a mid-
    // tween shutdown still records the hint.
    this._playHintCount = (this._playHintCount | 0) + 1;
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
  _buildHintGhost({ worldX, worldY, baseCells, baseFunnels, rotation, converter, id }) {
    const rot = rotateFactoryShape({ cells: baseCells, funnels: baseFunnels }, rotation);
    const [lcx, lcy] = factoryCenter(rot.cells, this.pxCell, BOARD_GAP);
    // Base center inside root-local coords — root is at the rotated
    // top-left, so the base centroid sits at factoryCenter(baseCells).
    const [baseLcx, baseLcy] = factoryCenter(baseCells, this.pxCell, BOARD_GAP);
    const root = this.add.container(worldX - lcx, worldY - lcy);
    root.setDepth(70);
    // Particles first so they render behind body+funnels.
    const particles = new FunnelParticleSystem(this, root, { pxCell: this.pxCell });
    particles.setFunnels(
      collectFactoryFunnelsForParticles(rot.cells, rot.funnels, this.pxCell, BOARD_GAP, SHAPE_SCALE),
    );
    // Gears before funnels/body so they stack BELOW — matches the
    // board (gearContainer 14 < funnelContainer 15 < interactive 20).
    const gearWrap = this.add.container(baseLcx, baseLcy);
    gearWrap.rotation = (rotation || 0) * Math.PI / 2;
    root.add(gearWrap);
    const ghostGears = renderFactoryGears(this, gearWrap, {
      id: id || 'ghost', cells: baseCells, funnels: baseFunnels,
    }, {
      pxCell: this.pxCell, pxGap: BOARD_GAP, seed: id || 'ghost',
    });
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
      rotation: p.rotation, converter: p.converter, id: p.id,
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
        // Snap-click as the blocker lands back in its blueprint slot.
        playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 });
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
      baseCells, baseFunnels, rotation: startRotation, converter, id: factoryId,
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
      // Click at the moment the ghost snaps into its solution cell —
      // reads as "snapped into place" rather than a silent land.
      playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 });
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
      // Same projector whir the user hears on manual rotation — fires
      // once per 90° step so a 180° auto-rotate sounds twice.
      this._playRotateSfx();
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
    // Layer 1 plays throughout PlayerScene — even while the player is
    // arranging factories before PLAY — so the bed is always under them.
    // Layers 2..5 are progression-tied and only fade in while the sim
    // is running (onSinkHit → fadeInNextLayer). No pause tied to sim
    // state anymore; if the tab blurs, MusicEngine's own blur handler
    // pauses everything and restores on focus.
    this._updateLaserSounds();
    if (this.simState === 'running') {
      this.simTime += delta * (this._fastForwardActive ? 2 : 1);
    }
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
        if (entry.gearWrap) {
          // Gears ride the body pulse — they sit inside the body's
          // footprint so any other scale feels visually detached.
          entry.gearWrap.scaleX = idlePowered ? 1 : sq.body.scaleX;
          entry.gearWrap.scaleY = idlePowered ? 1 : sq.body.scaleY;
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
    // Spin decorative gears — rotation angle tracks cumulativeDistance
    // of simTime so gears slow through shape-slow phases and speed up
    // through the fast phases. simTime stays at 0 while idle so gears
    // sit still until the player presses PLAY.
    for (const ref of this.factoryRefs.values()) {
      if (ref.gears && ref.gears.length) spinFactoryGears(ref.gears, this.simTime);
    }
    for (const ref of this.blueprintRefs.values()) {
      if (ref.gears && ref.gears.length) spinFactoryGears(ref.gears, this.simTime);
    }
    if (this.ghostPulse && this.ghostPulse.gears && this.ghostPulse.gears.length) {
      spinFactoryGears(this.ghostPulse.gears, this.simTime);
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
    // Allow taps on the hint-pill row AND on factory parts that visually
    // hang above/around the slot grid. The reserved-row + outOfBounds
    // flags travel along so _onTapCell can suppress rotation when the
    // grab-point is outside the placement area, and _onDragEnd can
    // refuse drops in those same cells.
    const slot = this._slotAt(px, py, { allowOutside: true });
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

  // Slot hit detection.
  //   Default — returns the in-bounds, non-reserved slot or null. This is
  //     the strict "valid drop target" form used by _onDragEnd.
  //   { allowOutside: true } — also returns reserved-row slots and slots
  //     immediately above/around the grid (within the buffer below) so
  //     the DragController can resolve a factory whose footprint extends
  //     into the hint-pill row OR pokes above the blueprint frame. The
  //     returned slot carries `reserved` and `outOfBounds` flags; the tap
  //     handler reads them to decide whether to rotate (only on a
  //     placement-valid cell) and the drag-end ignores them as drops.
  //
  // The buffer is generous (3 rows above, 1 below/sides) so even tall
  // factories anchored at row 1 with negative-offset cells pick up
  // cleanly when the user grabs by the protruding tip.
  _slotAt(px, py, { allowOutside = false } = {}) {
    const lx = px - this.blueprintOriginX;
    const ly = py - this.blueprintOriginY;
    const c = Math.floor(lx / this.slotPx);
    const r = Math.floor(ly / this.slotPx);
    const rows = this._slotRows();
    const cols = this._slotCols();
    const inGrid = r >= 0 && c >= 0 && r < rows && c < cols
      && lx >= 0 && ly >= 0 && lx <= this.blueprintW && ly <= this.blueprintH;
    const reserved = (this._instructionText() || this._isBossLevel()) && r === 0;
    if (inGrid) {
      if (reserved && !allowOutside) return null;
      return { r, c, reserved, outOfBounds: false };
    }
    if (!allowOutside) return null;
    const buffer = 3;
    if (r >= -buffer && r <= rows && c >= -1 && c <= cols) {
      return { r, c, reserved: false, outOfBounds: true };
    }
    return null;
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
    if (info.kind === 'blueprint') {
      const hit = this._findBlueprintFactoryAt(info.r, info.c);
      if (!hit) return false;
      const def = this.blueprintFactories.get(hit.factoryId);
      if (def && def.interactable === false) return false;
      return true;
    }
    return false;
  }

  _onTapCell(info, pointer) {
    if (!info) return;
    if (this.simState !== 'idle' || this.victory) return;
    if (this._rotateTweenBusy || this._hintTweenBusy) return;
    if (info.kind === 'board') {
      const placed = this._placedAtBoardCell(info.r, info.c);
      if (placed) {
        // Locked factories can't be rotated or dragged — taps read as
        // "this is part of the board furniture", so they get the same
        // metal-hit cue + particle burst as a border funnel.
        if (placed.locked) { this._tapBorderItem(info.r, info.c); return; }
        this._rotatePlaced(placed);
        return;
      }
      // Acid pit tap → splash. Border-funnel tap → metal hit. Both
      // override the default empty-tap rustle so each piece type gets
      // its own tactile cue + particle juice.
      const pit = (this.sourceLevel.acidPits || []).find((p) => p.r === info.r && p.c === info.c);
      if (pit) { this._tapAcidPit(info.r, info.c); return; }
      const borderFunnels = (this.sourceLevel.border && this.sourceLevel.border.funnels) || [];
      const bf = borderFunnels.find((f) => f.r === info.r && f.c === info.c);
      if (bf) { this._tapBorderItem(info.r, info.c); return; }
      this._playEmptyTapRustle(pointer);
    } else if (info.kind === 'blueprint') {
      const hit = this._findBlueprintFactoryAt(info.r, info.c);
      if (!hit) { this._playEmptyTapRustle(pointer); return; }
      const def = this.blueprintFactories.get(hit.factoryId);
      if (!def) return;
      if (def.interactable === false) return;
      // Rotate around the tapped cell — same feel as the editor's
      // draft composer. info.{r,c} is absolute slot coords; the pivot
      // invariant repositions the factory's anchor so the clicked cell
      // stays put.
      // Suppress rotation when the grab landed on a part of the factory
      // that visually hangs OFF the blueprint slot grid — rotating around
      // a pivot outside the grid would punt the rest of the factory into
      // an unplaceable position. The user can still drag the protruding
      // part to pick the factory up; tapping it just no-ops.
      if (info.outOfBounds) { this._playEmptyTapRustle(pointer); return; }
      this._rotateBlueprint(def, { slotR: info.r, slotC: info.c, localCell: hit.localCell });
    }
  }

  // Empty-cell tap on the board or blueprint: fire the same rustle +
  // tiny shape puffs used everywhere else a press lands on "nothing"
  // interactive. Pointer coords come from the DragController so the
  // puff lands under the cursor, not the cell center.
  _playEmptyTapRustle(pointer) {
    playOnce(this.game, 'click_empty', { throttleMs: 60, volume: 0.18 });
    if (pointer) spawnEmptyClickParticles(this, pointer.x, pointer.y);
  }

  // Acid pit tap: splash sound + a tight 8-particle burst centered on
  // the pit cell. Particles use the full Form×Color palette but at
  // half the radius/count of a funnel firework — reads as a splash,
  // not a celebration.
  _tapAcidPit(r, c) {
    playSfxSound(this.game, 'acid_pit_tap', { volume: 0.5 });
    this._spawnCellBurst(r, c, { count: 8, radius: this.pxCell * 0.45, particleR: 4 });
  }

  _tapBorderItem(r, c) {
    playSfxSound(this.game, 'border_item_tap', { volume: 0.5 });
    this._spawnCellBurst(r, c, { count: 10, radius: this.pxCell * 0.5, particleR: 5 });
  }

  // Shared helper that paints an outward-scatter of tiny shapes around
  // a given board cell. Uses the same fxContainer that hosts firework
  // bursts so depth + cleanup match.
  _spawnCellBurst(r, c, { count, radius, particleR }) {
    if (!this.fxContainer) return;
    const step = this.pxCell + BOARD_GAP;
    const cx = this.boardOriginX + c * step + this.pxCell / 2;
    const cy = this.boardOriginY + r * step + this.pxCell / 2;
    spawnFunnelFirework(this, this.fxContainer, {
      x: cx, y: cy, radius, count,
      particleR, strokeW: 1,
    });
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
      if (ref) {
        const shakeTargets = [ref.bodyWrap, ref.funnelWrap];
        if (ref.gearWrap) shakeTargets.push(ref.gearWrap);
        this._shakeRefusal(shakeTargets, (ref.body && ref.body.labels) || []);
      }
      this._playRotateRefusalSfx();
      return;
    }
    if (!ref || !ref.bodyWrap || !ref.funnelWrap) {
      p.rotation = newRot;
      this._renderAll();
      return;
    }
    this._playRotateSfx();
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
    // Gears wrap is anchored at the BASE factory center (fixed across
    // rotations) — only rotate it, don't translate.
    if (ref.gearWrap) {
      this.tweens.add({
        targets: ref.gearWrap,
        rotation: `+=${Math.PI / 2}`,
        duration: 220,
        ease: 'Sine.InOut',
      });
    }
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

  // Rotate a blueprint factory 90° CW. If `pivot` is provided, the
  // rotation pivots around the tapped cell (same rule as the editor's
  // draft composer) — the anchor slides so the clicked cell stays in
  // place. Without a pivot, falls back to rotate-about-self (used by
  // non-tap callers). Out-of-bounds rotations refuse with a shake.
  _rotateBlueprint(def, pivot = null) {
    const ref = this.blueprintRefs.get(def.id);
    const newRot = (def.rotation + 1) % 4;
    const curRot = rotateFactoryShape({ cells: def.baseCells, funnels: def.baseFunnels }, def.rotation || 0);
    const nextRot = rotateFactoryShape({ cells: def.baseCells, funnels: def.baseFunnels }, newRot);

    // Pick the new anchor slot:
    //   • Pivot-based: find the cell index the user tapped, then place
    //     the new anchor so that same cell index lands back at the
    //     pivot's absolute slot.
    //   • Fallback: keep the existing anchor (rotate-about-self).
    let newSlot = { r: def.slot.r, c: def.slot.c };
    if (pivot && pivot.localCell) {
      const idx = curRot.cells.findIndex(
        (cc) => cc.r === pivot.localCell.r && cc.c === pivot.localCell.c,
      );
      if (idx >= 0 && nextRot.cells[idx]) {
        newSlot = {
          r: pivot.slotR - nextRot.cells[idx].r,
          c: pivot.slotC - nextRot.cells[idx].c,
        };
      }
    }

    // Bounds check: factories are allowed to rotate PARTIALLY off the
    // blueprint grid (same rule the editor uses for the draft), so the
    // player can pivot a long bar around a corner cell even when one
    // arm would spill outside the composer. Only reject a rotation
    // that would leave zero cells inside the grid — at that point
    // there's nothing visible to tap for a follow-up rotation.
    const slotRows = this._slotRows();
    const slotCols = this._slotCols();
    const anyInside = nextRot.cells.some((cc) => {
      const r = newSlot.r + cc.r, c = newSlot.c + cc.c;
      return r >= 0 && c >= 0 && r < slotRows && c < slotCols;
    });
    if (!anyInside) {
      if (ref) this._shakeRefusal([ref.bodyWrap, ref.funnelWrap], (ref.body && ref.body.labels) || []);
      this._playRotateRefusalSfx();
      return;
    }

    // Move the factory's blueprint-stack entry to the new anchor slot
    // so _findBlueprintFactoryAt + drag resolution track it correctly.
    const oldSlot = def.slot;
    if (oldSlot.r !== newSlot.r || oldSlot.c !== newSlot.c) {
      const oldKey = slotKey(oldSlot.r, oldSlot.c);
      const stack = this.blueprint.get(oldKey);
      if (stack) {
        const idxInStack = stack.indexOf(def.id);
        if (idxInStack >= 0) stack.splice(idxInStack, 1);
        if (stack.length === 0) this.blueprint.delete(oldKey);
      }
      this._pushToSlot(newSlot, def.id);
    }

    if (!ref || !ref.bodyWrap || !ref.funnelWrap) {
      def.rotation = newRot;
      def.slot = newSlot;
      this._renderBlueprint();
      return;
    }

    const slotPx = this.slotPx;
    const cellsLocal = nextRot.cells.map((c) => ({ ...c }));
    const [cx, cy] = factoryCenter(cellsLocal, slotPx, 0);
    const newWrapX = newSlot.c * slotPx + cx;
    const newWrapY = newSlot.r * slotPx + cy;
    this._playRotateSfx();
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
        def.slot = newSlot;
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
    // Gears at the BASE factory centroid with `rotation * π/2` applied
    // to the wrap — pinned to the same physical cell-edge as the board
    // and blueprint copies.
    const [dragGearCx, dragGearCy] = factoryCenter(baseCells, this.pxCell, BOARD_GAP);
    const gWrap = this.add.container(dragGearCx, dragGearCy);
    gWrap.rotation = (rotation || 0) * Math.PI / 2;
    this.ghostContainer.add(gWrap);
    const fWrap = this.add.container(cx, cy);
    const bWrap = this.add.container(cx, cy);
    this.ghostContainer.add(fWrap);
    this.ghostContainer.add(bWrap);
    const dragGearSet = renderFactoryGears(this, gWrap, {
      id: factoryId, cells: baseCells, funnels: baseFunnels,
    }, {
      pxCell: this.pxCell, pxGap: BOARD_GAP, seed: factoryId,
    });
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
    this.ghostPulse = { bodyWrap: bWrap, funnelWrap: fWrap, gearWrap: gWrap, gears: dragGearSet.gears };
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
    // PlayerScene has no delete island — every drag-end is a placement
    // attempt (board drop, slot drop, or cancel-restore). All three
    // feel like a "snap" so they share the same click cue.
    playOnce(this.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
    if (boardRC && this._tryPlaceOnBoard(boardRC)) { this._clearDrag(); return; }
    // Strict-form _slotAt — null on reserved row + out-of-bounds, so a
    // user who grabbed by a protruding cell and let go on the hint pill
    // (or above the frame) cancels back to the origin instead of dropping
    // into an invalid placement.
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
    // Intro/educational levels can be intentionally factory-less (e.g. level
    // 1 just demonstrates the input→output flow). If no factories are declared
    // anywhere, allow play so the user can run the sim and watch the funnels.
    const lvl = this.sourceLevel;
    const noFactoriesDeclared =
      (lvl.initialFactories || []).length === 0 &&
      (lvl.lockedFactories  || []).length === 0 &&
      (lvl.factories        || []).length === 0;
    if (noFactoriesDeclared) return true;
    return false;
  }

  _startPlay() {
    if (!this._canPlay()) return;
    this.satisfiedOutputs.clear();
    this.satisfiedCollectors.clear();
    this._borderFunnelSounded.clear();
    this.simTime = 0;
    // Reset the shape-exit SFX tracker so the first cycle of this run
    // plays a fresh pop (otherwise RESET → PLAY would skip the first
    // one because cycleIdx lands back at 0).
    this._lastShapeExitCycle = -1;
    // Snap every layer back to its initial state — layer 1 only. All
    // 2..5 stay muted until victory, at which point they swell in
    // together (see _fireVictory → fadeInAllLayers).
    try { resetLayersToInitial(); } catch (e) {}
    this.sim.start(this._composeLevel(), this.simTime);
    this.simState = 'running';
    this._renderIconIsland();
    this._refreshBlueprintPlayButtons();
  }

  _pause() {
    if (this.simState !== 'running') return;
    this.sim.pause(this.simTime);
    this.simState = 'paused';
    this._fastForwardActive = false;
    this._renderIconIsland();
    this._refreshBlueprintPlayButtons();
  }

  _resume() {
    if (this.simState !== 'paused') return;
    this.sim.resume(this.simTime);
    this.simState = 'running';
    this._renderIconIsland();
    this._refreshBlueprintPlayButtons();
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
    if (this._victoryBandDom)  { try { this._victoryBandDom(); } catch (e) {} this._victoryBandDom = null; }
    if (this._victoryTextName) { this._victoryTextName.destroy(); this._victoryTextName = null; }
    if (this._victoryTextSub)  { this._victoryTextSub.destroy();  this._victoryTextSub  = null; }
    this.victory = null;
    // Boss levels: RESET sends the player all the way back to round 1 (no
    // mid-boss save state). Recompose the level for round 0 with no
    // locked carry, then fall through to the standard reset below.
    if (this._bossState && this._sourceLevelOriginal && this._sourceLevelOriginal.boss) {
      this._bossState = { roundIdx: 0, locked: [] };
      this._bossHintAutoShow = true;
      this.sourceLevel = bossRoundLevel(this._sourceLevelOriginal, 0, []);
      this.sim && this.sim.stop();
      if (this.shapeRenderer) this.shapeRenderer.clearAll();
      if (this.bufferMarkerRenderer) this.bufferMarkerRenderer.clearAll();
      this.satisfiedOutputs && this.satisfiedOutputs.clear();
      this.satisfiedCollectors && this.satisfiedCollectors.clear();
      this.simState = 'idle';
      this.simTime = 0;
      this._fastForwardActive = false;
      try { resetLayersToInitial(); } catch (e) {}
      this._initRuntime();
      this._renderAll();
      this._renderBlueprint();
      this._refreshBlueprintPlayButtons();
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
    this._fastForwardActive = false;
    // RESET drops any progression-tied layers so the idle bed is back
    // to layer 1 only. Press PLAY again to start fading them in fresh.
    if (this._musicEventsSeen) this._musicEventsSeen.clear();
    try { resetLayersToInitial(); } catch (e) {}
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
    this._refreshBlueprintPlayButtons();
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
    this._fastForwardActive = false;
    // Re-render so the empty-blueprint PLAY/RESET tiles come back, and the
    // icon-island RESET re-evaluates its enabled state.
    this._renderBlueprint();
    this._refreshBlueprintPlayButtons();
    this._renderIconIsland && this._renderIconIsland();
  }

  _inIconIsland(x, y) {
    const lx = x - this.iconIslandOriginX;
    const ly = y - this.iconIslandOriginY;
    return lx >= 0 && ly >= 0 && lx <= this._iconSlotCount() * this.islandSlotW && ly <= this.islandH;
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


  // Shapes leave their source funnel in bursts every sim cycle — border
  // inputs + any factories whose sinks were satisfied last cycle all
  // fire in the same cycle tick. Throttle by cycle index (not wall
  // clock) so one cycle = exactly one SFX hit regardless of how many
  // shapes spawn or how those spawns stagger across Phaser frames.
  _playShapeExitOnce() {
    if (!this.game) return;
    const cycleIdx = Math.floor(this.simTime / CYCLE_MS);
    if (this._lastShapeExitCycle === cycleIdx) return;
    this._lastShapeExitCycle = cycleIdx;
    playSfxSound(this.game, 'shape_exit', { volume: 0.5 });
  }

  // Per-frame laser sound state machine. Tracks each emitter's
  // power/firing on the sim; plays a one-shot laser_charge when power
  // begins ramping up, a one-shot laser_fire the instant firing latches
  // on, and loops laser_beam continuously while ANY emitter is firing.
  // Multiple simultaneous events dedupe through playOnce's throttle.
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

  // Factory rotation: a projector-whir that plays for exactly the
  // rotation tween duration (220ms), giving the motion a satisfying
  // mechanical sound. Re-firing rapidly (impatient taps) stops the
  // previous instance first so two don't stack.
  _playRotateSfx() {
    if (!this.game) return;
    if (this._rotateSfx) { this._rotateSfx.stop(); this._rotateSfx = null; }
    this._rotateSfx = playTimedSfx(this.game, 'factory_rotate', 220, { volume: 0.45 });
  }

  // Rotation refused (wouldn't fit on board): play a tiny bite of the
  // funnel_wrong sound — enough to register "nope" without the full
  // buzzer playing over the shake.
  _playRotateRefusalSfx() {
    if (!this.game) return;
    playTimedSfx(this.game, 'funnel_wrong', 140, { volume: 0.45 });
  }

  // Multi-shape wall / acid / wrong-output collisions tend to fire in
  // the same frame — walltimer throttle so N simultaneous pops stack to
  // one sound instead of a wall of overlapping copies. 80ms is short
  // enough that a second pop a tenth of a second later still plays.
  _playShapePopOnce() {
    if (!this.game) return;
    const now = this.game.loop.time;
    if (this._shapePopCooldownUntil && now < this._shapePopCooldownUntil) return;
    this._shapePopCooldownUntil = now + 80;
    playSfxSound(this.game, 'shape_pop', { volume: 0.5 });
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
    // Drop fast-forward so the victory celebration plays at normal speed
    // even if the player happened to be holding the >> tile when shapes
    // satisfied the level.
    this._fastForwardActive = false;
    // Telemetry: mark the play complete only on the FINAL boss round (or
    // any non-boss victory). Intermediate boss rounds short-circuited
    // above with their own `victory = true`, so they don't reach here.
    this._playCompleted = true;
    if (this._sourceLevelOriginal && this._sourceLevelOriginal.id) {
      markBeaten(this._sourceLevelOriginal.id);
    } else if (this.sourceLevel.id) {
      markBeaten(this.sourceLevel.id);
    }
    // Daily-featured: when the launch path tagged this run with a UTC
    // date, record the completion so the home panel flips green and the
    // streak math (only same-day completions) advances.
    if (this._featuredUtcDate) {
      markFeaturedCompleted(this._featuredUtcDate);
    }
    // All red border funnels are now satisfied — swell every remaining
    // layer to full volume. If events already unlocked everything this
    // is a no-op; otherwise it fills the mix for the victory hold.
    try { fadeInAllLayers(); } catch (e) {}
    // Community-level victory: stash an id for CommunityScene to pick up
    // and show its rating prompt when the user returns. Writing to the
    // game registry survives scene.start so the data is still there
    // after the level-select transition.
    if (this._communityId) {
      this.game.registry.set('pendingRating', {
        id: this._communityId,
        name: this._communityName,
      });
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
  // The transition plays a celebratory firework at each destroyed red
  // (output) funnel from the round that just cleared, pauses ~600ms, then
  // boots the next round.
  _advanceBossRound() {
    if (!this.scene || !this._isBossWithMoreRounds()) return;
    if (this._hintModal) { this._hintModal.destroy(); this._hintModal = null; }
    this._hintTweenBusy = false;

    // Fire fireworks at every red funnel from the round we're leaving.
    this._playBossRedFireworks(this._bossState.roundIdx);
    // First-clear: hint auto-hides for the remainder of the session.
    this._bossHintAutoShow = false;

    // Hold for one celebratory beat, then swap to the next round.
    this.time.delayedCall(600, () => this._commitBossRoundAdvance());
  }

  _commitBossRoundAdvance() {
    if (!this.scene || !this._bossState) return;
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

  // Spawn a firework burst at each red (output) funnel of the round whose
  // idx is `roundIdx`. Particle container is the border funnel wrap, so
  // effects layer correctly above the exterior checker and below the
  // frame outline.
  _playBossRedFireworks(roundIdx) {
    if (!this._sourceLevelOriginal || !this._sourceLevelOriginal.boss) return;
    const rounds = this._sourceLevelOriginal.boss.rounds || [];
    const fs = (rounds[roundIdx] && rounds[roundIdx].border && rounds[roundIdx].border.funnels) || [];
    const reds = fs.filter((f) => f.role === 'output');
    if (reds.length === 0 || !this.fxContainer) return;
    const step = this.pxCell + BOARD_GAP;
    const radius = Math.max(18, Math.round(this.pxCell * 0.55));
    for (const f of reds) {
      // World-space center of the border cell. Using the persistent
      // fxContainer (not borderFunnelContainer) so the burst survives
      // _clearBoardDynamic when the next round boots.
      const cx = this.boardOriginX + f.c * step + this.pxCell / 2;
      const cy = this.boardOriginY + f.r * step + this.pxCell / 2;
      spawnFunnelFirework(this, this.fxContainer, {
        x: cx, y: cy, radius, count: 14,
      });
    }
  }

  _showVictoryText() {
    if (!this.scene || !this.victory || this._victoryTextName) return;
    // Trumpet fanfare at the top of the victory banner, before the
    // staggered firework volley starts.
    playSfxSound(this.game, 'victory_fanfare', { volume: 0.6 });
    // Anchor the message over the playable board, not the whole scene, so
    // it sits on the interesting bit of the screen.
    const boardCX = this.boardOriginX + this.boardW / 2;
    const rows = this.sourceLevel.board.rows;
    const boardH = rows * this.pxCell + (rows - 1) * BOARD_GAP;
    const boardCY = this.boardOriginY + boardH / 2;
    const bandH = 190;
    const bandTop = boardCY - bandH / 2;
    // Canvas-wide fill inside Phaser, plus DOM strips on each side of
    // the canvas so the dark band reads as a single uninterrupted
    // strip across the whole viewport, letterbox included.
    this._victoryTextBg = this.add.graphics().setDepth(8998);
    this._victoryTextBg.fillStyle(0x000000, 0.45);
    this._victoryTextBg.fillRect(0, bandTop, this.scale.width, bandH);
    this._victoryBandDom = addDomBand({
      canvasTop: bandTop,
      canvasHeight: bandH,
      color: '#000000',
      alpha: 0.45,
    });
    const name = (this.sourceLevel && this.sourceLevel.name) || 'Level';
    this._victoryTextName = this.add.text(boardCX, boardCY - 30, name, {
      fontFamily: 'system-ui, sans-serif', fontSize: '52px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(8999);
    this._victoryTextSub = this.add.text(boardCX, boardCY + 46, 'completed', {
      fontFamily: 'system-ui, sans-serif', fontSize: '36px',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(8999);
    // Tap-to-skip: any pointerdown during the victory banner advances
    // the transition immediately (the SceneFader's own _fading guard
    // makes the auto-timer's later call a no-op).
    if (this.input) {
      this.input.enabled = true;
      this.input.once('pointerdown', () => this._advanceAfterVictory());
    }
    // Launch a staggered volley of 4 fireworks that runs the full length
    // of the banner hold. Each burst fills ~half the board width; they
    // sit around the banner (two above, two below) so the text stays
    // readable.
    this._launchVictoryFireworks(boardCX, boardCY, bandH);
    // Hold the banner for 4s so the name + music swell both have time
    // to register before the transition.
    this.time.delayedCall(4000, () => this._advanceAfterVictory());
  }

  // Staggered level-complete fireworks. Four bursts spread across 4s,
  // placed randomly in the four board quadrants around the banner band
  // (top-left / top-right / bottom-left / bottom-right). Each burst
  // plays `firework.ogg` and scatters 30 colored shape particles that
  // spread to about half the board width.
  _launchVictoryFireworks(boardCX, boardCY, bandH) {
    if (!this.fxContainer) return;
    const top    = this.boardOriginY + 40;
    const bottom = this.boardOriginY + (this.sourceLevel.board.rows * this.pxCell + (this.sourceLevel.board.rows - 1) * BOARD_GAP) - 40;
    const left   = this.boardOriginX + 60;
    const right  = this.boardOriginX + this.boardW - 60;
    const bannerTop    = boardCY - bandH / 2 - 20;
    const bannerBottom = boardCY + bandH / 2 + 20;
    const radius = Math.max(90, Math.round(this.boardW * 0.18));
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const quadrants = [
      () => ({ x: rand(left,       boardCX - 20), y: rand(top,           bannerTop)    }),   // top-left
      () => ({ x: rand(boardCX + 20, right),      y: rand(top,           bannerTop)    }),   // top-right
      () => ({ x: rand(left,       boardCX - 20), y: rand(bannerBottom,  bottom)       }),   // bottom-left
      () => ({ x: rand(boardCX + 20, right),      y: rand(bannerBottom,  bottom)       }),   // bottom-right
    ];
    // Shuffle so the same quadrant order doesn't repeat level-over-level.
    for (let i = quadrants.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [quadrants[i], quadrants[j]] = [quadrants[j], quadrants[i]];
    }
    for (let i = 0; i < quadrants.length; i++) {
      const delay = i * 900 + Math.floor(Math.random() * 180);
      const pos = quadrants[i]();
      this.time.delayedCall(delay, () => {
        if (!this.victory || !this.fxContainer) return;
        spawnFunnelFirework(this, this.fxContainer, {
          x: pos.x, y: pos.y, radius, count: 30,
          particleR: 11, strokeW: 2,
        });
        playSfxSound(this.game, 'firework', { volume: 0.55 });
      });
    }
  }

  _advanceAfterVictory() {
    if (!this.victory) return;           // reset in-flight; abort the auto-advance
    // Victory screen is dismissing — fade layers 2..5 back down to 0
    // over 6 beats, leaving layer 1 audible. The next level's
    // _startPlay snaps everything to "1 on, 2..5 muted" and starts the
    // swell again.
    try { fadeOutToLayerOne(); } catch (e) {}
    const isCommunity = this.sourceLevel.origin === 'local' || this.sourceLevel.origin === 'imported';
    const next = (!isCommunity && this.sourceLevel.id) ? nextLevelAfter(this.sourceLevel.id) : null;
    // Re-enable input so SceneFader's own disable/enable cycle works cleanly.
    if (this.input) this.input.enabled = true;

    // Catalog-level routing detours:
    //  - End of section 4 (level 40) → CREDITS, every time it's beaten.
    //  - End of section 1/2/3 (levels 10/20/30) → unlock cinematic for
    //    the next section (Paint Spill / Acid Swamp / Laser Field).
    //    Plays EVERY time the final round of a stage is cleared, not
    //    just the first time, so the celebratory beat is reliable.
    //    consumeSectionIntro is still called (best-effort) so the
    //    Wild West first-entry detour at PlayerScene.create stays in
    //    sync — it gates a different sectionId so it isn't impacted.
    if (!isCommunity && this.sourceLevel.id) {
      const num = (typeof this.sourceLevel.number === 'number') ? this.sourceLevel.number : null;
      if (num === 40) {
        fadeTo(this, 'Credits');
        return;
      }
      if (num === 10 || num === 20 || num === 30) {
        const newSectionIdx = num / 10; // 10→1 (paint), 20→2 (acid), 30→3 (laser)
        const sectionId = (SECTION_THEMES[newSectionIdx] || {}).id;
        // Mark as seen but don't gate on the result — the cutscene
        // always plays after a stage's final round. If `next` is
        // missing for any reason, fall back to the standard advance.
        consumeSectionIntro(sectionId).catch(() => {});
        if (next) {
          fadeTo(this, 'SectionIntro', { sectionIdx: newSectionIdx, nextLevelId: next.id });
        } else {
          fadeTo(this, isCommunity ? 'Community' : 'LevelSelect');
        }
        return;
      }
    }

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
      onSpawn: (shape) => {
        this.shapeRenderer.spawn(shape);
        this._playShapeExitOnce();
      },
      onRemove: (shape, pop, cause) => {
        this.shapeRenderer.remove(shape, pop, cause);
        // Laser-caused pop: the zap plays at electrocute-start via
        // onShapeElectrocuted, and the actual pop animation fires
        // ELECTROCUTE_MS (400ms) later here — so the two SFX land
        // in the correct order without explicit scheduling.
        if (pop) this._playShapePopOnce();
      },
      onSinkResolve: (funnel, accepted) => {
        this.bufferMarkerRenderer.mark(funnel, accepted);
        // Red border funnels get exactly ONE right/wrong sound per play
        // run — the first shape to arrive. Later arrivals into the same
        // funnel still mark the buffer but stay silent, so a steady
        // stream of correct shapes doesn't chirp every cycle.
        if (funnel.ownerId === 'border' && !this._borderFunnelSounded.has(funnel.key)) {
          this._borderFunnelSounded.add(funnel.key);
          playOnce(this.game, accepted ? 'funnel_right' : 'funnel_wrong', { throttleMs: 120, volume: 0.5 });
        }
        if (accepted && funnel.ownerId === 'border') this._onOutputSatisfied(funnel);
      },
      onSinkHit: (funnel) => {
        // Factory input — whoosh as the shape enters the body.
        // Border sinks get their pull-in cue earlier via
        // onShapeApproachSink; no sound here would double up.
        if (funnel.ownerId !== 'border') {
          playOnce(this.game, 'factory_pass', { throttleMs: 90, volume: 0.15 });
        }
      },
      onShapeApproachSink: () => {
        // Shape has just entered its shrink zone toward a red border
        // funnel — play the suck-in pop here (ahead of the actual
        // sink-hit) so the audio matches the visual pull-in.
        playOnce(this.game, 'funnel_suck', { throttleMs: 40, volume: 0.22 });
      },
      onShapeElectrocuted: () => {
        playOnce(this.game, 'zap', { throttleMs: 100, volume: 0.5 });
      },
      onShapeEnterAcid: () => {
        playOnce(this.game, 'acid_bubble', { throttleMs: 120, volume: 0.22 });
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

function stampEdge(gfx, x1, y1, x2, y2, spacing) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    gfx.fillCircle(x1 + dx * t, y1 + dy * t, 1.3);
  }
}
