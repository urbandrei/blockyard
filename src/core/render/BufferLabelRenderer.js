import { COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import {
  BOARD_GAP, SHAPE_SCALE, SHAPE_RADIUS_FRAC, outlineWidth,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
} from '../constants.js';
import { FRAME_PAD } from './PlayAreaFrame.js';
import { drawPuddle } from './shapes.js';

// Labels each buffer funnel with a role-colored rounded box (sized like a
// 1×1 factory: SHAPE_SCALE × pxCell) sitting TANGENT to the interior frame
// on the buffer side, with a form+color icon centered inside.
//
// Role color:
//   input  → green (matches the triangle fill)
//   output → red   (matches the triangle fill)
//
// Each label lives in its own wrap Container centered on the box position,
// so the scene can apply the squash-and-stretch pulse (sq.funnels) around
// the box's own center in lockstep with the factory funnels.

const LABEL_RADIUS_FRAC = SHAPE_RADIUS_FRAC * 0.5;

// Geometry for one buffer label given a funnel record and the current board.
// Returns { x, y, size } in board-local coordinates (matches every other
// board-positioned container). Exported so other renderers (e.g. mismatch
// markers) can stamp visuals at the same spot without duplicating the math.
export function computeBufferLabelBox(level, funnel, pxCell, pxGap) {
  const step = pxCell + pxGap;
  const size = SHAPE_SCALE * pxCell;
  const cFrom = 1, cTo = level.board.cols - 2;
  const rFrom = 1, rTo = level.board.rows - 2;
  const frameTop    = rFrom * step - FRAME_PAD;
  const frameBottom = (rTo + 1) * step + FRAME_PAD;
  const frameLeft   = cFrom * step - FRAME_PAD;
  const frameRight  = (cTo  + 1) * step + FRAME_PAD;
  const cellCX = funnel.c * step + pxCell / 2;
  const cellCY = funnel.r * step + pxCell / 2;
  let x = cellCX, y = cellCY;
  switch (funnel.side) {
    case 'bottom': y = frameTop    - size / 2; break;
    case 'top':    y = frameBottom + size / 2; break;
    case 'right':  x = frameLeft   - size / 2; break;
    case 'left':   x = frameRight  + size / 2; break;
  }
  return { x, y, size };
}

export function renderBufferLabels(scene, container, level, { pxCell, pxGap }) {
  const wraps = [];
  const funnels = (level.border && level.border.funnels) || [];
  if (funnels.length === 0) return wraps;
  const step = pxCell + pxGap;
  const boxSize = SHAPE_SCALE * pxCell;
  const boxR    = Math.max(3, Math.round(pxCell * SHAPE_SCALE * 0.18));
  const strokeW = outlineWidth(pxCell);
  const iconR   = Math.max(4, Math.round(pxCell * LABEL_RADIUS_FRAC));

  // Interior-frame edges in board-local coords (same geometry as
  // PlayAreaFrame's renderFrameOutline).
  const cFrom = 1, cTo = level.board.cols - 2;
  const rFrom = 1, rTo = level.board.rows - 2;
  const frameTop    = rFrom * step - FRAME_PAD;
  const frameBottom = (rTo + 1) * step + FRAME_PAD;
  const frameLeft   = cFrom * step - FRAME_PAD;
  const frameRight  = (cTo  + 1) * step + FRAME_PAD;

  for (const f of funnels) {
    const type = lookupType(level, f);
    const iconColor = COLOR_HEX[type.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color];
    const isOutput = f.role === 'output';
    const boxFill    = isOutput ? FUNNEL_OUTPUT_FILL   : FUNNEL_INPUT_FILL;
    const boxStroke  = isOutput ? FUNNEL_OUTPUT_STROKE : FUNNEL_INPUT_STROKE;

    const cellCX = f.c * step + pxCell / 2;
    const cellCY = f.r * step + pxCell / 2;

    // Position the box tangent to the frame edge on the OUTSIDE (buffer
    // side). f.side is the funnel's inward direction; the box sits opposite.
    let boxCX = cellCX, boxCY = cellCY;
    switch (f.side) {
      case 'bottom': boxCY = frameTop    - boxSize / 2; break;
      case 'top':    boxCY = frameBottom + boxSize / 2; break;
      case 'right':  boxCX = frameLeft   - boxSize / 2; break;
      case 'left':   boxCX = frameRight  + boxSize / 2; break;
    }

    const wrap = scene.add.container(boxCX, boxCY);
    container.add(wrap);

    const gfx = scene.make.graphics({ add: false });
    // Role-colored tile with a centered form+color icon. Role is conveyed
    // purely by fill color (green = input, red = output); the labeling copy
    // lives inside the FunnelTypePicker modal instead of on the board tile.
    gfx.fillStyle(boxFill, 1);
    gfx.lineStyle(strokeW, boxStroke, 1);
    gfx.fillRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
    gfx.strokeRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
    gfx.lineStyle(strokeW, 0x000000, 1);
    drawForm(gfx, 0, 0, iconR, type.form, iconColor);
    wrap.add(gfx);
    wraps.push(wrap);
  }
  return wraps;
}

function lookupType(level, f) {
  const bucket = f.role === 'output' ? level.outputs : level.inputs;
  if (Array.isArray(bucket)) {
    const hit = bucket.find((e) => e.r === f.r && e.c === f.c && e.side === f.side);
    if (hit && hit.type) return hit.type;
  }
  return DEFAULT_SHAPE_TYPE;
}

function drawForm(gfx, cx, cy, r, form, color) {
  // Partial-label dispatch (shared vocabulary with FactoryBodyRenderer):
  //   form && color  → standard form glyph in color
  //   form && !color → form glyph filled WHITE
  //   !form && color → puddle blob in color
  //   neither        → fall back to a default circle in `color`
  if (!form && color != null) {
    gfx.fillStyle(color, 1);
    drawPuddle(gfx, cx, cy, r);
    return;
  }
  const fill = (color != null) ? color : 0xffffff;
  gfx.fillStyle(fill, 1);
  switch (form) {
    case 'circle': {
      gfx.fillCircle(cx, cy, r);
      gfx.strokeCircle(cx, cy, r);
      return;
    }
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(cx - s / 2, cy - s / 2, s, s);
      gfx.strokeRect(cx - s / 2, cy - s / 2, s, s);
      return;
    }
    case 'triangle': {
      const h = r * 2;
      const halfBase = r * 1.05;
      gfx.beginPath();
      gfx.moveTo(cx,              cy - h * 0.6);
      gfx.lineTo(cx - halfBase,   cy + h * 0.4);
      gfx.lineTo(cx + halfBase,   cy + h * 0.4);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      return;
    }
    default: {
      gfx.fillCircle(cx, cy, r);
      gfx.strokeCircle(cx, cy, r);
    }
  }
}
