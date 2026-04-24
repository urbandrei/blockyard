// Throttled SFX player. One entry point, one shared "last played at"
// map so simultaneous events that would cause stacking (multiple shapes
// popping in the same frame, multiple acid hits per tick, etc.) collapse
// into a single audible instance — per the game's no-stacked-overlap
// rule.
//
//   playOnce(game, 'zap', { throttleMs: 80, volume: 0.6 });
//
// The throttle is keyed on the sound key, so different SFX don't block
// each other — a zap + a pop firing simultaneously both play, but two
// zaps firing simultaneously coalesce to one.

import { COLOR_HEX, COLORS, FORMS } from '../model/shape.js';
import { sfxGain, subscribeAudioSettings } from './settings.js';

const lastPlayAt = new Map();

// Transient SFX gain that ramps from 0 → 1 when the tab regains focus
// or visibility. Everything that reads gain multiplies by this too, so
// the first beat after an alt-tab doesn't dump a frame's worth of
// queued/catch-up sounds at full volume. Reset via beginSfxRamp().
let transientGain = 1;
const loopingAppliers = new Set();

function effectiveSfxGain() { return sfxGain() * transientGain; }

// Per-play randomisation to keep one-shot SFX from sounding like a
// clone stamp on repeat fires. ±40 cents of detune is a subtle pitch
// wobble (well under a half-step so a "zap" still reads as "zap"),
// and ±12% on volume nudges each instance up or down without making
// some plays feel missing. Skipped for looping SFX so the laser_beam
// loop doesn't drift off-beat.
function pitchJitter() { return (Math.random() * 2 - 1) * 40; }
function volJitter()   { return 1 + (Math.random() * 2 - 1) * 0.12; }

function applyAllLoops() {
  for (const fn of loopingAppliers) { try { fn(); } catch (e) {} }
}

function beginSfxRamp(durationMs = 350) {
  transientGain = 0;
  applyAllLoops();
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const step = () => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t = Math.min(1, (now - start) / durationMs);
    transientGain = t * t;
    applyAllLoops();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Document-level listeners: visibilitychange handles tab switches;
// window focus handles alt-tab and iframe focus loss. Both trigger a
// fresh ramp so every SFX source (one-shots AND looping beams) eases
// back in from silence rather than resuming mid-burst.
let focusRampInstalled = false;
export function installSfxFocusRamp() {
  if (focusRampInstalled) return;
  focusRampInstalled = true;
  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) beginSfxRamp();
    });
    window.addEventListener('focus', () => beginSfxRamp());
  } catch (e) { /* non-browser env */ }
}

export function playOnce(game, key, opts = {}) {
  if (!game || !key) return;
  const throttleMs = opts.throttleMs != null ? opts.throttleMs : 80;
  const volume     = opts.volume     != null ? opts.volume     : 0.5;
  const delay      = opts.delay      != null ? opts.delay      : 0;    // seconds, WebAudio-scheduled
  const gain = effectiveSfxGain();
  if (gain <= 0) return;
  const now = game.loop.time;
  const last = lastPlayAt.get(key);
  if (last != null && now - last < throttleMs) return;
  lastPlayAt.set(key, now);
  try {
    game.sound.play(key, {
      volume: volume * gain * volJitter(),
      delay,
      detune: pitchJitter(),
    });
  } catch (e) { /* cache miss, ok to drop */ }
}

// Fire-and-forget SFX without playOnce's per-key throttle. Skips when
// SFX are muted (sfxGain() === 0) so the "Audio off" toggle actually
// silences fireworks / shape pops / etc. Scenes that want to coalesce
// same-frame repeats still need their own cycle/cooldown tracking.
export function playSfxSound(game, key, opts = {}) {
  if (!game || !key) return;
  const gain = effectiveSfxGain();
  if (gain <= 0) return;
  const volume = opts.volume != null ? opts.volume : 0.5;
  const delay  = opts.delay  != null ? opts.delay  : 0;
  try {
    game.sound.play(key, {
      volume: volume * gain * volJitter(),
      delay,
      detune: pitchJitter(),
    });
  } catch (e) { /* cache miss, drop */ }
}

// Create a looping SFX (e.g. the laser_beam hum) that tracks live
// changes to sfxGain(): muting drops it to 0, unmuting restores it,
// and dragging the SFX slider scales it in real time. Returns a handle
// with `stop()` / `destroy()` that also tears down the subscription so
// callers don't leak listeners across scene swaps.
export function createLoopingSfx(game, key, baseVolume = 0.3) {
  if (!game || !key) return null;
  let sound = null;
  try {
    sound = game.sound.add(key, { loop: true, volume: baseVolume * effectiveSfxGain() });
    sound.play();
  } catch (e) {
    return null;
  }
  const apply = () => {
    if (!sound) return;
    const v = baseVolume * effectiveSfxGain();
    try {
      if (typeof sound.setVolume === 'function') sound.setVolume(v);
      else sound.volume = v;
    } catch (e) {}
  };
  const unsub = subscribeAudioSettings(apply);
  // Register so the focus-ramp driver can retint volume per animation
  // frame while the transient gain eases back to 1.
  loopingAppliers.add(apply);
  const stop = () => {
    if (!sound) return;
    try { sound.stop(); } catch (e) {}
  };
  const destroy = () => {
    try { unsub(); } catch (e) {}
    loopingAppliers.delete(apply);
    if (!sound) return;
    try { sound.stop(); } catch (e) {}
    try { sound.destroy(); } catch (e) {}
    sound = null;
  };
  return { sound, stop, destroy };
}

// One-shot SFX with an automatic stop after `durationMs`. Used for the
// projector whir during factory rotation and the short funnel_wrong
// bite on refused rotations, both of which need to be cut off before
// their source file ends. Obeys sfxGain so muting silences it, and
// reacts to live gain changes while playing.
export function playTimedSfx(game, key, durationMs, opts = {}) {
  if (!game || !key) return null;
  if (effectiveSfxGain() <= 0) return null;
  const baseVolume = opts.volume != null ? opts.volume : 0.45;
  // Per-instance jitter captured once so apply() doesn't keep
  // re-rolling the volume while the timer is running.
  const vMul = volJitter();
  const dCents = pitchJitter();
  let snd = null;
  try {
    snd = game.sound.add(key, { volume: baseVolume * effectiveSfxGain() * vMul });
    snd.play({ detune: dCents });
  } catch (e) {
    return null;
  }
  const apply = () => {
    if (!snd) return;
    const v = baseVolume * effectiveSfxGain() * vMul;
    try {
      if (typeof snd.setVolume === 'function') snd.setVolume(v);
      else snd.volume = v;
    } catch (e) {}
  };
  const unsub = subscribeAudioSettings(apply);
  loopingAppliers.add(apply);
  const cleanup = () => {
    try { unsub(); } catch (e) {}
    loopingAppliers.delete(apply);
    if (!snd) return;
    try { snd.stop(); } catch (e) {}
    try { snd.destroy(); } catch (e) {}
    snd = null;
  };
  // Use setTimeout since the returned handle isn't scene-scoped —
  // callers can cancel early via the stop() on the handle.
  const timer = setTimeout(cleanup, durationMs);
  return {
    sound: snd,
    stop: () => { clearTimeout(timer); cleanup(); },
  };
}

// Scene-level hook: fire a ui_click on interactive GameObject hits
// (buttons, icons, etc.) via gameobjectdown/up. Gesture-driven scenes
// (editor / player) route DragController taps through a direct
// playOnce(ui_click) call from the controller itself, so factory
// pick-up and cell-tap still sound even though those targets aren't
// interactive GameObjects. The 100ms throttle collapses a tap's
// down+up pair into a single click.
export function wireUiClicks(scene) {
  if (!scene || !scene.input) return;
  const onEvent = () => playOnce(scene.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
  scene.input.on('gameobjectdown', onEvent);
  scene.input.on('gameobjectup',   onEvent);
}

// Scene-level hook: fires when the press lands on truly empty space —
// no interactive GameObject under the pointer. Plays a quiet rustle
// and scatters 2-3 tiny colored shapes that tween out over ~400ms.
// The regular ui_click is suppressed here (wireUiClicks only listens
// to gameobject events) so empty taps get the rustle alone.
export function wireEmptyClicks(scene) {
  if (!scene || !scene.input) return;
  scene.input.on('pointerdown', (pointer, currentlyOver) => {
    if (currentlyOver && currentlyOver.length > 0) return;
    playOnce(scene.game, 'click_empty', { throttleMs: 60, volume: 0.18 });
    spawnEmptyClickParticles(scene, pointer.x, pointer.y);
  });
}

// Global one-time install: any pointerdown outside the Phaser canvas
// (i.e. in the HTML letterbox — the brown checker painted on <body>)
// plays the same rustle + scatters 2-3 tiny shape particles at the
// cursor. Particles are DOM/SVG so they can appear outside the canvas
// pixel bounds; the canvas can't reach there.
let outsideCanvasInstalled = false;
export function installOutsideCanvasClicks(game) {
  if (outsideCanvasInstalled || !game || !game.canvas) return;
  outsideCanvasInstalled = true;
  const canvas = game.canvas;
  document.addEventListener('pointerdown', (ev) => {
    if (ev.target === canvas) return;
    // Skip real HTML controls — text inputs and buttons routinely sit
    // in front of the canvas (TextInputOverlay, etc.). Clicks on them
    // aren't "empty space", they're purposeful.
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return;
    playOnce(game, 'click_empty', { throttleMs: 60, volume: 0.18 });
    spawnDomRustleParticles(ev.clientX, ev.clientY);
  });
}

// Two or three tiny Form×Color shape puffs at (x, y), each drifting
// outward a short distance while scaling + fading to zero. Graphics are
// added at the scene root with a very high depth so the puff reads on
// top of everything including HUD chrome.
export function spawnEmptyClickParticles(scene, x, y) {
  const count = 2 + ((Math.random() * 2) | 0);
  const particleR = 5;
  for (let i = 0; i < count; i++) {
    const form  = FORMS[(Math.random() * FORMS.length)  | 0];
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const fill  = COLOR_HEX[color] || 0xffffff;
    const g = scene.add.graphics().setDepth(9999);
    g.fillStyle(fill, 1);
    g.lineStyle(1, 0x1a2332, 1);
    drawMiniShape(g, particleR, form);
    g.x = x + (Math.random() - 0.5) * 6;
    g.y = y + (Math.random() - 0.5) * 6;
    g.rotation = Math.random() * Math.PI * 2;
    g.setScale(0.8 + Math.random() * 0.5);
    const angle = Math.random() * Math.PI * 2;
    const dist  = 18 + Math.random() * 22;
    scene.tweens.add({
      targets: g,
      x: g.x + Math.cos(angle) * dist,
      y: g.y + Math.sin(angle) * dist,
      scale: 0.05,
      alpha: 0,
      rotation: g.rotation + (Math.random() - 0.5) * Math.PI,
      duration: 320 + Math.random() * 180,
      ease: 'Sine.easeOut',
      onComplete: () => g.destroy(),
    });
  }
}

// DOM equivalent of spawnEmptyClickParticles — renders SVG shapes at
// the viewport (clientX/Y) and animates them outward via the Web
// Animations API. Used for clicks that land outside the Phaser canvas.
const SVG_NS = 'http://www.w3.org/2000/svg';
function spawnDomRustleParticles(x, y) {
  const count = 2 + ((Math.random() * 2) | 0);
  for (let i = 0; i < count; i++) {
    const form  = FORMS[(Math.random() * FORMS.length)  | 0];
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const fill  = '#' + (COLOR_HEX[color] || 0xffffff).toString(16).padStart(6, '0');
    const el = makeSvgShape(form, fill);
    document.body.appendChild(el);
    const jx = x + (Math.random() - 0.5) * 6;
    const jy = y + (Math.random() - 0.5) * 6;
    const angle = Math.random() * Math.PI * 2;
    const dist  = 18 + Math.random() * 22;
    const tx = jx + Math.cos(angle) * dist;
    const ty = jy + Math.sin(angle) * dist;
    const r0 = Math.random() * 360;
    const r1 = r0 + (Math.random() - 0.5) * 180;
    const s0 = 0.8 + Math.random() * 0.5;
    const duration = 320 + Math.random() * 180;
    el.animate([
      { transform: `translate(${jx}px, ${jy}px) translate(-50%, -50%) rotate(${r0}deg) scale(${s0})`, opacity: 1 },
      { transform: `translate(${tx}px, ${ty}px) translate(-50%, -50%) rotate(${r1}deg) scale(0.05)`,  opacity: 0 },
    ], { duration, easing: 'ease-out', fill: 'forwards' }).onfinish = () => el.remove();
  }
}

function makeSvgShape(form, color) {
  const R = 5;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '-7 -7 14 14');
  svg.style.position = 'fixed';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '100000';
  let shape;
  if (form === 'circle') {
    shape = document.createElementNS(SVG_NS, 'circle');
    shape.setAttribute('r', String(R));
  } else if (form === 'square') {
    const s = R * 1.7;
    shape = document.createElementNS(SVG_NS, 'rect');
    shape.setAttribute('x', String(-s / 2));
    shape.setAttribute('y', String(-s / 2));
    shape.setAttribute('width',  String(s));
    shape.setAttribute('height', String(s));
  } else {
    const hb = R * 1.05;
    shape = document.createElementNS(SVG_NS, 'polygon');
    shape.setAttribute('points', `0,${-R * 1.2} ${-hb},${R * 0.8} ${hb},${R * 0.8}`);
  }
  shape.setAttribute('fill', color);
  shape.setAttribute('stroke', '#1a2332');
  shape.setAttribute('stroke-width', '1');
  svg.appendChild(shape);
  return svg;
}

function drawMiniShape(g, r, form) {
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      g.fillRect(-s / 2, -s / 2, s, s);
      g.strokeRect(-s / 2, -s / 2, s, s);
      return;
    }
    case 'triangle': {
      const halfBase = r * 1.05;
      g.beginPath();
      g.moveTo(0,             -r * 1.2);
      g.lineTo(-halfBase,      r * 0.8);
      g.lineTo( halfBase,      r * 0.8);
      g.closePath();
      g.fillPath();
      g.strokePath();
      return;
    }
    case 'circle':
    default:
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
  }
}
