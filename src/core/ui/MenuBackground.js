// Toggles the animated diagonal-checker background on the HTML body so the
// menu scenes get a full-viewport checker (not just inside the Phaser
// canvas). The CSS class `.bg-scroll` is defined in index.html with the
// conic-gradient tile + keyframes.
//
// On editor/player scenes, LetterboxChecker.js paints a board-aligned
// static checker inline on body.style — that inline painting overrides the
// class's background-image, but the class's `animation` keeps running on
// whatever `background-position` is now stuck on the inline value. So the
// right thing to do when entering a gameplay scene is to also strip the
// class. `disableMenuBg` does that.

const CLASS = 'bg-scroll';

export function enableMenuBg() {
  if (typeof document === 'undefined') return;
  // Clear any inline background-* leftover from a prior editor/player
  // scene — LetterboxChecker sets these and they outlive scene shutdown.
  const s = document.body.style;
  s.backgroundImage = '';
  s.backgroundSize = '';
  s.backgroundPosition = '';
  document.body.classList.add(CLASS);
}

export function disableMenuBg() {
  if (typeof document === 'undefined') return;
  document.body.classList.remove(CLASS);
}
