import Phaser from 'phaser';
import { initMusicEngine } from '../audio/MusicEngine.js';
import { installOutsideCanvasClicks, installSfxFocusRamp } from '../audio/sfx.js';
import { loadAudioSettings } from '../audio/settings.js';

// Loads the SFX + music tracks the game plays at runtime and hands off
// to Home. Everything else in the game is rendered via Graphics and
// doesn't need a preload pass.

export default class PreloadScene extends Phaser.Scene {
  constructor() { super({ key: 'Preload' }); }

  preload() {
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

    this.scene.start('Home');
  }
}
