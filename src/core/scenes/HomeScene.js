import Phaser from 'phaser';
import {
  loadProgress, isFeaturedCompleted, currentStreak, utcToday,
} from '../progress.js';
import { nextUnbeaten, LEVELS, SECTIONS } from '../catalog/index.js';
import { MAIN_SECTION_COUNT } from '../themes/sectionThemes.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody } from '../render/FactoryBodyRenderer.js';
import { renderFactoryGears, spinFactoryGears } from '../render/FactoryGears.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderBufferLabels } from '../render/BufferLabelRenderer.js';
import {
  renderInteriorFloor, renderExteriorCheckers, renderFrameShadow, renderFrameOutline,
} from '../render/PlayAreaFrame.js';
import { renderAcidPits } from '../render/AcidPitRenderer.js';
import { spawnFunnelFirework } from '../render/FunnelFirework.js';
import { ShapeRenderer } from '../render/ShapeRenderer.js';
import { LaserRenderer } from '../render/LaserRenderer.js';
import { FunnelParticleSystem, collectFunnelsForParticles } from '../render/FunnelParticleSystem.js';
import { Simulation } from '../sim/Simulation.js';
import { shapeSquash } from '../render/pulse.js';
import { genId } from '../model/level.js';
import { COLOR_HEX } from '../model/shape.js';
import { platform } from '../../platform/index.js';
import {
  playOnce, wireUiClicks, spawnEmptyClickParticles,
  playSfxSound, createLoopingSfx,
} from '../audio/sfx.js';
import {
  toggleMusicMuted, toggleSfxMuted, isMusicMuted, isSfxMuted,
  subscribeAudioSettings,
} from '../audio/settings.js';
import { SettingsModal } from '../ui/SettingsModal.js';
import { CreditsModal } from '../ui/CreditsModal.js';
import { SocialInfoModal } from '../ui/SocialInfoModal.js';
import { SOCIAL_CARDS, renderSocialIcon } from '../ui/SocialCards.js';
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
const TYPE_GREEN_TRI   = { form: 'triangle', color: 'green' };

// Factory 1 gets a green body (the "play" factory) to signal QUICK PLAY —
// or yellow once the player has cleared every level in the catalog.
const PLAY_FILL       = 0x4caf50;
const PLAY_STROKE     = 0x2e7a36;
const COMPLETE_FILL   = 0xf5c518;
const COMPLETE_STROKE = 0x8c6d15;

export default class HomeScene extends Phaser.Scene {
  constructor() { super({ key: 'Home' }); }

  async create(data) {
    wireUiClicks(this);
    // wireEmptyClicks is intentionally NOT called here — the scene's
    // own pointerdown handler (installed below) routes empty taps
    // through _tapAcidPit / _tapBorderItem / rustle so each cell
    // kind gets the right sound + juice without two handlers racing.
    disableMenuBg();

    // Initial-boot fade-in: PreloadScene hands off via the LoadingOverlay
    // exit phase (shapes still falling), and tells us to fade the main
    // camera up from the menu-bg color so the home menu arrives smoothly
    // behind the falling shapes instead of snapping into place. Only
    // honored on the very first transition from Preload — re-entries
    // from gameplay scenes use SceneFader's brown overlay instead.
    if (data && data.initialFadeIn) {
      // True opacity fade — Home's content blends with whatever's behind
      // it (the body bg pattern + the LoadingOverlay's still-falling
      // shapes) instead of being painted over with a brown wash.
      this.cameras.main.setAlpha(0);
      this.tweens.add({
        targets: this.cameras.main,
        alpha: 1,
        duration: 700,
        ease: 'Sine.Out',
      });
    }

    // Shareable deep-link: `?level=<id>` on any origin (our Render static
    // site, itch's forwarded query, localhost) jumps straight into the
    // Player. Checked before fadeIn so we don't flash the home screen
    // between the fetch and the scene transition.
    if (await this._handleDeepLink()) return;

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

    // Wild-West-ready: the player has cleared every level in the main
    // four sections AND hasn't beaten a single Wild West level yet.
    // Flips the quick-start button to a "WILD WEST" label that launches
    // the first Wild West level when tapped.
    this._wildWestReady = false;
    this._wildWestNext = null;
    {
      const mainSections = SECTIONS.slice(0, MAIN_SECTION_COUNT);
      const wildSections = SECTIONS.slice(MAIN_SECTION_COUNT);
      const mainAllBeaten = mainSections.every(
        (s) => s.levels.every((l) => beatenSet.has(l.id))
              && (!s.boss || beatenSet.has(s.boss.id)),
      );
      const anyWildBeaten = wildSections.some(
        (s) => s.levels.some((l) => beatenSet.has(l.id))
              || (s.boss && beatenSet.has(s.boss.id)),
      );
      if (mainAllBeaten && !anyWildBeaten && wildSections.length > 0) {
        const first = wildSections[0].levels[0] || null;
        if (first) {
          this._wildWestReady = true;
          this._wildWestNext = first;
        }
      }
    }

    // Daily-featured prefetch — fire-and-forget so a slow backend doesn't
    // delay the rest of the home screen. The panel is built every layout
    // pass; on the first build before this resolves it shows a placeholder
    // and re-paints itself once the data lands.
    this._featuredHistory = [];      // [{ utcDate, levelId, name, author }]
    this._featuredHistoryIdx = 0;    // 0 = newest (today)
    this._featuredView = null;       // currently displayed entry
    this._featuredTodayLevel = null; // full level body for today (cached)
    this._featuredNextRotateMs = 0;
    this._featuredCompletedFlag = false;
    this._featuredLoaded = false;    // true once the async fetches complete (success or empty)
    this._streakCount = 0;
    this._loadFeaturedAsync();

    // Containers. Depths mirror PlayerScene so exterior checker covers the
    // outside of the board via the same cut-out trick.
    this.boardContainer        = this.add.container(0, 0).setDepth(0);
    // Acid pit terrain sits between floor (depth 0) and shapes (depth 10)
    // so pits paint over the checker but behind the flowing units and
    // their particles.
    this.acidPitContainer      = this.add.container(0, 0).setDepth(6);
    // Depth 14 — below funnels (15) and the factory body (20), above
    // shapes (10), so gears read as background machinery that the
    // factory body + funnels render on top of.
    this.gearContainer         = this.add.container(0, 0).setDepth(14);
    // Ambient funnel particles render BELOW shapes so emerging shapes paint
    // over their own preview particles instead of being veiled by them.
    this.factoryFunnelParticleContainer = this.add.container(0, 0).setDepth(8);
    this.shapeContainer        = this.add.container(0, 0).setDepth(10);
    // Laser beams render above shapes so the electrocute flash reads on top.
    this.laserContainer        = this.add.container(0, 0).setDepth(12);
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
    // Tap-burst particles live here — above every board layer but
    // below the toolbar and settings modal.
    this.fxContainer           = this.add.container(0, 0).setDepth(205);
    // Toolbar container for the audio/music/gear icons. Sits above
    // frame + buttons so the icons always catch presses even when the
    // exterior checker paints across the upper-right.
    this.toolbarContainer      = this.add.container(0, 0).setDepth(210);
    // Credits button — a factory-styled tile that sits on the lower-
    // left buffer of the outer border. Same depth family as the
    // toolbar so the exterior checker can't paint over it.
    this.creditsContainer      = this.add.container(0, 0).setDepth(212);
    // Daily-featured panel — sits in the letterbox area above the top
    // buffer of the board. Same depth family as the credits + toolbar
    // so it always reads on top of any background painting.
    this.featuredContainer     = this.add.container(0, 0).setDepth(214);
    // Social-cards carousel — mirrors the featured panel but lives in
    // the BOTTOM letterbox below the playable area.
    this.socialContainer       = this.add.container(0, 0).setDepth(215);

    this.level = this._buildLevel();
    this.factoryRefs   = new Map();   // id → { bodyWrap, funnelWrap }
    this.borderFunnelWraps = null;
    this.bufferLabelWraps  = null;
    this.flowUpdaters = [];
    this._buttons = [];
    this.simTime = 0;

    this._layoutAndRender();

    // Board-cell tap detection for the demo sim. Acid pits and border
    // funnels each get their own sound + particle burst — the same
    // cues the player scene fires, so Home sounds + feels consistent
    // with gameplay. Factory buttons are handled upstream via their
    // own hit rectangles (currentlyOver.length > 0), so we skip those
    // here to avoid double-fire.
    this.input.on('pointerdown', (pointer, currentlyOver) => {
      if (currentlyOver && currentlyOver.length > 0) return;
      const cell = this._boardCellAt(pointer.x, pointer.y);
      if (cell) {
        const pits = (this.level && this.level.acidPits) || [];
        if (pits.some((p) => p.r === cell.r && p.c === cell.c)) {
          this._tapAcidPit(cell.r, cell.c);
          return;
        }
        const bfs = (this.level && this.level.border && this.level.border.funnels) || [];
        if (bfs.some((f) => f.r === cell.r && f.c === cell.c)) {
          this._tapBorderItem(cell.r, cell.c);
          return;
        }
      }
      // Empty click anywhere else — rustle + particle puff, matching
      // the cue used on the player/editor empty cells.
      playOnce(this.game, 'click_empty', { throttleMs: 60, volume: 0.18 });
      spawnEmptyClickParticles(this, pointer.x, pointer.y);
    });

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
      if (this._acidPits) { this._acidPits.destroy(); this._acidPits = null; }
      if (this.laserRenderer) { this.laserRenderer.destroy(); this.laserRenderer = null; }
      if (this._laserBeamSound) {
        this._laserBeamSound.destroy();
        this._laserBeamSound = null;
      }
      if (this._laserPrev) this._laserPrev.clear();
      this._destroyToolbar();
      this._destroyCreditsButton();
      this._destroyFeaturedPanel();
      this._destroySocialPanel();
      if (this._settingsModal) { try { this._settingsModal.destroy(); } catch (e) {} this._settingsModal = null; }
      if (this._creditsModal)  { try { this._creditsModal.destroy();  } catch (e) {} this._creditsModal  = null; }
      if (this._socialModal)   { try { this._socialModal.destroy();   } catch (e) {} this._socialModal   = null; }
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
    // Fac 2 — the LEVEL SELECT button. Funnels are laser emitters on
    // both sides: the border emitter at the right edge of row 5 hits
    // fac 2's right emitter, triggering fac 2's LEFT emitter (sibling
    // hit rule) which shoots outward to the left-border collector.
    // Net visual: a laser beam enters from the right, crosses the
    // factory body, and exits toward the left.
    const fac2 = {
      id: genId(),
      anchor: anchorAt(FACTORY_ROWS_ABS[1]),                // row 5
      cells: rowCells.map((cc) => ({ ...cc })),
      funnels: [
        { r: 0, c: lastCol, side: 'right', role: 'emitter' },
        { r: 0, c: 0,       side: 'left',  role: 'emitter' },
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

    // Border funnels mirror the reference JSON exactly — except the
    // middle row (fac 2's circuit), which is now a laser beam pair
    // instead of a typed shape flow.
    const borderFunnels = [
      // Fac 1 circuit — red triangle, top → right.
      { r: 0, c: FACTORY_COL,         side: 'bottom', role: 'input',  __type: TYPE_RED_TRI    },
      { r: 4, c: BOARD_COLS - 1,      side: 'left',   role: 'output', __type: TYPE_RED_TRI    },
      // Fac 2 circuit — laser. Right-border emitter fires leftward,
      // hits fac 2's right emitter; fac 2's left emitter (sibling)
      // fires leftward into the left-border collector.
      { r: 5, c: BOARD_COLS - 1,      side: 'left',   role: 'emitter'   },
      { r: 5, c: 0,                   side: 'right',  role: 'collector' },
      // Fac 3 circuit — green triangle, one input (left) → two outputs (right + bottom).
      { r: 6, c: 0,                   side: 'right',  role: 'input',  __type: TYPE_GREEN_TRI },
      { r: 6, c: BOARD_COLS - 1,      side: 'left',   role: 'output', __type: TYPE_GREEN_TRI },
      { r: BOARD_ROWS - 1, c: FACTORY_COL + lastCol, side: 'top', role: 'output', __type: TYPE_GREEN_TRI },
    ];

    const inputs  = borderFunnels.filter((f) => f.role === 'input').map(({ __type, ...f }) => ({ ...f, type: { ...__type } }));
    const outputs = borderFunnels.filter((f) => f.role === 'output').map(({ __type, ...f }) => ({ ...f, type: { ...__type } }));

    // Acid pits scattered around the interior. One green pit sits to
    // the LEFT of the BLOCK word (requested); the rest are spread
    // across the playable area so the demo sim routinely retints
    // shapes as they cross them. Placements dodge the vertical red
    // column (abs col 2) and the green horizontal row (abs row 6) so
    // the two live flows stay readable.
    const acidPits = [
      { r: 2, c: 1, label: { color: 'green' } },   // left of BLOCK
      { r: 3, c: 1, label: { color: 'green' } },   // left of YARD
      { r: 1, c: 6, label: { color: 'blue'  } },   // upper-right pocket
      { r: 3, c: 7, label: { color: 'red'   } },   // right of YARD
      { r: 7, c: 3, label: null                },   // below factories — colorless
    ];

    return {
      board: { cols: BOARD_COLS, rows: BOARD_ROWS },
      inputs, outputs,
      border: { funnels: borderFunnels.map(({ __type, ...f }) => ({ ...f })) },
      factories,
      lockedFactories: [],
      initialFactories: [],
      acidPits,
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
    setPos(this.acidPitContainer,      L.boardOriginX, L.boardOriginY);
    if (this.gearContainer) setPos(this.gearContainer, L.boardOriginX, L.boardOriginY);
    if (this.fxContainer) setPos(this.fxContainer, L.boardOriginX, L.boardOriginY);
    setPos(this.shapeContainer,        L.boardOriginX, L.boardOriginY);
    setPos(this.laserContainer,        L.boardOriginX, L.boardOriginY);
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
    this._buildToolbar(L);
    this._buildCreditsButton(L);
    this._buildFeaturedPanel(L);
    this._buildSocialPanel(L);

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

    // Acid pits + laser renderer. Both recreated on relayout so they
    // track the new pxCell.
    if (this._acidPits) { this._acidPits.destroy(); this._acidPits = null; }
    this._acidPits = renderAcidPits(this, this.acidPitContainer, this.level, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
    });
    if (this.laserRenderer) this.laserRenderer.destroy();
    this.laserRenderer = new LaserRenderer(this, this.laserContainer, { pxCell: this.pxCell });

    // Sim + shape renderer. Recreated on relayout so pxCell matches.
    if (this.shapeRenderer) this.shapeRenderer.clearAll && this.shapeRenderer.clearAll();
    this.shapeRenderer = new ShapeRenderer(this, this.shapeContainer, { pxCell: this.pxCell });
    if (this.sim) this.sim.stop();
    this.sim = new Simulation({
      pxCell: this.pxCell,
      pxGap: BOARD_GAP,
      onSpawn: (shape) => {
        this.shapeRenderer.spawn(shape);
        this._playShapeExitOnce();
      },
      onRemove: (shape, pop, cause) => {
        this.shapeRenderer.remove(shape, pop, cause);
        if (pop) this._playShapePopOnce();
      },
      // Border inputs in the demo sim don't get a "delivered" chirp —
      // funnel_right is gameplay feedback and would clash with the
      // ambient bed. funnel_wrong still plays so rejected shapes
      // register audibly.
      onSinkResolve: (funnel, accepted) => {
        if (!accepted && funnel.ownerId === 'border') {
          playOnce(this.game, 'funnel_wrong', { throttleMs: 140, volume: 0.45 });
        }
      },
      onSinkHit: (funnel) => {
        if (funnel.ownerId !== 'border') {
          playOnce(this.game, 'factory_pass', { throttleMs: 90, volume: 0.12 });
        }
      },
      onShapeApproachSink: () => {
        playOnce(this.game, 'funnel_suck', { throttleMs: 40, volume: 0.18 });
      },
      onShapeElectrocuted: () => {
        playOnce(this.game, 'zap', { throttleMs: 100, volume: 0.45 });
      },
      onShapeEnterAcid: () => {
        playOnce(this.game, 'acid_bubble', { throttleMs: 120, volume: 0.2 });
      },
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

  // Cycle-bucketed shape-exit chirp — same pattern as the editor. Uses
  // the sim's own simTime (which ticks forward at ~1x on this scene)
  // rather than wall-clock since the demo sim is the clock here.
  _playShapeExitOnce() {
    if (!this.game) return;
    const cycleIdx = Math.floor((this.simTime || 0) / CYCLE_MS);
    if (this._lastShapeExitCycle === cycleIdx) return;
    this._lastShapeExitCycle = cycleIdx;
    playSfxSound(this.game, 'shape_exit', { volume: 0.5 });
  }

  _playShapePopOnce() {
    if (!this.game) return;
    const now = this.game.loop.time;
    if (this._shapePopCooldownUntil && now < this._shapePopCooldownUntil) return;
    this._shapePopCooldownUntil = now + 80;
    playSfxSound(this.game, 'shape_pop', { volume: 0.5 });
  }

  // Board-cell hit test — returns {r, c} for the cell under (px, py)
  // in world coords, or null if outside. Mirrors PlayerScene's helper
  // so the Home demo answers taps the same way gameplay does.
  _boardCellAt(px, py) {
    const lx = px - this.boardOriginX;
    const ly = py - this.boardOriginY;
    const step = this.pxCell + BOARD_GAP;
    const c = Math.floor(lx / step);
    const r = Math.floor(ly / step);
    const rows = (this.level && this.level.board && this.level.board.rows) || 0;
    const cols = (this.level && this.level.board && this.level.board.cols) || 0;
    if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
    const localX = lx - c * step;
    const localY = ly - r * step;
    if (localX > this.pxCell || localY > this.pxCell) return null;
    return { r, c };
  }

  _tapAcidPit(r, c) {
    playSfxSound(this.game, 'acid_pit_tap', { volume: 0.5 });
    this._spawnCellBurst(r, c, { count: 8, radius: this.pxCell * 0.45, particleR: 4 });
  }

  _tapBorderItem(r, c) {
    playSfxSound(this.game, 'border_item_tap', { volume: 0.5 });
    this._spawnCellBurst(r, c, { count: 10, radius: this.pxCell * 0.5, particleR: 5 });
  }

  _spawnCellBurst(r, c, { count, radius, particleR }) {
    if (!this.fxContainer) return;
    // fxContainer is positioned at the board origin, so burst coords
    // stay board-local.
    const step = this.pxCell + BOARD_GAP;
    const cx = c * step + this.pxCell / 2;
    const cy = r * step + this.pxCell / 2;
    spawnFunnelFirework(this, this.fxContainer, {
      x: cx, y: cy, radius, count,
      particleR, strokeW: 1,
    });
  }

  // Same laser SFX state machine as PlayerScene / EditorScene — a
  // one-shot laser_charge when an emitter's power starts ramping, a
  // one-shot laser_fire the instant firing latches on, and a looped
  // laser_beam while ANY emitter is firing. On Home there's only the
  // fac 2 circuit, but the logic handles an arbitrary set.
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
        playOnce(this.game, 'laser_charge', { throttleMs: 60, volume: 0.35 });
      }
      if (!prev.firing && curFiring) {
        playOnce(this.game, 'laser_fire',   { throttleMs: 60, volume: 0.45 });
      }
      if (curFiring) anyFiring = true;
      prev.power = curPower;
      prev.firing = curFiring;
      this._laserPrev.set(e.key, prev);
    }
    if (anyFiring && !this._laserBeamSound) {
      this._laserBeamSound = createLoopingSfx(this.game, 'laser_beam', 0.22);
    } else if (!anyFiring && this._laserBeamSound) {
      this._laserBeamSound.destroy();
      this._laserBeamSound = null;
    }
  }

  _renderBoard() {
    // Clear dynamic containers before repainting.
    this.factoryRefs.clear();
    for (const f of this.flowUpdaters) { try { f.destroy && f.destroy(); } catch (e) {} }
    this.flowUpdaters = [];
    this.boardContainer.removeAll(true);
    this.funnelContainer.removeAll(true);
    this.interactiveContainer.removeAll(true);
    if (this.gearContainer) this.gearContainer.removeAll(true);
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
    const gearWrap   = this.add.container(cx, cy);
    this.interactiveContainer.add(bodyWrap);
    this.funnelContainer.add(funnelWrap);
    if (this.gearContainer) this.gearContainer.add(gearWrap);

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
    const gearSet = renderFactoryGears(this, gearWrap, {
      id: factory.id, cells: absCells, funnels: absFunnels,
    }, {
      pxCell: this.pxCell, pxGap: BOARD_GAP,
      seed: factory.id,
    });
    this.factoryRefs.set(factory.id, {
      bodyWrap, funnelWrap, gearWrap,
      absCells,
      gears: gearSet.gears,
    });
  }

  // ---------- Buttons ----------

  _buildFactoryButtons(L) {
    const labelFor = (idx) => {
      if (idx === 0) {
        // Wild-West-ready: 40 main levels beaten, 0 wild west beaten →
        // the quick-start tile becomes the entry point for the new
        // biome instead of asking the player to dig through Level Select.
        if (this._wildWestReady) return 'WILD WEST';
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
      if (idx === 0) return () => {
        if (this._wildWestReady && this._wildWestNext) {
          fadeTo(this, 'Player', { levelId: this._wildWestNext.id });
          return;
        }
        if (this._allComplete) { fadeTo(this, 'LevelSelect'); return; }
        if (this._next) fadeTo(this, 'Player', { levelId: this._next.id });
      };
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

  // Upper-right toolbar: three icons (SFX toggle, music toggle, gear).
  // Positioned above the board frame in the exterior-checker region so
  // they sit "outside the border" per the request. Each icon is drawn
  // as Phaser Graphics + a transparent hit rectangle, repainted when
  // the audio-settings subscription fires so mute state stays in sync
  // across icon taps and settings-modal changes.
  _buildToolbar(L) {
    this._destroyToolbar();

    // Icons live inside the TOP-RIGHT border cells of the board — the
    // three cells adjacent to the upper-right corner of the playable
    // area. Glyphs are sized well inside their cells so they read as
    // compact badges rather than filling the whole buffer square.
    const step = L.pxCell + BOARD_GAP;
    const size = Math.max(14, Math.round(L.pxCell * 0.55));
    const cellCenter = (c) => L.boardOriginX + c * step + L.pxCell / 2;
    const cy = L.boardOriginY + L.pxCell / 2;
    // Cells (left-to-right) carry: audio (sfx), music, gear. Nudged
    // one cell left from the corner so the strip sits fully on top
    // buffer cells rather than the corner checker.
    const iconCells = [
      { cx: cellCenter(5) },   // sfx
      { cx: cellCenter(6) },   // music
      { cx: cellCenter(7) },   // gear
    ];

    const makeIcon = (idx, kind) => {
      const cx = iconCells[idx].cx;
      // Each icon lives in its own container so hover/press tweens can
      // scale the glyph around its own center without affecting its
      // siblings. The Graphics is drawn in LOCAL coords (around 0,0)
      // so container.scale + container.rotation act as the pivot.
      const group = this.add.container(cx, cy);
      this.toolbarContainer.add(group);
      const g = this.add.graphics();
      group.add(g);
      // Hit area is decoupled from visual size — even small icons stay
      // easy to tap because the rectangle fills most of the cell.
      const hitSize = Math.max(size + 10, Math.round(L.pxCell * 0.9));
      const hit = this.add.rectangle(0, 0, hitSize, hitSize, 0xffffff, 0.001)
        .setInteractive({ useHandCursor: true });
      group.add(hit);
      return { kind, cx, cy, g, hit, group, size };
    };

    this._toolbarIcons = [
      makeIcon(0, 'sfx'),
      makeIcon(1, 'music'),
      makeIcon(2, 'gear'),
    ];

    const repaintAll = () => {
      for (const it of this._toolbarIcons) {
        it.g.clear();
        const muted =
          it.kind === 'sfx'   ? isSfxMuted()
          : it.kind === 'music' ? isMusicMuted()
          : false;
        // Draw around (0, 0) so container transforms are the pivot.
        drawIcon(it.g, 0, 0, it.size, it.kind, muted);
      }
    };
    repaintAll();

    // Hover / press / release juice. Tweens target the container so
    // scale + rotation pivot around the icon's center (cx, cy) rather
    // than the top-left of the Graphics' internal coords.
    const killTweens = (target) => { try { this.tweens.killTweensOf(target); } catch (e) {} };
    for (const it of this._toolbarIcons) {
      const target = it.group;
      it.hit.on('pointerover', () => {
        killTweens(target);
        this.tweens.add({
          targets: target, scaleX: 1.15, scaleY: 1.15,
          duration: 160, ease: 'Back.Out',
        });
      });
      it.hit.on('pointerout', () => {
        killTweens(target);
        this.tweens.add({
          targets: target, scaleX: 1, scaleY: 1, rotation: 0,
          duration: 180, ease: 'Sine.InOut',
        });
      });
      it.hit.on('pointerdown', () => {
        killTweens(target);
        this.tweens.add({
          targets: target, scaleX: 0.82, scaleY: 0.82, rotation: -0.08,
          duration: 90, ease: 'Sine.Out',
        });
      });
      it.hit.on('pointerup', (pointer, lx, ly, ev) => {
        if (ev) ev.stopPropagation();
        killTweens(target);
        // Snap back past 1.0 for a springy release, then settle.
        this.tweens.add({
          targets: target, scaleX: 1.22, scaleY: 1.22, rotation: 0.05,
          duration: 110, ease: 'Sine.Out',
          onComplete: () => {
            this.tweens.add({
              targets: target, scaleX: 1, scaleY: 1, rotation: 0,
              duration: 180, ease: 'Back.Out',
            });
          },
        });
        if (it.kind === 'sfx')        { toggleSfxMuted();   playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 }); }
        else if (it.kind === 'music') { toggleMusicMuted(); playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 }); }
        else if (it.kind === 'gear')  {
          // Extra little spin on the gear — feels distinctly mechanical
          // versus the two toggles.
          this.tweens.add({
            targets: target, rotation: 0.62, duration: 320, ease: 'Sine.InOut',
            onComplete: () => { target.rotation = 0; },
          });
          this._openSettings();
        }
      });
    }

    // Live sync — if the settings modal changes a mute, the icons
    // redraw without waiting for the next scene event.
    if (this._audioUnsub) this._audioUnsub();
    this._audioUnsub = subscribeAudioSettings(() => repaintAll());
  }

  _destroyToolbar() {
    if (this._audioUnsub) { this._audioUnsub(); this._audioUnsub = null; }
    for (const it of (this._toolbarIcons || [])) {
      try { it.group.destroy(true); } catch (e) {}
    }
    this._toolbarIcons = null;
  }

  _openSettings() {
    if (this._settingsModal) return;
    this._settingsModal = new SettingsModal(this, {
      onClose: () => { this._settingsModal = null; },
    });
  }

  _openCredits() {
    if (this._creditsModal) return;
    this._creditsModal = new CreditsModal(this, {
      onClose: () => { this._creditsModal = null; },
    });
  }

  // Credits tile — factory-shaped button tucked into the lower-left
  // corner of the outer buffer. Same renderFactoryBody + label + tap
  // juice as the LEVEL SELECT / COMMUNITY factories so it reads as
  // part of the same button family, just living outside the playable
  // frame. 2 cells wide at (row = BOARD_ROWS - 1, cols 0..1).
  _buildCreditsButton(L) {
    this._destroyCreditsButton();
    const pxCell = L.pxCell;
    const step = pxCell + BOARD_GAP;
    const row = BOARD_ROWS - 1;
    const colStart = 1;
    const colSpan = 2;
    const localCells = Array.from({ length: colSpan }, (_, c) => ({ r: 0, c }));
    const [localCenterX, localCenterY] = factoryCenter(localCells, pxCell, BOARD_GAP);
    // Center of the cell span in world coords — use BOARD_GAP so the
    // two cells merge visually the same way the factory bars do.
    const cx = L.boardOriginX + colStart * step + localCenterX;
    const cy = L.boardOriginY + row * step + localCenterY;

    const bodyWrap = this.add.container(cx, cy);
    this.creditsContainer.add(bodyWrap);
    const body = renderFactoryBody(this, bodyWrap, {
      cells: localCells, pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    body.setPosition(-localCenterX, -localCenterY);

    const fontSize = Math.max(11, Math.min(26, Math.floor(pxCell * 0.38)));
    const label = this.add.text(0, 0, 'CREDITS', {
      fontFamily: 'system-ui, sans-serif', fontSize: `${fontSize}px`,
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5);
    bodyWrap.add(label);

    const footprintW = localCenterX * 2;
    const hit = this.add.rectangle(cx, cy, footprintW - 4, pxCell - 4, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.creditsContainer.add(hit);

    // Tap juice — mirror the factory buttons so the tile springs +
    // settles on press. No pulse envelope here since the credits tile
    // isn't part of the sim-synced pulse loop; use a direct scale
    // tween instead of a multiplier.
    const killAll = () => { try { this.tweens.killTweensOf(bodyWrap); } catch (e) {} };
    const tweenScale = (to, duration, ease) => {
      killAll();
      this.tweens.add({ targets: bodyWrap, scaleX: to, scaleY: to, duration, ease });
    };
    hit.on('pointerover', () => tweenScale(1.04, 140, 'Sine.Out'));
    hit.on('pointerout',  () => tweenScale(1.0,  180, 'Sine.Out'));
    hit.on('pointerdown', () => tweenScale(0.93,  90, 'Sine.Out'));
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      tweenScale(1.0, 240, 'Back.Out');
      playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 });
      this._openCredits();
    });

    this._creditsButton = { bodyWrap, body, label, hit };
  }

  _destroyCreditsButton() {
    const b = this._creditsButton;
    if (!b) return;
    try { this.tweens.killTweensOf(b.bodyWrap); } catch (e) {}
    try { b.bodyWrap.destroy(true); } catch (e) {}
    try { b.hit.destroy(); } catch (e) {}
    this._creditsButton = null;
  }

  // ---------- Daily-featured panel ----------

  /** Async prefetch — kicks off the network calls and refreshes the panel
   *  once each piece lands. Safe to call multiple times; the panel re-renders
   *  itself idempotently on every refresh. */
  async _loadFeaturedAsync() {
    try {
      const today = await platform.fetchTodaysFeatured();
      if (today && today.entry) {
        this._featuredTodayLevel = today.level || null;
        this._featuredNextRotateMs = today.nextRotateUtcMs || 0;
        // Build a baseline view from today's entry. The history fetch
        // populates the rest of the array right after.
        this._featuredHistory = [{
          utcDate: today.entry.utcDate,
          levelId: today.entry.levelId,
          name: today.name || 'Featured level',
          author: today.author || 'unknown',
        }];
        this._featuredHistoryIdx = 0;
        this._featuredView = this._featuredHistory[0];
      } else if (today && today.nextRotateUtcMs) {
        this._featuredNextRotateMs = today.nextRotateUtcMs;
      }
    } catch (e) { console.warn('[home] today featured failed', e); }

    try {
      const hist = await platform.fetchFeaturedHistory(30);
      if (hist && Array.isArray(hist.entries) && hist.entries.length > 0) {
        // Server returns newest-first; keep that order so idx 0 = today.
        this._featuredHistory = hist.entries.map((e) => ({
          utcDate: e.utcDate,
          levelId: e.levelId,
          name: e.name || 'Featured level',
          author: e.author || 'unknown',
        }));
        // Keep the current view aligned to today (idx 0) on initial load.
        this._featuredHistoryIdx = 0;
        this._featuredView = this._featuredHistory[0];
      }
    } catch (e) { console.warn('[home] featured history failed', e); }

    try { this._streakCount = await currentStreak(); } catch (e) {}
    try {
      if (this._featuredView) {
        this._featuredCompletedFlag = await isFeaturedCompleted(this._featuredView.utcDate);
      }
    } catch (e) {}
    this._featuredLoaded = true;

    // Re-render the panel with the fresh data.
    if (this._featuredPanel) this._refreshFeaturedPanel();
  }

  _buildFeaturedPanel(L) {
    this._destroyFeaturedPanel();
    const pxCell = L.pxCell;
    const step = pxCell + BOARD_GAP;

    // 7×2 cell grid in board-grid units. The factoryCenter helper gives
    // us the local-coords center, then we place the wrap so the panel
    // sits in the letterbox above the board: 1 cell gap above the icon
    // row (which lives at board row 0), then 2 cells of panel.
    const colSpan = 7;
    const rowSpan = 2;
    const localCells = [];
    for (let r = 0; r < rowSpan; r++) {
      for (let c = 0; c < colSpan; c++) localCells.push({ r, c });
    }
    const [localCenterX, localCenterY] = factoryCenter(localCells, pxCell, BOARD_GAP);
    const panelLeftCol = 1;          // 1-cell margin from the board's left edge
    const panelTopRow  = -2;         // -2 -1 are the panel; 0 is the icons row
    const cx = L.boardOriginX + panelLeftCol * step + localCenterX;
    const cy = L.boardOriginY + panelTopRow * step + localCenterY;

    const bodyWrap = this.add.container(cx, cy);
    this.featuredContainer.add(bodyWrap);

    // Body — green when completed, yellow otherwise. Matches the Quick-
    // Play factory's two-state palette (PLAY = green, COMPLETE = yellow)
    // but flipped: the featured panel uses YELLOW as the "active /
    // pulsing" state so it visually pops against the menu's grey-blue
    // chrome, then settles to green once the player has cleared it.
    const completed = !!this._featuredCompletedFlag;
    const fillCol   = completed ? PLAY_FILL   : COMPLETE_FILL;
    const strokeCol = completed ? PLAY_STROKE : COMPLETE_STROKE;
    const body = renderFactoryBody(this, bodyWrap, {
      cells: localCells, pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      fill: fillCol, stroke: strokeCol,
    });
    body.setPosition(-localCenterX, -localCenterY);

    // Geometry for inner content + outer attachments.
    const panelW = colSpan * step - BOARD_GAP;
    const panelH = rowSpan * step - BOARD_GAP;

    // Name + author on the LEFT side of the panel, stacked, bigger fonts.
    // Origin (0, 0.5) so the text grows leftward as it shortens — and
    // both rows share the same x anchor so the stack reads as a column.
    const titleFontSize = Math.max(18, Math.floor(pxCell * 0.62));
    const subFontSize   = Math.max(12, Math.floor(pxCell * 0.36));
    const labelLeftX    = -panelW / 2 + pxCell * 0.55;
    const stackGap      = Math.floor(pxCell * 0.32);

    // Choose label color so it reads against the panel fill — dark text
    // on yellow, white text on green.
    const labelColor = completed ? '#ffffff' : '#1a2332';

    const view = this._featuredView;
    const nameText   = view ? view.name   : 'Loading…';
    const authorText = view ? `by ${view.author}` : '';
    // Slight downward bias so the visual center of the cap-height-only
    // text block aligns with the geometric center of the body. Without
    // it, descender-less labels read as floating slightly above center.
    const verticalBias = Math.floor(pxCell * 0.10);
    const nameLabel = this.add.text(labelLeftX, -stackGap + verticalBias, nameText, {
      fontFamily: 'system-ui, sans-serif', fontSize: `${titleFontSize}px`,
      fontStyle: 'bold', color: labelColor,
    }).setOrigin(0, 0.5);
    bodyWrap.add(nameLabel);
    const authorLabel = this.add.text(labelLeftX, stackGap + verticalBias, authorText, {
      fontFamily: 'system-ui, sans-serif', fontSize: `${subFontSize}px`,
      color: completed ? '#dfe7f0' : '#3a4555',
    }).setOrigin(0, 0.5);
    bodyWrap.add(authorLabel);

    // Timer tag — INSIDE the card, lower-right area. Larger pill below
    // the labels so the countdown is the primary right-side affordance.
    // Streak counter is intentionally stubbed out for now (storage in
    // progress.js still ticks; we just don't render the badge).
    const tagW = Math.max(80, Math.floor(pxCell * 1.7));
    const tagH = Math.max(20, Math.floor(pxCell * 0.50));
    const tagCx = panelW / 2 - tagW / 2 - pxCell * 0.25;     // bodyWrap-local
    const tagCy = panelH / 2 - tagH / 2 - pxCell * 0.18;     // lower half, pushed down
    const tagGfx = this.add.graphics();
    tagGfx.x = tagCx;
    tagGfx.y = tagCy;
    bodyWrap.add(tagGfx);
    const timerFontSize = Math.max(13, Math.floor(tagH * 0.62));
    const timerLabel = this.add.text(tagCx, tagCy, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: `${timerFontSize}px`,
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5);
    bodyWrap.add(timerLabel);

    // "FEATURED!" sticker — circular with wavy edges, jutting out of
    // the top-right corner of the card. Uses the red shape palette so
    // it pops against the yellow body. Slight rotation gives it the
    // hand-stamped look; a subtle wobble tween adds life.
    const stickerOuterR = Math.max(28, Math.floor(pxCell * 0.85));
    const stickerInnerR = Math.floor(stickerOuterR * 0.88);
    const stickerCx = panelW / 2 - stickerOuterR * 0.65;
    const stickerCy = -panelH / 2 + stickerOuterR * 0.40;
    const stickerWrap = this.add.container(stickerCx, stickerCy);
    bodyWrap.add(stickerWrap);
    const stickerGfx = this.add.graphics();
    stickerWrap.add(stickerGfx);
    drawWavySticker(stickerGfx, 0, 0, stickerOuterR, stickerInnerR, 16, 0xd94c4c, 0x5a1010);
    const stickerFontSize = Math.max(10, Math.floor(stickerInnerR * 0.30));
    const stickerLabel = this.add.text(0, 0, 'FEATURED!', {
      fontFamily: 'system-ui, sans-serif', fontSize: `${stickerFontSize}px`,
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5);
    stickerWrap.add(stickerLabel);
    stickerWrap.setRotation(-Math.PI / 12); // -15°
    // Wobble tween — small back-and-forth rotation for life.
    this.tweens.add({
      targets: stickerWrap,
      rotation: { from: -Math.PI / 12 - 0.05, to: -Math.PI / 12 + 0.05 },
      duration: 1100, ease: 'Sine.InOut',
      yoyo: true, repeat: -1,
    });

    // Hit rect over the body for tap-to-launch.
    const hit = this.add.rectangle(cx, cy, panelW - 12, panelH - 4, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.featuredContainer.add(hit);

    // Tap juice — same scale-spring as the credits button, but we ALSO
    // run a continuous breathing pulse on the bodyWrap when the panel is
    // not yet completed, so the user's eye is drawn to today's challenge.
    const killAll = () => { try { this.tweens.killTweensOf(bodyWrap); } catch (e) {} };
    const tweenScale = (to, duration, ease) => {
      killAll();
      this.tweens.add({ targets: bodyWrap, scaleX: to, scaleY: to, duration, ease });
    };
    let pulseTween = null;
    const startPulse = () => {
      if (pulseTween) return;
      // Guard against a stale delayedCall that fires after this panel
      // was torn down by a relayout — scene + container would be gone.
      if (!bodyWrap || !bodyWrap.scene) return;
      pulseTween = this.tweens.add({
        targets: bodyWrap,
        scaleX: 1.025, scaleY: 1.025,
        duration: 600, ease: 'Sine.InOut',
        yoyo: true, repeat: -1,
      });
    };
    const stopPulse = () => {
      if (!pulseTween) return;
      try { pulseTween.stop(); } catch (e) {}
      try { this.tweens.killTweensOf(bodyWrap); } catch (e) {}
      bodyWrap.setScale(1);
      pulseTween = null;
    };
    if (!completed) startPulse();

    hit.on('pointerover', () => { stopPulse(); tweenScale(1.04, 140, 'Sine.Out'); });
    hit.on('pointerout',  () => {
      tweenScale(1.0, 180, 'Sine.Out');
      // Resume pulse only when not completed.
      if (!this._featuredCompletedFlag) {
        // Defer so the tweenScale finishes first.
        this.time.delayedCall(180, () => {
          if (this._featuredPanel && !this._featuredCompletedFlag) startPulse();
        });
      }
    });
    hit.on('pointerdown', () => { stopPulse(); tweenScale(0.93, 90, 'Sine.Out'); });
    hit.on('pointerup', () => {
      tweenScale(1.0, 240, 'Back.Out');
      playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 });
      this._launchFeatured();
    });

    // Arrow buttons — chevrons in the buffer columns OUTSIDE the panel
    // (one cell to the left of the panel's left edge, one cell to the
    // right of the right edge). Cycle through `_featuredHistory`
    // (0 = today, larger idx = older).
    const arrowSize = Math.max(14, Math.floor(pxCell * 0.55));
    const arrowOutsideGap = pxCell * 0.38;
    const arrowLeft  = this._buildFeaturedArrow(cx - panelW / 2 - arrowOutsideGap, cy, arrowSize, 'left',  () => this._cycleFeatured(+1));
    const arrowRight = this._buildFeaturedArrow(cx + panelW / 2 + arrowOutsideGap, cy, arrowSize, 'right', () => this._cycleFeatured(-1));

    this._featuredPanel = {
      bodyWrap, body, hit, nameLabel, authorLabel,
      tagGfx, timerLabel, tagW, tagH,
      stickerWrap, stickerGfx, stickerLabel,
      arrowLeft, arrowRight,
      panelW, panelH, pxCell,
      pulseControls: { startPulse, stopPulse },
    };

    this._refreshFeaturedPanel();
  }

  /** Re-paint the panel's text + completion color + streak badge + arrow
   *  enabled-state. Called after data fetches and after the player cycles
   *  the view via the arrows. Doesn't tear down the panel. */
  async _refreshFeaturedPanel() {
    const p = this._featuredPanel;
    if (!p) return;
    const view = this._featuredView;

    // Completion state for the currently-displayed entry.
    let completed = false;
    try {
      if (view) completed = await isFeaturedCompleted(view.utcDate);
    } catch (e) {}
    this._featuredCompletedFlag = completed;

    // Replace the body so the fill swaps cleanly. Yellow when uncompleted
    // (active state), green when completed.
    if (p.body) try { p.body.destroy(); } catch (e) {}
    const localCells = [];
    const colSpan = 7, rowSpan = 2;
    for (let r = 0; r < rowSpan; r++) for (let c = 0; c < colSpan; c++) localCells.push({ r, c });
    const [lcx, lcy] = factoryCenter(localCells, p.pxCell, BOARD_GAP);
    const fillCol   = completed ? PLAY_FILL   : COMPLETE_FILL;
    const strokeCol = completed ? PLAY_STROKE : COMPLETE_STROKE;
    const body = renderFactoryBody(this, p.bodyWrap, {
      cells: localCells, pxCell: p.pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
      fill: fillCol, stroke: strokeCol,
    });
    body.setPosition(-lcx, -lcy);
    p.bodyWrap.sendToBack(body);
    p.body = body;

    // Re-tint labels for contrast against the new fill — dark on yellow,
    // white on green.
    const labelColor = completed ? '#ffffff' : '#1a2332';
    const subColor   = completed ? '#dfe7f0' : '#3a4555';
    p.nameLabel.setColor(labelColor);
    p.authorLabel.setColor(subColor);

    // Labels + interaction state. When there's no view to show, the
    // panel acts as a passive placeholder — no tap, no pulse.
    if (view) {
      p.nameLabel.setText(view.name);
      p.authorLabel.setText(`by ${view.author}`);
      try { p.hit.setInteractive({ useHandCursor: true }); } catch (e) {}
    } else {
      p.nameLabel.setText(this._featuredLoaded ? 'No featured level yet' : 'Loading…');
      p.authorLabel.setText(this._featuredLoaded ? 'check back tomorrow' : '');
      try { p.hit.disableInteractive(); } catch (e) {}
    }

    // Countdown tag in the lower-right of the card. Visible when we're
    // showing today's entry and have a future rotate timestamp; past
    // entries hide it (no meaningful countdown).
    p.tagGfx.clear();
    if (view && view.utcDate === utcToday() && this._featuredNextRotateMs) {
      p.tagGfx.fillStyle(0x1a2332, 0.92);
      p.tagGfx.fillRoundedRect(-p.tagW / 2, -p.tagH / 2, p.tagW, p.tagH, 8);
      p.tagGfx.lineStyle(2, 0xffffff, 1);
      p.tagGfx.strokeRoundedRect(-p.tagW / 2, -p.tagH / 2, p.tagW, p.tagH, 8);
      p.timerLabel.setVisible(true);
    } else {
      p.timerLabel.setVisible(false);
    }

    // Sticker fades to background when the level has been completed —
    // the green panel + completion glow already telegraph "done".
    if (p.stickerWrap) p.stickerWrap.setAlpha(completed ? 0.55 : 1);

    // Arrow visibility — left moves to OLDER entries (idx +1), right
    // moves to NEWER (idx -1). Hide entirely at boundaries so the
    // player isn't shown an arrow that points to nothing.
    const idx = this._featuredHistoryIdx | 0;
    const histLen = this._featuredHistory ? this._featuredHistory.length : 0;
    if (p.arrowLeft)  p.arrowLeft.setVisible(idx < histLen - 1);
    if (p.arrowRight) p.arrowRight.setVisible(idx > 0);

    // Pulse — bouncing only when not completed AND we're showing today.
    const shouldPulse = !completed && view && view.utcDate === utcToday();
    if (shouldPulse) p.pulseControls.startPulse();
    else p.pulseControls.stopPulse();
  }

  /** Builds a single filled-triangle arrow at (cx, cy) pointing OUTWARD
   *  (away from the panel). `dir` says which side of the panel it sits
   *  on — `'left'` arrow lives on the left and points further left,
   *  `'right'` arrow lives on the right and points further right. Same
   *  triangle geometry the WildWest gate + GO BACK bar use in
   *  LevelSelectScene. Returns a handle with .setEnabled(bool) and a
   *  .destroy() for teardown. */
  _buildFeaturedArrow(cx, cy, size, dir, onTap) {
    const wrap = this.add.container(cx, cy);
    this.featuredContainer.add(wrap);
    const draw = (color, alpha) => {
      const g = this.add.graphics();
      // Stretched vertically vs the WildWest gate's flatter triangle so
      // the arrows read as tall navigation chevrons — taller half-height
      // with the same half-width, giving a slimmer-but-taller silhouette.
      const halfH = size * 0.58;
      const halfW = size * 0.32;
      g.fillStyle(color, alpha);
      g.beginPath();
      if (dir === 'left') {
        // Two vertices on the right, point on the left → '◀'.
        g.moveTo( halfW, -halfH);
        g.lineTo( halfW,  halfH);
        g.lineTo(-halfW, 0);
      } else {
        // Two vertices on the left, point on the right → '▶'.
        g.moveTo(-halfW, -halfH);
        g.lineTo(-halfW,  halfH);
        g.lineTo( halfW, 0);
      }
      g.closePath();
      g.fillPath();
      return g;
    };
    let glyph = draw(0xffffff, 1);
    wrap.add(glyph);
    const hitSize = size * 1.6;
    const hit = this.add.rectangle(cx, cy, hitSize, hitSize, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.featuredContainer.add(hit);

    let enabled = true;
    const repaint = () => {
      try { glyph.destroy(); } catch (e) {}
      glyph = draw(enabled ? 0xffffff : 0xffffff, enabled ? 1 : 0.25);
      wrap.add(glyph);
    };
    const tweenScale = (to, duration, ease) => {
      try { this.tweens.killTweensOf(wrap); } catch (e) {}
      this.tweens.add({ targets: wrap, scaleX: to, scaleY: to, duration, ease });
    };
    hit.on('pointerover', () => { if (enabled) tweenScale(1.15, 160, 'Back.Out'); });
    hit.on('pointerout',  () => tweenScale(1.0, 180, 'Sine.Out'));
    hit.on('pointerdown', () => { if (enabled) tweenScale(0.82, 90, 'Sine.Out'); });
    hit.on('pointerup',   (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      if (!enabled) return;
      // Springy release.
      try { this.tweens.killTweensOf(wrap); } catch (e2) {}
      this.tweens.add({
        targets: wrap, scaleX: 1.22, scaleY: 1.22, duration: 90, ease: 'Sine.Out',
        onComplete: () => this.tweens.add({
          targets: wrap, scaleX: 1, scaleY: 1, duration: 160, ease: 'Back.Out',
        }),
      });
      playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.4 });
      if (onTap) onTap();
    });

    return {
      setEnabled(v) { enabled = !!v; repaint(); hit.input && (hit.input.cursor = v ? 'pointer' : 'default'); },
      setVisible(v) {
        try { wrap.setVisible(v); } catch (e) {}
        try { hit.setVisible(v); v ? hit.setInteractive({ useHandCursor: true }) : hit.disableInteractive(); } catch (e) {}
      },
      destroy() {
        try { glyph.destroy(); } catch (e) {}
        try { wrap.destroy(true); } catch (e) {}
        try { hit.destroy(); } catch (e) {}
      },
    };
  }

  /** Cycle the displayed featured entry. delta = +1 means OLDER, -1 NEWER. */
  _cycleFeatured(delta) {
    const hist = this._featuredHistory || [];
    if (hist.length === 0) return;
    const next = Math.max(0, Math.min(hist.length - 1, (this._featuredHistoryIdx | 0) + delta));
    if (next === this._featuredHistoryIdx) return;
    this._featuredHistoryIdx = next;
    this._featuredView = hist[next];
    this._refreshFeaturedPanel();
  }

  /** Tap-handler for the panel body — launches the displayed featured. */
  async _launchFeatured() {
    const view = this._featuredView;
    if (!view) return;
    // For today's entry we already have the level body cached. For past
    // entries we fetch on demand.
    const today = utcToday();
    if (view.utcDate === today && this._featuredTodayLevel) {
      fadeTo(this, 'Player', {
        levelData: this._featuredTodayLevel,
        communityId: view.levelId,
        communityName: view.name,
        featuredUtcDate: view.utcDate,
      });
      return;
    }
    let payload = null;
    try { payload = await platform.fetchFeaturedByDate(view.utcDate); }
    catch (e) { console.warn('[home] fetchFeaturedByDate failed', e); }
    if (!payload || !payload.level) return;
    fadeTo(this, 'Player', {
      levelData: payload.level,
      communityId: view.levelId,
      communityName: view.name,
      featuredUtcDate: view.utcDate,
    });
  }

  _destroyFeaturedPanel() {
    const p = this._featuredPanel;
    if (!p) return;
    try { this.tweens.killTweensOf(p.bodyWrap); } catch (e) {}
    // bodyWrap.destroy(true) recursively destroys every child: body,
    // labels, circle, streak label, tag, timer label — all cleaned up.
    try { p.bodyWrap.destroy(true); } catch (e) {}
    try { p.hit.destroy(); } catch (e) {}
    try { if (p.arrowLeft)   p.arrowLeft.destroy(); } catch (e) {}
    try { if (p.arrowRight)  p.arrowRight.destroy(); } catch (e) {}
    this._featuredPanel = null;
  }

  /** Recomputes the panel's countdown text. Throttled to once per second
   *  via a stored last-tick timestamp so we don't churn Text.setText every
   *  frame for sub-second precision the user can't see. */
  // ---------- Social cards carousel ----------

  _buildSocialPanel(L) {
    this._destroySocialPanel();
    if (!SOCIAL_CARDS || SOCIAL_CARDS.length === 0) return;
    const pxCell = L.pxCell;
    const step = pxCell + BOARD_GAP;

    // Mirror of the featured panel layout but in the BOTTOM letterbox.
    // 7 cells wide, 2 cells tall, centered horizontally, sitting
    // directly below the board (top edge at row BOARD_ROWS = 9).
    const colSpan = 7;
    const rowSpan = 2;
    const localCells = [];
    for (let r = 0; r < rowSpan; r++) {
      for (let c = 0; c < colSpan; c++) localCells.push({ r, c });
    }
    const [localCenterX, localCenterY] = factoryCenter(localCells, pxCell, BOARD_GAP);
    const panelLeftCol = 1;
    const panelTopRow  = BOARD_ROWS;        // immediately below the board
    const cx = L.boardOriginX + panelLeftCol * step + localCenterX;
    const cy = L.boardOriginY + panelTopRow * step + localCenterY;

    const bodyWrap = this.add.container(cx, cy);
    this.socialContainer.add(bodyWrap);

    // Body — same factory-styled rounded rect as the featured panel,
    // using the standard grey palette so it doesn't visually compete
    // with the featured (which is yellow/green) above the playfield.
    const body = renderFactoryBody(this, bodyWrap, {
      cells: localCells, pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    });
    body.setPosition(-localCenterX, -localCenterY);

    const panelW = colSpan * step - BOARD_GAP;
    const panelH = rowSpan * step - BOARD_GAP;

    // Icon on the LEFT — mirror of the featured panel's right-side
    // sticker. Drawn into a graphics anchored in bodyWrap-local coords.
    const iconSize = Math.max(36, Math.floor(pxCell * 1.05));
    const iconCx = -panelW / 2 + iconSize * 0.55 + pxCell * 0.42;
    const iconWrap = this.add.container(iconCx, 0);
    bodyWrap.add(iconWrap);
    // renderSocialIcon manages the wrap's children (an Image for branded
    // cards, a Graphics for the hand-drawn fallbacks), so we don't
    // pre-create a Graphics here — _refreshSocialPanel populates it.

    // Text stack on the RIGHT of the icon. Title (bold) above subtitle.
    const titleFontSize = Math.max(16, Math.floor(pxCell * 0.50));
    const subFontSize   = Math.max(11, Math.floor(pxCell * 0.32));
    const stackGap      = Math.floor(pxCell * 0.28);
    const verticalBias  = Math.floor(pxCell * 0.10);
    const labelLeftX    = iconCx + iconSize * 0.55 + pxCell * 0.20;
    const titleLabel = this.add.text(labelLeftX, -stackGap + verticalBias, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: `${titleFontSize}px`,
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0, 0.5);
    bodyWrap.add(titleLabel);
    const subLabel = this.add.text(labelLeftX, stackGap + verticalBias, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: `${subFontSize}px`,
      color: '#dfe7f0',
    }).setOrigin(0, 0.5);
    bodyWrap.add(subLabel);

    // Tap hit — full panel area.
    const hit = this.add.rectangle(cx, cy, panelW - 12, panelH - 4, 0xffffff, 0)
      .setInteractive({ useHandCursor: true });
    this.socialContainer.add(hit);

    // Same hover/press scale juice as the featured panel.
    const tweenScale = (to, duration, ease) => {
      try { this.tweens.killTweensOf(bodyWrap); } catch (e) {}
      this.tweens.add({ targets: bodyWrap, scaleX: to, scaleY: to, duration, ease });
    };
    hit.on('pointerover', () => tweenScale(1.03, 140, 'Sine.Out'));
    hit.on('pointerout',  () => tweenScale(1.0, 180, 'Sine.Out'));
    hit.on('pointerdown', () => tweenScale(0.94, 90, 'Sine.Out'));
    hit.on('pointerup', () => {
      tweenScale(1.0, 240, 'Back.Out');
      playOnce(this.game, 'ui_click', { throttleMs: 80, volume: 0.5 });
      this._activateSocialCard();
    });

    // Cycling arrows — same triangle style as the featured panel,
    // tucked just outside the card. The carousel loops, so neither
    // arrow ever needs to be hidden at a boundary.
    const arrowSize = Math.max(14, Math.floor(pxCell * 0.55));
    const arrowOutsideGap = pxCell * 0.38;
    const arrowLeft  = this._buildFeaturedArrow(cx - panelW / 2 - arrowOutsideGap, cy, arrowSize, 'left',  () => this._cycleSocial(-1, true));
    const arrowRight = this._buildFeaturedArrow(cx + panelW / 2 + arrowOutsideGap, cy, arrowSize, 'right', () => this._cycleSocial(+1, true));

    // Dots indicator — one small circle per card, sitting just below
    // the panel. The active card's dot is fully white; others are
    // dimmer outlines.
    const dotsY = cy + panelH / 2 + Math.max(10, Math.floor(pxCell * 0.32));
    const dotR = Math.max(3, Math.floor(pxCell * 0.10));
    const dotGap = dotR * 3;
    const dotsTotalW = (SOCIAL_CARDS.length - 1) * dotGap;
    const dotsStartX = cx - dotsTotalW / 2;
    const dotsGfx = this.add.graphics().setDepth(0);
    this.socialContainer.add(dotsGfx);
    const dotsMeta = { gfx: dotsGfx, count: SOCIAL_CARDS.length, startX: dotsStartX, y: dotsY, gap: dotGap, r: dotR };

    // State: which card is showing + auto-cycle timer (resets on tap).
    if (typeof this._socialIdx !== 'number') this._socialIdx = 0;
    this._socialPanel = {
      bodyWrap, body, hit, iconWrap, iconSize,
      titleLabel, subLabel, arrowLeft, arrowRight,
      dots: dotsMeta, panelW, panelH,
    };
    // First render is instant (no fade) — there's nothing on the panel
    // yet to fade out from. Subsequent calls (from _cycleSocial) animate.
    this._refreshSocialPanel({ instant: true });
    this._startSocialAutoCycle();
  }

  /** Paint the current card's icon + labels + dots. Default behavior
   *  cross-fades the per-card content (icon + title + subtitle) over
   *  ~400ms total — fade out, swap, fade back in — so the carousel
   *  reads as a smooth transition instead of a hard cut. Pass
   *  `{ instant: true }` to skip the fade (used on initial build). The
   *  dots indicator updates immediately either way; the body, hit, and
   *  arrows aren't touched. */
  _refreshSocialPanel(opts = {}) {
    const p = this._socialPanel;
    if (!p) return;
    const idx = ((this._socialIdx | 0) + SOCIAL_CARDS.length) % SOCIAL_CARDS.length;
    this._socialIdx = idx;
    const card = SOCIAL_CARDS[idx];

    // Dots update immediately — they're a navigational signal so the
    // user knows the cycle has happened even before the fade lands.
    const dm = p.dots;
    dm.gfx.clear();
    for (let i = 0; i < dm.count; i++) {
      const x = dm.startX + i * dm.gap;
      if (i === idx) {
        dm.gfx.fillStyle(0xffffff, 1);
        dm.gfx.fillCircle(x, dm.y, dm.r);
      } else {
        dm.gfx.fillStyle(0xffffff, 0.35);
        dm.gfx.fillCircle(x, dm.y, dm.r * 0.85);
      }
    }

    const swapContent = () => {
      p.titleLabel.setText(card.title);
      p.subLabel.setText(card.subtitle || '');
      renderSocialIcon(this, p.iconWrap, card.iconKind, p.iconSize);
    };

    const targets = [p.iconWrap, p.titleLabel, p.subLabel];
    // Kill any in-flight fade so a rapid second cycle doesn't end up
    // mid-tween — the new tween starts fresh from current alpha.
    if (this._socialFadeTween) {
      try { this._socialFadeTween.stop(); } catch (e) {}
      this._socialFadeTween = null;
    }

    if (opts.instant) {
      swapContent();
      for (const t of targets) t.setAlpha(1);
      return;
    }

    this._socialFadeTween = this.tweens.add({
      targets,
      alpha: 0,
      duration: 180,
      ease: 'Sine.Out',
      onComplete: () => {
        swapContent();
        this._socialFadeTween = this.tweens.add({
          targets,
          alpha: 1,
          duration: 220,
          ease: 'Sine.In',
        });
      },
    });
  }

  /** Move the carousel by `delta` and (optionally) reset the auto-cycle
   *  timer so a manual tap doesn't immediately get advanced again. */
  _cycleSocial(delta, manual) {
    if (!this._socialPanel) return;
    this._socialIdx = ((this._socialIdx | 0) + delta + SOCIAL_CARDS.length) % SOCIAL_CARDS.length;
    this._refreshSocialPanel();
    if (manual) this._startSocialAutoCycle();
  }

  _startSocialAutoCycle() {
    if (this._socialAutoTimer) {
      try { this._socialAutoTimer.remove(false); } catch (e) {}
      this._socialAutoTimer = null;
    }
    this._socialAutoTimer = this.time.addEvent({
      delay: 7000, loop: true,
      callback: () => this._cycleSocial(+1, false),
    });
  }

  /** Tap-handler for the panel body — runs whatever the current card's
   *  action is (open external link or pop up a SocialInfoModal). */
  _activateSocialCard() {
    const idx = ((this._socialIdx | 0) + SOCIAL_CARDS.length) % SOCIAL_CARDS.length;
    const card = SOCIAL_CARDS[idx];
    if (!card || !card.action) return;
    const a = card.action;
    if (a.type === 'link' && a.url) {
      try { platform.openExternal(a.url); }
      catch (e) { console.warn('[social] openExternal failed', e); }
      return;
    }
    if (a.type === 'modal') {
      if (this._socialModal) return; // already open
      this._socialModal = new SocialInfoModal(this, {
        title: a.title || card.title,
        body:  a.body  || '',
        onClose: () => { this._socialModal = null; },
      });
    }
  }

  _destroySocialPanel() {
    const p = this._socialPanel;
    if (this._socialAutoTimer) {
      try { this._socialAutoTimer.remove(false); } catch (e) {}
      this._socialAutoTimer = null;
    }
    if (!p) return;
    try { this.tweens.killTweensOf(p.bodyWrap); } catch (e) {}
    try { p.bodyWrap.destroy(true); } catch (e) {}
    try { p.hit.destroy(); } catch (e) {}
    try { if (p.arrowLeft)  p.arrowLeft.destroy(); } catch (e) {}
    try { if (p.arrowRight) p.arrowRight.destroy(); } catch (e) {}
    try { if (p.dots && p.dots.gfx) p.dots.gfx.destroy(); } catch (e) {}
    this._socialPanel = null;
  }

  _tickFeaturedTimer() {
    const p = this._featuredPanel;
    if (!p || !p.timerLabel || !p.timerLabel.visible) return;
    const now = Date.now();
    if (this._featuredLastTimerSec === Math.floor(now / 1000)) return;
    this._featuredLastTimerSec = Math.floor(now / 1000);

    const target = this._featuredNextRotateMs || 0;
    if (!target) { p.timerLabel.setText(''); return; }
    let secs = Math.max(0, Math.floor((target - now) / 1000));
    const h = Math.floor(secs / 3600); secs -= h * 3600;
    const m = Math.floor(secs / 60);   secs -= m * 60;
    const pad = (n) => n < 10 ? `0${n}` : `${n}`;
    p.timerLabel.setText(`${pad(h)}:${pad(m)}:${pad(secs)}`);
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
    // Featured countdown — recompute the HH:MM:SS-until-rotate text once
    // per second. Cheap; just a string replace on a single Phaser.Text.
    this._tickFeaturedTimer();
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
      if (entry.gearWrap)   { entry.gearWrap.scaleX   = sq.body.scaleX    * m; entry.gearWrap.scaleY   = sq.body.scaleY    * m; }
      if (entry.gears && entry.gears.length) spinFactoryGears(entry.gears, this.simTime);
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
      if (this.laserRenderer) this.laserRenderer.update(time, this.sim.lasers, this.sim.emitters);
      this._updateLaserSounds();
    }
    if (this._acidPits) this._acidPits.tick(time);
    if (this.factoryFunnelParticles) this.factoryFunnelParticles.update(time);
    if (this.borderFunnelParticles)  this.borderFunnelParticles.update(time);
  }

  // Returns true when a deep link was handled (and the scene is already
  // fading to Player), so create() can bail before building home UI.
  // Three URL params are supported, resolved in this priority order:
  //   ?s=<code>      — short code, looked up via the API to recover the
  //                    full share-string, then decoded inline.
  //   ?play=<base64> — self-contained share-string. Works for any level
  //                    (even unapproved) without any server round trip.
  //   ?level=<id>    — fetches a public level by server id.
  async _handleDeepLink() {
    let params = null;
    try { params = new URL(window.location.href).searchParams; }
    catch (e) { return false; }
    const shortCode = params.get('s');
    const playB64 = params.get('play');
    const id = params.get('level');
    if (!shortCode && !playB64 && !id) return false;

    // Always strip the param — whether we succeed or not, a page refresh
    // shouldn't replay the deep link forever.
    try { window.history.replaceState({}, '', window.location.pathname); }
    catch (e) {}

    if (shortCode) {
      let resolved = null;
      try { resolved = await platform.resolveShortCode(shortCode); } catch (e) {}
      const body = resolved ? decodeInlineShareString(resolved) : null;
      if (!body) return false;
      fadeTo(this, 'Player', { levelData: body });
      return true;
    }

    if (playB64) {
      const body = decodeInlineShareString(playB64);
      if (!body) return false;
      fadeTo(this, 'Player', { levelData: body });
      return true;
    }

    let res = null;
    try { res = await platform.fetchLevel(id); } catch (e) {}
    const body = res && res.level;
    if (!body) return false;

    fadeTo(this, 'Player', { levelData: body });
    return true;
  }
}

// Inverse of ExportPanel._encodeShareString — accepts either the chunked
// (newline-wrapped) form or a plain base64 string; strips whitespace and
// decodes. Returns null on any parse failure so the caller can fall back
// to the normal Home flow.
function decodeInlineShareString(s) {
  try {
    const clean = String(s || '').replace(/\s+/g, '');
    if (!clean) return null;
    const utf8 = atob(clean);
    const json = decodeURIComponent(escape(utf8));
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) { return null; }
}

// Local copy of the same helper used in PlayerScene / EditorScene — kept
// inline to avoid a new export for a 10-line utility.
function colorToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

// Glyph-style icon drawer for the toolbar. `kind` is one of 'sfx'
// (speaker), 'music' (eighth note), 'gear' (cog). Rendered with a
// BLACK outline at the same 3px weight the flowing shapes + factory
// bodies + frame all share, over a fully transparent interior so the
// exterior checker shows through each glyph. Muted toggles overlay a
// red diagonal slash so the off state reads at a glance.
function drawIcon(g, cx, cy, size, kind, muted) {
  const strokeColor = 0xffffff;
  const strokeW = outlineWidth();
  g.lineStyle(strokeW, strokeColor, 1);

  if (kind === 'sfx') {
    const r = size / 2;
    const nubW = r * 0.45;
    const nubH = r * 0.55;
    // Speaker — nub (small rect) merged into the cone (trapezoid), all
    // as a single closed STROKE-only path.
    g.beginPath();
    g.moveTo(cx - r * 0.85,        cy - nubH / 2);
    g.lineTo(cx - r * 0.85 + nubW, cy - nubH / 2);
    g.lineTo(cx + r * 0.15,        cy - r * 0.95);
    g.lineTo(cx + r * 0.15,        cy + r * 0.95);
    g.lineTo(cx - r * 0.85 + nubW, cy + nubH / 2);
    g.lineTo(cx - r * 0.85,        cy + nubH / 2);
    g.closePath();
    g.strokePath();
    if (!muted) {
      drawArc(g, cx + r * 0.35, cy, r * 0.35, -Math.PI / 3, Math.PI / 3);
      drawArc(g, cx + r * 0.55, cy, r * 0.6,  -Math.PI / 3, Math.PI / 3);
    }
  } else if (kind === 'music') {
    const r = size / 2;
    const stemX = cx + r * 0.1;
    const stemTop = cy - r * 0.85;
    const stemBot = cy + r * 0.45;
    g.beginPath();
    g.moveTo(stemX, stemTop);
    g.lineTo(stemX, stemBot);
    g.strokePath();
    g.beginPath();
    g.moveTo(stemX, stemTop);
    g.lineTo(stemX + r * 0.55, stemTop + r * 0.25);
    g.lineTo(stemX + r * 0.25, stemTop + r * 0.55);
    g.strokePath();
    // Head — outline only (no fill).
    g.strokeEllipse(stemX - r * 0.3, stemBot, r * 0.55, r * 0.4);
  } else if (kind === 'gear') {
    const r = size * 0.4;
    const teeth = 8;
    const innerR = r * 0.65;
    const toothR = r;
    g.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
      const rr = (i % 2 === 0) ? toothR : innerR;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokePath();
    g.strokeCircle(cx, cy, r * 0.32);
  }

  // Muted slash — red diagonal over speaker / note.
  if (muted && (kind === 'sfx' || kind === 'music')) {
    const r = size / 2;
    g.lineStyle(strokeW + 1, 0xd94c4c, 1);
    g.beginPath();
    g.moveTo(cx - r * 0.9, cy - r * 0.9);
    g.lineTo(cx + r * 0.9, cy + r * 0.9);
    g.strokePath();
  }
}

function drawArc(g, cx, cy, r, start, end) {
  const STEPS = 12;
  g.beginPath();
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const a = start + (end - start) * t;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokePath();
}

// Draws a circular sticker / rosette with wavy edges into a Phaser
// graphics object. `points` is the number of "petals"; the perimeter
// is built from 2*points vertices alternating between outerR and innerR
// so the boundary scallops smoothly.
function drawWavySticker(g, cx, cy, outerR, innerR, points, fillColor, strokeColor) {
  const total = points * 2;
  g.fillStyle(fillColor, 1);
  g.beginPath();
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i / total) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fillPath();
  if (strokeColor != null) {
    g.lineStyle(2, strokeColor, 1);
    g.beginPath();
    for (let i = 0; i < total; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = (i / total) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokePath();
  }
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
