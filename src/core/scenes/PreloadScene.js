import Phaser from 'phaser';
import { initMusicEngine } from '../audio/MusicEngine.js';
import { installOutsideCanvasClicks, installSfxFocusRamp } from '../audio/sfx.js';
import { loadAudioSettings } from '../audio/settings.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { PortalCover } from '../ui/PortalCover.js';
import { compute920Box } from '../ui/ContentBox.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { BOARD_GAP } from '../constants.js';
import { resetCutscenes } from '../progress.js';
import { ensureStaticAtlases } from '../render/textures/atlas.js';

// Mirror HomeScene's board layout so the bg tiles painted under the
// preload step match the size + alignment HomeScene will paint as soon
// as it takes over. Keeps the user from seeing the body bg pattern snap
// to a different scale on the boot-to-home handoff.
const HOME_BOARD_COLS   = 9;
const HOME_BOARD_ROWS   = 9;
const HOME_BOARD_MARGIN = 18;

// Loads the SFX + music tracks the game plays at runtime and hands off
// to Home. The brown checker bg painted by LetterboxChecker is what the
// user sees during the audio fetch; once create() runs, HomeScene starts
// with a quick alpha fade-in so the menu arrives smoothly rather than
// snapping in.
//
// Vibej.am 2026 portal arrival is a separate path — `?portal=true` on the
// render build runs PortalCover instead of the standard handoff and goes
// straight to PlayerScene at level-1.

export default class PreloadScene extends Phaser.Scene {
  constructor() { super({ key: 'Preload' }); }

  preload() {
    // vibej.am 2026 portal arrival — when the URL has `?portal=true` AND
    // this is the render build (VIBEJAM=1), we run a quick portal cover
    // animation and dispatch straight to PlayerScene at level-1 rather
    // than HomeScene. The flag is build-time gated so itch / wavedash /
    // etc. ignore the param entirely.
    // eslint-disable-next-line no-undef
    this._portalArrival = (typeof __VIBEJAM__ !== 'undefined') && __VIBEJAM__
      && (typeof window !== 'undefined')
      && new URL(window.location.href).searchParams.has('portal');

    // Body bg shown during the audio fetch. We paint it with
    // LetterboxChecker using HomeScene's board layout math so the static
    // pattern is identical to what Home renders — same colors, same tile
    // size, same board-aligned origin. enableMenuBg installs the
    // .bg-scroll class first so the body has a sensible fallback bg until
    // LetterboxChecker overrides it. We then freeze the inline `animation`
    // so the .bg-scroll keyframe can't drag LetterboxChecker's pinned
    // background-position around.
    enableMenuBg();
    if (typeof document !== 'undefined') {
      document.body.style.animation = 'none';
    }
    wireLetterboxChecker(this, () => this._homeBgLayout());

    if (this._portalArrival) {
      // Portal arrival: run the cover animation, gate the scene swap on
      // its peak. PortalCover lives in PreloadScene's window-scoped
      // closure so it survives the scene transition; PlayerScene's first
      // frame triggers its reveal phase via this._portalCover.
      this._portalCover = new PortalCover({
        onCoverPeak: () => {
          this._coverReady = true;
          this._maybeStartHome();
        },
      });
      this._portalCover.start();
      // Stash on window so PlayerScene can reach it without import
      // gymnastics — the cover is a singleton DOM canvas anyway.
      if (typeof window !== 'undefined') window.__blockyardPortalCover = this._portalCover;
    }

    // Phaser picks the first entry the browser can decode. OGG for
    // desktop Chrome/Firefox + modern Android (smaller / better at the
    // same bitrate); MP3 fallback for iOS Safari + older browsers.
    this.load.audio('shape_exit',   ['audio/shape_exit.ogg',   'audio/shape_exit.mp3']);
    this.load.audio('shape_pop',    ['audio/shape_pop.ogg',    'audio/shape_pop.mp3']);
    this.load.audio('ui_click',     ['audio/ui_click.ogg',     'audio/ui_click.mp3']);
    this.load.audio('funnel_wrong', ['audio/funnel_wrong.ogg', 'audio/funnel_wrong.mp3']);
    this.load.audio('funnel_right', ['audio/funnel_right.ogg', 'audio/funnel_right.mp3']);
    this.load.audio('zap',          ['audio/zap.ogg',          'audio/zap.mp3']);
    this.load.audio('laser_charge', ['audio/laser_charge.ogg', 'audio/laser_charge.mp3']);
    this.load.audio('laser_fire',   ['audio/laser_fire.ogg',   'audio/laser_fire.mp3']);
    this.load.audio('laser_beam',   ['audio/laser_beam.ogg',   'audio/laser_beam.mp3']);
    this.load.audio('acid_bubble',  ['audio/acid_bubble.ogg',  'audio/acid_bubble.mp3']);
    this.load.audio('firework',     ['audio/firework.ogg',     'audio/firework.mp3']);
    this.load.audio('factory_rotate', ['audio/factory_rotate.ogg', 'audio/factory_rotate.mp3']);
    this.load.audio('click_empty',  ['audio/click_empty.ogg',  'audio/click_empty.mp3']);
    this.load.audio('factory_pass', ['audio/factory_pass.ogg', 'audio/factory_pass.mp3']);
    this.load.audio('victory_fanfare', ['audio/victory_fanfare.ogg', 'audio/victory_fanfare.mp3']);
    this.load.audio('acid_pit_tap',   ['audio/acid_pit_tap.ogg',   'audio/acid_pit_tap.mp3']);
    this.load.audio('border_item_tap', ['audio/border_item_tap.ogg', 'audio/border_item_tap.mp3']);
    this.load.audio('funnel_suck',    ['audio/funnel_suck.ogg',    'audio/funnel_suck.mp3']);
    for (let i = 1; i <= 3; i++) {
      this.load.audio(`layer_${i}`, [`audio/layer_${i}.ogg`, `audio/layer_${i}.mp3`]);
    }
    // Standalone celebratory cues — NOT part of the looped 3-layer music
    // bed. layer_5 plays on the section-unlock cinematic; layer_5 + layer_6
    // play together over the end-game credits.
    this.load.audio('layer_5', ['audio/layer_5.ogg', 'audio/layer_5.mp3']);
    this.load.audio('layer_6', ['audio/layer_6.ogg', 'audio/layer_6.mp3']);

    // Brand logos for the Home screen's social-cards carousel. SVGs are
    // loaded as plain images (Phaser rasterizes them at draw time) so
    // they scale cleanly to whatever size the card renders.
    this.load.image('logo_kofi',     'logos/kofi.svg');
    this.load.image('logo_discord',  'logos/discord.svg');
    this.load.image('logo_twitch',   'logos/twitch.svg');
    this.load.image('logo_playables','logos/playables.svg');
    this.load.image('logo_wavedash', 'logos/wavedash.png');
    this.load.image('logo_phaser',   'logos/phaser.png');
    // Decorative gears are stubbed out (see FactoryGears.js) — skip
    // their SVG preload so we don't pay the fetch cost for textures
    // that never get drawn.
  }

  create() {
    const platform = this.registry.get('platform');
    try { platform && platform.gameReady(); } catch (e) { console.warn(e); }

    // Hydrate persisted audio prefs (music / SFX volume + mute state)
    // BEFORE the music bed spins up so the first fade-in reflects the
    // user's saved mix instead of snapping from full volume.
    try { loadAudioSettings(); } catch (e) { console.warn('[audio] settings load failed', e); }
    // Global looping music bed, started once for the life of the game.
    // PlayerScene will pause/resume it on sim state transitions.
    try { initMusicEngine(this.game); } catch (e) { console.warn('[music] init failed', e); }
    // One-shot install of the document-level off-canvas click handler —
    // pointerdown events that land on the letterbox (outside the
    // Phaser canvas) still get a quiet rustle + tiny shape puffs.
    try { installOutsideCanvasClicks(this.game); } catch (e) { console.warn('[sfx] outside-click install failed', e); }
    // Document-level focus/visibility ramp: after an alt-tab or tab
    // switch, SFX gain eases back from 0 → 1 over ~350ms so the first
    // frame of sim catch-up (and any looping laser_beam resuming at
    // full volume) doesn't slam in all at once.
    try { installSfxFocusRamp(); } catch (e) { console.warn('[sfx] focus ramp install failed', e); }

    // Dev console hooks. Open the browser dev console and call
    // `blockyardDev.resetCutscenes()` to wipe the seen-intros list so
    // every section unlock cinematic plays again on the next trigger.
    if (typeof window !== 'undefined') {
      const dev = window.blockyardDev || (window.blockyardDev = {});
      dev.resetCutscenes = async () => {
        const n = await resetCutscenes();
        console.log(`[dev] cleared ${n} seen-intro entries — every section cutscene will play again on next unlock`);
        return n;
      };
    }

    // Bake every game-lifetime texture atlas (shape glyphs, funnel/emitter
    // glyphs, buffer label tiles, X/✓ marks) once. Idempotent — guarded by
    // a registry flag so a hot-reload re-entry no-ops.
    try { ensureStaticAtlases(this); } catch (e) { console.warn('[atlas] static bake failed', e); }

    // Audio + atlases are ready; hand off to Home (or PlayerScene on
    // portal arrival once the cover hits its peak).
    this._audioReady = true;
    this._maybeStartHome();
  }

  // Mirror of HomeScene._computeLayout (9×9 board, 18px margin) so the
  // body bg tiles align exactly between the loading screen and Home.
  _homeBgLayout() {
    const box = compute920Box(this);
    const { boxX, boxY, boxW, boxH } = box;
    const availW = boxW - HOME_BOARD_MARGIN * 2;
    const availH = boxH - HOME_BOARD_MARGIN * 2;
    const cellW = (availW - BOARD_GAP * (HOME_BOARD_COLS - 1)) / HOME_BOARD_COLS;
    const cellH = (availH - BOARD_GAP * (HOME_BOARD_ROWS - 1)) / HOME_BOARD_ROWS;
    const pxCell = Math.max(24, Math.floor(Math.min(cellW, cellH)));
    const boardW = HOME_BOARD_COLS * pxCell + (HOME_BOARD_COLS - 1) * BOARD_GAP;
    const boardH = HOME_BOARD_ROWS * pxCell + (HOME_BOARD_ROWS - 1) * BOARD_GAP;
    const boardOriginX = boxX + Math.round((boxW - boardW) / 2);
    const boardOriginY = boxY + Math.round((boxH - boardH) / 2);
    return { pxCell, boardOriginX, boardOriginY };
  }

  _maybeStartHome() {
    if (this._sceneStarted) return;
    if (!this._audioReady) return;
    // Portal arrivals: wait for PortalCover to hit its peak before
    // dispatching so the cover masks the scene swap.
    if (this._portalArrival && !this._coverReady) return;
    this._sceneStarted = true;

    if (this._portalArrival) {
      // Portal arrival path: clean the ?portal=true off the URL so a
      // refresh doesn't re-enter portal mode, then dispatch straight to
      // PlayerScene at level-1. PortalCover stays on top until
      // PlayerScene's first frame calls triggerExit on it (see the
      // window-scoped reference stashed in preload()).
      try {
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch (e) { /* ignore */ }
      this.scene.start('Player', {
        levelId: 'level-1',
        _skipIntroCheck: true,
      });
      return;
    }

    // Standard path: HomeScene fades its main camera from alpha 0 → 1
    // over ~700ms so the menu eases in over the brown checker bg
    // instead of snapping into place.
    this.scene.start('Home', { initialFadeIn: true });
  }
}
