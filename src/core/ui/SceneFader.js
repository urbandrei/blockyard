// Scene-transition fade helper. Used everywhere a scene starts another
// scene — fades a viewport-sized DOM overlay to opaque brown, waits for
// the fade to finish, then calls `scene.start`. The incoming scene calls
// `fadeIn(this)` on create to fade the same overlay back to transparent.
// Net effect: every navigation between Home / Level Select / Community /
// Editor / Player is a ~220ms brown crossfade that covers the entire
// viewport — the Phaser canvas AND the HTML letterbox around it (the
// `.bg-scroll` animated checker on <body>).
//
// Phaser's camera fadeIn/fadeOut only tints the canvas's rendered output,
// so any menu-background pixels outside the canvas would keep scrolling
// through the transition. Using a `position: fixed; inset: 0` DOM overlay
// layered above everything gives us a true full-viewport fade.

const FADE_MS = 220;
const OVERLAY_ID = 'blockyard-scene-fade-overlay';

function getOverlay() {
  if (typeof document === 'undefined') return null;
  return document.getElementById(OVERLAY_ID);
}

function ensureOverlay() {
  if (typeof document === 'undefined') return null;
  let el = getOverlay();
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.background = '#412722';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '9998';
    el.style.opacity = '0';
    document.body.appendChild(el);
  }
  return el;
}

// Animate the overlay's opacity from `fromA` to `toA` using the scene's
// tween manager. Returns the tween so callers can attach onComplete.
function animateOverlay(scene, fromA, toA, onComplete) {
  const el = ensureOverlay();
  if (!el || !scene || !scene.tweens) {
    if (el) el.style.opacity = String(toA);
    if (onComplete) onComplete();
    return null;
  }
  const state = { a: fromA };
  el.style.opacity = String(fromA);
  return scene.tweens.add({
    targets: state, a: toA, duration: FADE_MS, ease: 'Sine.InOut',
    onUpdate: () => { el.style.opacity = String(state.a); },
    onComplete: () => {
      el.style.opacity = String(toA);
      if (onComplete) onComplete();
    },
  });
}

export function fadeIn(scene) {
  if (!scene) return;
  // Phaser keeps scene instances alive across scene.start, so the
  // `_fading` flag and the disabled input from a prior fadeTo() would
  // carry over into this create() unless we explicitly reset them.
  // Without this the user would return to Home and find every button
  // dead because fadeTo() short-circuits on `_fading`.
  scene._fading = false;
  if (scene.input) scene.input.enabled = true;
  // Skip on first page load: no prior fadeTo means no overlay exists yet
  // (or it's already transparent), so there's nothing to fade — otherwise
  // the initial HomeScene would flash brown on boot.
  const el = getOverlay();
  if (!el) return;
  const current = parseFloat(el.style.opacity) || 0;
  if (current <= 0.001) return;
  animateOverlay(scene, current, 0);
}

// Fade out via the viewport overlay, then start `targetKey` with `data`.
// Re-entering while a fade is already running is a no-op (extra taps
// during the fade can't queue up).
export function fadeTo(scene, targetKey, data) {
  if (!scene || !scene.scene) return;
  if (scene._fading) return;
  scene._fading = true;
  if (scene.input) scene.input.enabled = false;
  const tween = animateOverlay(scene, 0, 1, () => {
    scene.scene.start(targetKey, data);
  });
  // Degenerate case: no tween manager (e.g. headless). Start immediately.
  if (!tween) scene.scene.start(targetKey, data);
}
