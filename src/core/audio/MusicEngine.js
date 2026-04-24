// Layered music bed. All 5 layers play simultaneously on a single loop;
// layer 1 is always audible and layers 2..5 start muted and fade in as
// the player makes progress (factories + red border funnels reached).
//
// Every layer is the same length (trimmed to an exact number of 110 BPM
// sim cycles) so starting them all together keeps them phase-locked —
// the melodic parts stack cleanly.
//
// API:
//   initMusicEngine(game)             — once, from PreloadScene.
//   pauseMusic() / resumeMusic()      — PlayerScene sim-state sync.
//   setActiveLayerCount(n)            — fade-to-active for first N layers.
//   fadeInNextLayer()                 — activate one more layer.
//   fadeInAllLayers()                 — ensure every layer is active.
//   fadeOutAll()                      — ramp every layer down to 0.
//   resetLayersToInitial()            — layer 1 on, 2..5 muted (no fade).

import { BEAT_MS } from '../constants.js';
import { musicGain } from './settings.js';

const LAYER_COUNT   = 3;
const DEFAULT_VOL   = 0.5;
const FADE_IN_MS    = 600;          // initial boot + focus regain
const RESUME_MS     = 200;          // sim-resume ramp
// Every layer fade-in starts on a 4-beat bar boundary and ramps across
// 3 beats — slow enough that the victory swell feels like a reveal
// rather than a snap. Bar grid is anchored to game.loop.time = 0
// (the same clock everything else in the game is phase-locked to via
// render/beat.js).
const BAR_MS        = BEAT_MS * 4;
const LAYER_FADE_MS = BEAT_MS * 3;
// When fadeInAllLayers fires (all outputs satisfied), each still-muted
// layer is queued for its OWN successive bar boundary — bar N, bar N+1,
// bar N+2 … — so the swell tiers in one bar at a time.
const OUT_FADE_MS   = 4000;         // slow fade-out on victory screen dismiss
// Post-victory fade-out to "layer 1 only" — a short couple-of-seconds
// cool-down as the scene transitions.
const OUT_TO_LAYER_ONE_MS = 2000;

function msUntilNextBar(now) {
  const offset = now % BAR_MS;
  if (offset < 0.5) return 0;        // already on a boundary
  return BAR_MS - offset;
}

let engine = null;

export function initMusicEngine(game) {
  if (engine) return engine;
  engine = new MusicEngine(game);
  engine.start();
  return engine;
}

export function pauseMusic()  { if (engine) engine.pause(); }
export function resumeMusic() { if (engine) engine.resume(); }
export function setActiveLayerCount(n) { if (engine) engine.setActiveLayerCount(n); }
export function fadeInNextLayer()      { if (engine) engine.fadeInNextLayer(); }
export function fadeInAllLayers()      { if (engine) engine.fadeInAllLayers(); }
export function fadeInToLayers(n)      { if (engine) engine.fadeInToLayers(n); }
export function fadeOutAll()           { if (engine) engine.fadeOutAll(); }
export function fadeOutToLayerOne(ms)  { if (engine) engine.fadeOutToLayerOne(ms); }
export function resetLayersToInitial() { if (engine) engine.resetLayersToInitial(); }
export function isMusicPlaying() { return !!(engine && engine.tracks[0] && engine.tracks[0].isPlaying); }

class MusicEngine {
  constructor(game) {
    this.game = game;
    // Sound instances for layer_1..layer_N, parallel array.
    this.tracks = new Array(LAYER_COUNT).fill(null);
    // Per-layer fade state: { start, from, to, duration }. null = no fade.
    this.fades  = new Array(LAYER_COUNT).fill(null);
    // Count of layers that are "active" (target volume = DEFAULT_VOL). Layer
    // index 0 (= track "layer_1") starts active; everything above starts at 0.
    this._activeCount = 1;
    this._pausedByBlur = false;
    // Master envelope — drives the initial fade-in + focus-regain ramp.
    // This MULTIPLIES the per-layer volume so all layers ride the same
    // global level while their individual activation curves run.
    this._masterFade = null;
    this._master = 0;
  }

  start() {
    for (let i = 0; i < LAYER_COUNT; i++) {
      const key = `layer_${i + 1}`;
      try {
        const snd = this.game.sound.add(key, { loop: true, volume: 0 });
        snd.play();
        this.tracks[i] = snd;
      } catch (e) {
        console.warn(`[music] failed to start ${key}`, e);
      }
    }
    this._beginMasterFade(FADE_IN_MS);
    this.game.events.on('step',    this._tick, this);
    this.game.events.on('blur',    this._onBlur, this);
    this.game.events.on('hidden',  this._onBlur, this);
    this.game.events.on('focus',   this._onFocus, this);
    this.game.events.on('visible', this._onFocus, this);
  }

  stop() {
    this.game.events.off('step',    this._tick,   this);
    this.game.events.off('blur',    this._onBlur, this);
    this.game.events.off('hidden',  this._onBlur, this);
    this.game.events.off('focus',   this._onFocus, this);
    this.game.events.off('visible', this._onFocus, this);
    for (const snd of this.tracks) {
      if (!snd) continue;
      try { snd.stop(); snd.destroy(); } catch (e) {}
    }
    this.tracks.fill(null);
  }

  pause() {
    for (const snd of this.tracks) {
      if (snd && snd.isPlaying) { try { snd.pause(); } catch (e) {} }
    }
    this._masterFade = null;
    // Snap master to 0 so the next resume() genuinely fades in from
    // silence. Without this the from/to of _beginMasterFade would both
    // be 1 and the bed would slam back at full volume on tab return.
    this._master = 0;
  }

  resume() {
    for (const snd of this.tracks) {
      if (!snd) continue;
      try {
        if (snd.isPaused) snd.resume();
        else if (!snd.isPlaying) snd.play();
      } catch (e) {}
    }
    this._beginMasterFade(RESUME_MS);
  }

  // Low-level setter used by resetLayersToInitial; caller is responsible
  // for any bar-aligned scheduling. Fade-in paths below don't route
  // through this anymore.
  setActiveLayerCount(n) {
    const clamped = Math.max(1, Math.min(LAYER_COUNT, n | 0));
    this._activeCount = clamped;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const target = i < clamped ? DEFAULT_VOL : 0;
      this._beginLayerFade(i, target, LAYER_FADE_MS);
    }
  }

  // Activate exactly one more layer — scheduled to START its fade on
  // the next 4-beat bar boundary and to RAMP across 2 beats. Already
  // marks the layer active so a second event can't pick the same slot.
  fadeInNextLayer() {
    if (this._activeCount >= LAYER_COUNT) return;
    const idx = this._activeCount;
    this._activeCount += 1;
    const now = this.game.loop.time;
    const delay = msUntilNextBar(now);
    this._beginLayerFade(idx, DEFAULT_VOL, LAYER_FADE_MS, delay);
  }

  // Activate every still-muted layer at once — all queued for the SAME
  // next bar boundary so the remaining layers swell together, not in
  // tiers. Already-active layers are left alone.
  fadeInAllLayers() {
    const now = this.game.loop.time;
    const delay = msUntilNextBar(now);
    for (let i = 0; i < LAYER_COUNT; i++) {
      if (i < this._activeCount) continue;
      this._beginLayerFade(i, DEFAULT_VOL, LAYER_FADE_MS, delay);
    }
    this._activeCount = LAYER_COUNT;
  }

  // Bring the active layer count up to `targetCount` in one go — every
  // newly-activated layer starts its fade on the SAME next bar boundary
  // (no per-layer stagger). Used at sim-start to light up layers 2 + 3
  // together.
  fadeInToLayers(targetCount) {
    const target = Math.max(1, Math.min(LAYER_COUNT, targetCount | 0));
    if (target <= this._activeCount) return;
    const now = this.game.loop.time;
    const delay = msUntilNextBar(now);
    for (let i = this._activeCount; i < target; i++) {
      this._beginLayerFade(i, DEFAULT_VOL, LAYER_FADE_MS, delay);
    }
    this._activeCount = target;
  }

  // Fade every layer ABOVE 1 back down to silence. Layer 1 is untouched
  // so the bed stays audible. `durationMs` controls the ramp length;
  // default is the 6-beat post-victory cool-down.
  fadeOutToLayerOne(durationMs = OUT_TO_LAYER_ONE_MS) {
    for (let i = 1; i < LAYER_COUNT; i++) {
      this._beginLayerFade(i, 0, durationMs);
    }
    this._activeCount = 1;
  }

  fadeOutAll() {
    for (let i = 0; i < LAYER_COUNT; i++) {
      this._beginLayerFade(i, 0, OUT_FADE_MS);
    }
    // Active count stays at whatever it was so a later resetLayersToInitial
    // rebuilds from a known starting point.
  }

  resetLayersToInitial() {
    this._activeCount = 1;
    for (let i = 0; i < LAYER_COUNT; i++) {
      // Snap — no fade — since this is called when a fresh run starts
      // and we want layer 1 instantly audible.
      this.fades[i] = null;
      const snd = this.tracks[i];
      if (!snd) continue;
      const v = i === 0 ? DEFAULT_VOL : 0;
      try {
        if (typeof snd.setVolume === 'function') snd.setVolume(v * this._master);
        else snd.volume = v * this._master;
      } catch (e) {}
    }
  }

  _onBlur() {
    this._pausedByBlur = this.tracks.some((s) => s && s.isPlaying);
    this.pause();
  }

  _onFocus() {
    if (this._pausedByBlur) { this.resume(); this._pausedByBlur = false; }
  }

  _beginMasterFade(durationMs) {
    const now = this.game.loop.time;
    this._masterFade = { start: now, from: this._master, to: 1, duration: durationMs };
  }

  _beginLayerFade(idx, target, durationMs, delayMs = 0) {
    if (idx < 0 || idx >= LAYER_COUNT) return;
    const now = this.game.loop.time;
    const current = this._layerVolumeUnmastered(idx);
    if (current === target && delayMs === 0) { this.fades[idx] = null; return; }
    // start is the moment volume begins changing. During [now, start) the
    // layer holds at `from` — that's how the staggered fadeInAllLayers
    // works without each queued layer jumping prematurely.
    this.fades[idx] = { start: now + delayMs, from: current, to: target, duration: durationMs };
  }

  _layerVolumeUnmastered(idx) {
    const fade = this.fades[idx];
    if (!fade) return idx < this._activeCount ? DEFAULT_VOL : 0;
    const now = this.game.loop.time;
    if (now < fade.start) return fade.from;                // delayed — hold
    const elapsed = now - fade.start;
    if (elapsed >= fade.duration) return fade.to;
    const t = elapsed / fade.duration;
    const eased = 1 - (1 - t) * (1 - t);
    return fade.from + (fade.to - fade.from) * eased;
  }

  _tick() {
    const now = this.game.loop.time;

    // Master envelope update.
    if (this._masterFade) {
      const elapsed = now - this._masterFade.start;
      if (elapsed >= this._masterFade.duration) {
        this._master = this._masterFade.to;
        this._masterFade = null;
      } else {
        const t = elapsed / this._masterFade.duration;
        const eased = 1 - (1 - t) * (1 - t);
        this._master = this._masterFade.from + (this._masterFade.to - this._masterFade.from) * eased;
      }
    }

    // Global music gain from audio settings (slider × !muted). Applied
    // as a final multiplier on every layer so mute kills the whole bed
    // in one place, and the slider scales it smoothly.
    const userGain = musicGain();
    // Per-layer envelope + apply.
    for (let i = 0; i < LAYER_COUNT; i++) {
      const snd = this.tracks[i];
      if (!snd) continue;
      const baseVol = this._layerVolumeUnmastered(i);
      // Clear the fade once it's done so we stop recomputing.
      const fade = this.fades[i];
      if (fade && (now - fade.start) >= fade.duration) this.fades[i] = null;
      const v = baseVol * this._master * userGain;
      try {
        if (typeof snd.setVolume === 'function') snd.setVolume(v);
        else snd.volume = v;
      } catch (e) {}
    }
  }
}
