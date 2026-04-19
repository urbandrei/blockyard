import { BOARD_GAP, BUFFER_FILL, BUFFER_FILL_ALT } from '../constants.js';

// Drives the HTML <body> background so the area outside the Phaser canvas
// (the letterbox, when the viewport's aspect doesn't match the 720×1080
// logical canvas) continues the same seamless brown checker as the in-canvas
// surface. Size + origin are recomputed from the current viewport scale, and
// re-applied on scale resize so the pattern tracks when the window changes.
//
// The math (why `X = boardVX - halfTile`): a conic-gradient tile holds a
// 2×2 checker (TL=alt, TR=primary, BL=primary, BR=alt). We want the
// board's tile (0, 0) — which is a PRIMARY cell per `(r+c)&1 = 0` — to line
// up with a primary quadrant in the CSS pattern, so we place the first CSS
// tile's top-left half a cell to the left of the board origin. The TR of
// that tile then sits exactly at the board origin, and every other CSS cell
// falls into place.
//
// Usage: call `wireLetterboxChecker(scene, () => ({ pxCell, boardOriginX,
// boardOriginY }))` after the scene has finished its first layout.

function hex(c) { return '#' + c.toString(16).padStart(6, '0'); }

export function wireLetterboxChecker(scene, getLayout) {
  const apply = () => {
    const layout = getLayout();
    if (!layout || !layout.pxCell) return;
    const { pxCell, boardOriginX, boardOriginY } = layout;
    const step = pxCell + BOARD_GAP;
    const sx = scene.scale.displayScale.x;
    const sy = scene.scale.displayScale.y;

    // Phaser `displayScale` is actually (logicalSize / displaySize) — i.e. a
    // DOWN-scaling factor. To go from logical pixels to viewport pixels we
    // divide by it.
    const stepVX = step / sx;
    const stepVY = step / sy;
    const tileW  = stepVX * 2;
    const tileH  = stepVY * 2;

    // Canvas position in the viewport (top-left in CSS pixels).
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const boardVX = canvasRect.left + boardOriginX / sx;
    const boardVY = canvasRect.top  + boardOriginY / sy;

    const primary = hex(BUFFER_FILL);
    const alt     = hex(BUFFER_FILL_ALT);
    const style   = document.body.style;
    style.backgroundColor   = primary;
    style.backgroundImage   =
      `conic-gradient(${primary} 0 25%, ${alt} 0 50%, ${primary} 0 75%, ${alt} 0 100%)`;
    style.backgroundSize    = `${tileW}px ${tileH}px`;
    // Place the first tile so its TR quadrant (primary) starts exactly at
    // the board origin in viewport pixels.
    style.backgroundPosition = `${boardVX - stepVX}px ${boardVY}px`;
    style.backgroundRepeat   = 'repeat';
  };

  apply();
  scene.scale.on('resize', apply);
  scene.events.once('shutdown', () => {
    scene.scale.off('resize', apply);
  });
  return apply;
}
