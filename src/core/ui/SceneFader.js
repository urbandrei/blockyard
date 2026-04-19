// Scene-transition fade helper. Used everywhere a scene starts another
// scene — fades the current camera out to BG_COLOR, waits for the fade to
// finish, then calls `scene.start`. The incoming scene calls `fadeIn(this)`
// on create to match. Net effect: every navigation between Home / Level
// Select / Community / Editor / Player is a ~240ms brown crossfade instead
// of an instant swap.
//
// Phaser's camera fadeIn/fadeOut tint the camera's rendered output — no
// extra shield needed. During a fadeOut, we disable scene input so stray
// taps don't queue a second transition mid-fade.

// BG_COLOR (0x412722) split into 8-bit RGB for the camera API.
const R = 0x41, G = 0x27, B = 0x22;
const FADE_MS = 220;

export function fadeIn(scene) {
  if (!scene || !scene.cameras || !scene.cameras.main) return;
  scene.cameras.main.fadeIn(FADE_MS, R, G, B);
}

// Fade the current scene out, then start `targetKey` with `data`. Re-
// entering the same helper while a fade is already running is a no-op
// (extra taps during the fade can't queue up).
export function fadeTo(scene, targetKey, data) {
  if (!scene || !scene.cameras || !scene.cameras.main) {
    scene.scene.start(targetKey, data);
    return;
  }
  if (scene._fading) return;
  scene._fading = true;
  scene.input.enabled = false;
  const cam = scene.cameras.main;
  cam.once('camerafadeoutcomplete', () => {
    scene.scene.start(targetKey, data);
  });
  cam.fadeOut(FADE_MS, R, G, B);
}
