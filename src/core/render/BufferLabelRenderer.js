import { COLOR_HEX, DEFAULT_SHAPE_TYPE } from '../model/shape.js';
import {
  BOARD_GAP, SHAPE_SCALE, SHAPE_RADIUS_FRAC, outlineWidth,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  EMITTER_FILL, EMITTER_STROKE, COLLECTOR_FILL, COLLECTOR_STROKE,
} from '../constants.js';
import { drawPuddle } from './shapes.js';
import { bufferLabelKey, GLYPH_REF_PXCELL } from './textures/atlas.js';

// Labels each buffer funnel with a role-colored rounded box (sized like a
// 1×1 factory: SHAPE_SCALE × pxCell), CENTERED on its buffer cell, with a
// form+color icon centered inside. Each label lives in its own wrap
// Container so the scene can drive squash/stretch pulse independently of
// other border art.
//
// The label box + glyph is a baked sprite (atlas.js) — every (role, form,
// color) combo is pre-rendered at preload, so this function just creates
// an Image per label and scales it to the current pxCell. Levels with a
// non-finite type (atlas miss) fall back to the original Graphics render
// so a malformed level still draws.

const LABEL_RADIUS_FRAC = SHAPE_RADIUS_FRAC * 0.5;

// Geometry for one buffer label given a funnel record and the current board.
// Returns { x, y, size } in board-local coordinates (matches every other
// board-positioned container). Exported so other renderers (e.g. mismatch
// markers) can stamp visuals at the same spot without duplicating the math.
export function computeBufferLabelBox(level, funnel, pxCell, pxGap) {
  const step = pxCell + pxGap;
  const size = SHAPE_SCALE * pxCell;
  // Centered on the buffer cell — matches where a factory body would sit
  // if this cell were a play-area cell.
  const x = funnel.c * step + pxCell / 2;
  const y = funnel.r * step + pxCell / 2;
  return { x, y, size };
}

export function renderBufferLabels(scene, container, level, { pxCell, pxGap }) {
  const wraps = [];
  const funnels = (level.border && level.border.funnels) || [];
  if (funnels.length === 0) return wraps;
  const spriteScale = pxCell / GLYPH_REF_PXCELL;

  for (const f of funnels) {
    const { x: boxCX, y: boxCY } = computeBufferLabelBox(level, f, pxCell, pxGap);
    const wrap = scene.add.container(boxCX, boxCY);
    container.add(wrap);

    const role = (f.role === 'emitter' || f.role === 'collector') ? f.role
               : (f.role === 'output' ? 'output' : 'input');
    let key;
    if (role === 'emitter' || role === 'collector') {
      key = bufferLabelKey(role);
    } else {
      const type = lookupType(level, f);
      // Partial labels:
      //   {form, color}  → standard form glyph in color
      //   {form, !color} → form glyph filled WHITE
      //   {!form, color} → puddle blob in color
      const form  = type && type.form  ? type.form  : null;
      const color = type && type.color ? type.color : null;
      key = bufferLabelKey(role, form, color);
    }

    if (scene.textures.exists(key)) {
      const img = scene.add.image(0, 0, key).setOrigin(0.5);
      img.setScale(spriteScale);
      wrap.add(img);
    } else {
      // Atlas miss — fall back to the legacy Graphics render so the level
      // still draws even when the bake didn't include this combo.
      wrap.add(buildLegacyLabelGfx(scene, level, f, pxCell));
    }
    wraps.push(wrap);
  }
  return wraps;
}

function buildLegacyLabelGfx(scene, level, f, pxCell) {
  const isEmitter   = f.role === 'emitter';
  const isCollector = f.role === 'collector';
  const isOutput    = f.role === 'output';
  const boxFill   = isEmitter   ? EMITTER_FILL   :
                    isCollector ? COLLECTOR_FILL :
                    isOutput    ? FUNNEL_OUTPUT_FILL : FUNNEL_INPUT_FILL;
  const boxStroke = isEmitter   ? EMITTER_STROKE   :
                    isCollector ? COLLECTOR_STROKE :
                    isOutput    ? FUNNEL_OUTPUT_STROKE : FUNNEL_INPUT_STROKE;
  const boxSize = SHAPE_SCALE * pxCell;
  const boxR    = Math.max(3, Math.round(pxCell * SHAPE_SCALE * 0.18));
  const strokeW = outlineWidth(pxCell);
  const iconR   = Math.max(4, Math.round(pxCell * LABEL_RADIUS_FRAC));

  const gfx = scene.make.graphics({ add: false });
  gfx.fillStyle(boxFill, 1);
  gfx.lineStyle(strokeW, boxStroke, 1);
  gfx.fillRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
  gfx.strokeRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
  if (isEmitter || isCollector) {
    const dotR  = iconR * 0.55;
    const ringR = iconR * 1.05;
    gfx.lineStyle(Math.max(2, strokeW), 0xd02020, 1);
    gfx.strokeCircle(0, 0, ringR);
    gfx.fillStyle(0xd02020, 1);
    gfx.fillCircle(0, 0, dotR);
  } else {
    const type = lookupType(level, f);
    const iconColor = COLOR_HEX[type.color] || COLOR_HEX[DEFAULT_SHAPE_TYPE.color];
    gfx.lineStyle(strokeW, 0x000000, 1);
    drawForm(gfx, 0, 0, iconR, type.form, iconColor);
  }
  return gfx;
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
