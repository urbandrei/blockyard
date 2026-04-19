import {
  BOARD_GAP,
  INTERIOR_FILL, INTERIOR_FILL_ALT,
  BUFFER_FILL, BUFFER_FILL_ALT,
  outlineWidth,
} from '../constants.js';

// Three-pass renderer for the scene's tiled surface + the interior frame.
// The user's mental model: the brown checkerboard is a foreground surface
// with a rectangular hole cut out of it, through which the peach "floor" +
// the sim contents (shapes, funnels, factories, flow) peek. The black frame
// is the window around the hole.
//
// Layering (back → front), each in its own container at those depths:
//   peach floor (container depth 0)
//   sim contents (flow / shapes / funnels / factory bodies)
//   brown cut-out (container depth 25)  ← this is what turns everything
//                                           outside the interior opaque
//   frame + inner shadow + buffer labels (container depth 30)
//
// Each pass below is a separate export so scenes can plug them into the
// right container.

const FRAME_COLOR   = 0x000000;
export const FRAME_PAD     = 4;
export const FRAME_RADIUS  = 10;

// Inner-shadow band recipe. Each entry = { inset: px, alpha: 0..1 } for a
// 1-px stroke at that inset inside the frame. More bands closer to the edge
// produce a clearer dark-vignette look.
const SHADOW_COLOR  = 0x000000;
const SHADOW_BANDS  = [
  { inset: 1,  alpha: 0.75 },
  { inset: 2,  alpha: 0.65 },
  { inset: 3,  alpha: 0.55 },
  { inset: 4,  alpha: 0.45 },
  { inset: 5,  alpha: 0.35 },
  { inset: 7,  alpha: 0.25 },
  { inset: 10, alpha: 0.15 },
  { inset: 14, alpha: 0.08 },
];

// Pass 1 — peach checker over interior cells. Drawn at the very back.
export function renderInteriorFloor(scene, container, { board, pxCell }) {
  const gfx = scene.make.graphics({ add: false });
  const step = pxCell + BOARD_GAP;
  const rFrom = 1, rTo = board.rows - 2;
  const cFrom = 1, cTo = board.cols - 2;
  if (rTo < rFrom || cTo < cFrom) return null;
  for (let r = rFrom; r <= rTo; r++) {
    for (let c = cFrom; c <= cTo; c++) {
      // Parity convention mirrors the buffer checker: parity 0 = DARKER
      // cell in both regions, parity 1 = LIGHTER. Keeps the alternating
      // light/dark pattern continuous across the interior/buffer seam.
      const parity = (r + c) & 1;
      gfx.fillStyle(parity ? INTERIOR_FILL : INTERIOR_FILL_ALT, 1);
      gfx.fillRect(c * step, r * step, step, step);
    }
  }
  container.add(gfx);
  return gfx;
}

// Pass 2 — brown checker everywhere the scene covers EXCEPT the interior
// cells. Together with the peach floor underneath, this produces the
// "cut-out window" effect: peach + sim visible through the hole, brown
// covering everything else. Drawn above the sim so it visually sits on top.
export function renderExteriorCheckers(scene, container, { board, pxCell, boardOriginX, boardOriginY }) {
  const gfx = scene.make.graphics({ add: false });
  const step = pxCell + BOARD_GAP;
  const sceneW = scene.scale.width;
  const sceneH = scene.scale.height;

  const localLeft   = -boardOriginX;
  const localTop    = -boardOriginY;
  const localRight  = sceneW  - boardOriginX;
  const localBottom = sceneH  - boardOriginY;
  const tileXMin = Math.floor(localLeft   / step) - 1;
  const tileXMax = Math.ceil (localRight  / step) + 1;
  const tileYMin = Math.floor(localTop    / step) - 1;
  const tileYMax = Math.ceil (localBottom / step) + 1;

  const rFrom = 1, rTo = board.rows - 2;
  const cFrom = 1, cTo = board.cols - 2;
  for (let tileY = tileYMin; tileY <= tileYMax; tileY++) {
    for (let tileX = tileXMin; tileX <= tileXMax; tileX++) {
      const inInterior =
        tileY >= rFrom && tileY <= rTo &&
        tileX >= cFrom && tileX <= cTo;
      if (inInterior) continue;                  // leave the hole unfilled
      const parity = (tileX + tileY) & 1;
      gfx.fillStyle(parity ? BUFFER_FILL_ALT : BUFFER_FILL, 1);
      gfx.fillRect(tileX * step, tileY * step, step, step);
    }
  }

  container.add(gfx);
  return gfx;
}

// Shared geometry for the shadow + outline passes: the frame rect and the
// stroke width (outlineWidth matches factory bodies / funnel triangles).
function frameGeom(board, pxCell) {
  const step = pxCell + BOARD_GAP;
  const rFrom = 1, rTo = board.rows - 2;
  const cFrom = 1, cTo = board.cols - 2;
  if (rTo < rFrom || cTo < cFrom) return null;
  const frameW = outlineWidth(pxCell);
  const fx = cFrom * step - FRAME_PAD;
  const fy = rFrom * step - FRAME_PAD;
  const fw = (cTo - cFrom + 1) * step + FRAME_PAD * 2;
  const fh = (rTo - rFrom + 1) * step + FRAME_PAD * 2;
  return { fx, fy, fw, fh, frameW };
}

// Pass 3a — inner shadow only. Goes into `shadowContainer` at a depth
// BELOW the border-funnel triangles so the funnels read on top of it.
export function renderFrameShadow(scene, container, { board, pxCell }) {
  const g = frameGeom(board, pxCell);
  if (!g) return null;
  const gfx = scene.make.graphics({ add: false });
  const shadowStart = Math.ceil(g.frameW / 2);
  for (const band of SHADOW_BANDS) {
    const i = shadowStart + band.inset;
    const radius = Math.max(1, FRAME_RADIUS - i);
    gfx.lineStyle(1, SHADOW_COLOR, band.alpha);
    gfx.strokeRoundedRect(g.fx + i, g.fy + i, g.fw - i * 2, g.fh - i * 2, radius);
  }
  container.add(gfx);
  return gfx;
}

// Pass 3b — black outline only. Goes into `frameContainer` at a depth
// ABOVE the border-funnel triangles, so the frame is the last thing drawn
// around the interior's rim.
export function renderFrameOutline(scene, container, { board, pxCell }) {
  const g = frameGeom(board, pxCell);
  if (!g) return null;
  const gfx = scene.make.graphics({ add: false });
  gfx.lineStyle(g.frameW, FRAME_COLOR, 1);
  gfx.strokeRoundedRect(g.fx, g.fy, g.fw, g.fh, FRAME_RADIUS);
  container.add(gfx);
  return gfx;
}
