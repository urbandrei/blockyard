import Phaser from 'phaser';
import { initMusicEngine } from '../audio/MusicEngine.js';
import { installOutsideCanvasClicks, installSfxFocusRamp } from '../audio/sfx.js';
import { loadAudioSettings } from '../audio/settings.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { LoadingOverlay } from '../ui/LoadingOverlay.js';
import { compute920Box } from '../ui/ContentBox.js';
import { wireLetterboxChecker } from '../ui/LetterboxChecker.js';
import { BOARD_GAP } from '../constants.js';

// Mirror HomeScene's board layout so the bg tiles painted under the
// loading overlay match the size + alignment HomeScene will paint as
// soon as it takes over. Keeps the user from seeing the body bg pattern
// snap to a different scale on the boot-to-home handoff.
const HOME_BOARD_COLS   = 9;
const HOME_BOARD_ROWS   = 9;
const HOME_BOARD_MARGIN = 18;

// Loads the SFX + music tracks the game plays at runtime and hands off
// to Home. Renders a loading screen on first boot via a full-viewport
// DOM canvas overlay (LoadingOverlay) that rains shapes from the top
// and stacks them with simple gravity + collision physics. The overlay
// always plays its full fill + hold animation regardless of how fast
// the audio actually loads, then falls out the bottom to reveal Home
// rendered behind it.

export default class PreloadScene extends Phaser.Scene {
  constructor() { super({ key: 'Preload' }); }

  preload() {
    // Body bg under the (transparent-bg) overlay canvas. We paint it with
    // LetterboxChecker using HomeScene's board layout math so the static
    // pattern is identical to what Home renders — same colors (BUFFER_FILL
    // pair), same tile size (2 × (pxCell + BOARD_GAP)), same board-aligned
    // origin. enableMenuBg installs the .bg-scroll class first so the body
    // has a sensible fallback bg until LetterboxChecker overrides it.
    // We then freeze the inline `animation` so the .bg-scroll keyframe
    // can't drag LetterboxChecker's pinned background-position around.
    enableMenuBg();
    if (typeof document !== 'undefined') {
      document.body.style.animation = 'none';
    }
    wireLetterboxChecker(this, () => this._homeBgLayout());

    // LOADING label, layered above the shape overlay so it stays legible
    // against the colorful pile. Owned by the scene (not the overlay) so
    // it can persist past the shape drop on slow networks — the user
    // sees it through any wait between shapes-gone and audio-loaded.
    this._buildLoadingLabel();

    this._overlay = new LoadingOverlay();
    // The overlay autonomously fills the container with shapes that lock
    // in place. We do NOT trigger exit immediately on fill — instead we
    // wait until BOTH the container is filled AND audio is loaded, then
    // start HomeScene (which fades its main camera up from alpha 0 over
    // ~700ms). Home renders BEHIND the still-locked shapes during that
    // fade. Only after the fade completes do we triggerExit so the
    // shapes drop and reveal a fully-faded-in Home behind.
    this._overlay.setOnFilled(() => {
      this._overlayFilled = true;
      this._maybeStartHome();
    });
    this._overlay.start();

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

    // Audio is loaded now (we're in create()). Tell the overlay it can
    // wrap up its overfill phase fast — this snaps its slow trickle
    // back to the rapid spawn rate so the remaining shapes pile up
    // quickly and the drop fires sooner. The actual scene transition
    // is gated by `_maybeStartHome` so it can't race ahead of the
    // shape-drop animation.
    this._audioReady = true;
    if (this._overlay) this._overlay.signalReady();
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
    if (!this._overlayFilled) return;
    this._sceneStarted = true;

    // Start HomeScene with the fade-in flag. Home's create() runs alpha
    // 0 → 1 over 700ms; during that window the still-locked overlay
    // shapes sit on top, so the user sees Home blooming in BEHIND the
    // shape cloud. PreloadScene itself shuts down here, but the overlay
    // canvas + label DOM are document-level and survive scene teardown.
    this.scene.start('Home', { initialFadeIn: true });

    // Window-scoped timer so it survives PreloadScene's shutdown. Once
    // Home's fade-in is mostly complete, drop the floor and fade the
    // LOADING label. When the shapes have all left the viewport, the
    // overlay's onDone callback removes the label DOM node.
    const HOME_FADE_MS = 700;
    setTimeout(() => {
      if (this._labelEl) this._labelEl.style.opacity = '0';
      if (this._overlay) {
        this._overlay.triggerExit(() => {
          if (this._labelEl && this._labelEl.parentNode) {
            this._labelEl.parentNode.removeChild(this._labelEl);
          }
          this._labelEl = null;
        });
      }
    }, HOME_FADE_MS);
  }

  _buildLoadingLabel() {
    if (typeof document === 'undefined') return;
    const label = document.createElement('div');
    label.id = 'blockyard-loading-label';
    label.textContent = 'LOADING';
    const ls = label.style;
    ls.position      = 'fixed';
    ls.left          = '50%';
    ls.top           = '50%';
    ls.transform     = 'translate(-50%, -50%)';
    ls.zIndex        = '10001';
    ls.pointerEvents = 'none';
    ls.fontFamily    = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    ls.fontWeight    = '900';
    ls.fontSize      = 'clamp(56px, 14vw, 180px)';
    ls.color         = '#000000';
    ls.letterSpacing = '0.04em';
    ls.webkitTextStroke = '4px #ffffff';
    ls.textShadow    =
      '-3px -3px 0 #fff, 3px -3px 0 #fff, -3px 3px 0 #fff, 3px 3px 0 #fff,' +
      ' 0 -3px 0 #fff, 0 3px 0 #fff, -3px 0 0 #fff, 3px 0 0 #fff';
    ls.opacity       = '1';
    ls.transition    = 'opacity 450ms ease-out';
    document.body.appendChild(label);
    this._labelEl = label;
    // No scene-shutdown teardown here — PreloadScene shuts down BEFORE
    // the shapes drop (we start Home first so it can fade in behind the
    // still-locked overlay). The label DOM is removed by the overlay's
    // triggerExit onDone callback once the last shape has left, so the
    // user sees the label persist through the Home fade-in.
  }
}
