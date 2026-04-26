import { funnelPolyPoints } from '../model/shape.js';
import {
  SHAPE_SCALE,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE,
  FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE,
  outlineWidth, BOARD_GAP,
} from '../constants.js';
import { drawEmittersInto, renderEmittersAsSprites } from './EmitterGlyph.js';
import { funnelKey, GLYPH_REF_PXCELL } from './textures/atlas.js';

// Renders a list of funnels using one baked sprite per funnel for the common
// path (no per-funnel fill/stroke overrides) and falls back to a Graphics
// draw for funnels that need an off-palette tint or stage-bg overlay.
//
// Signature:
//   renderFunnels(scene, container, funnels, { pxCell, pxGap, scale, isBorder,
//                 getOpts: (f) => ({ alpha?, fill?, stroke?, stageBg?, hidden? }) })
//
// Returns a Container (was a Graphics pre-bake). Callers that previously did
// `gfx.setPosition(-cx, -cy)` keep working because Container exposes
// setPosition / x / y the same way. Cleanup via `container.destroy()` works
// the same too.
//
// Emitter / collector funnels are routed through drawEmittersInto on a
// scratch Graphics in the same wrapper — those keep their existing path
// for now (their bake lives in atlas.js too but the multi-poly geometry
// makes the sprite swap a follow-up).
export function renderFunnels(scene, container, funnels, opts) {
  const {
    pxCell, pxGap = BOARD_GAP, scale = SHAPE_SCALE, isBorder = false,
    getOpts = null,
  } = opts || {};
  const wrap = scene.add.container(0, 0);
  container.add(wrap);

  // Phase 1: stage-background paint behind the funnel glyph (used by the
  // boss editor's cross-stage preview). Lives on its own Graphics so the
  // sprite-per-funnel pass below can sit on top.
  let stageGfx = null;
  if (getOpts) {
    for (const f of funnels) {
      const o = getOpts(f) || {};
      if (o.hidden) continue;
      if (o.stageBg == null) continue;
      if (!stageGfx) {
        stageGfx = scene.make.graphics({ add: false });
        wrap.add(stageGfx);
      }
      const cellX = f.c * (pxCell + pxGap);
      const cellY = f.r * (pxCell + pxGap);
      stageGfx.fillStyle(o.stageBg, o.stageBgAlpha != null ? o.stageBgAlpha : 0.35);
      stageGfx.fillRoundedRect(cellX, cellY, pxCell, pxCell, Math.max(4, pxCell * 0.1));
    }
  }

  // Split shape funnels (input/output triangles) from laser funnels
  // (emitter/collector) — same dispatch as before.
  const laserFunnels = [];
  const shapeFunnels = [];
  for (const f of funnels) {
    const o = getOpts ? (getOpts(f) || {}) : null;
    if (o && o.hidden) continue;
    if (f.role === 'emitter' || f.role === 'collector') laserFunnels.push(f);
    else                                                 shapeFunnels.push(f);
  }

  // Sprite path for shape funnels — most calls land here.
  // Sprite scale converts the baked GLYPH_REF_PXCELL geometry to the
  // current pxCell. The sprite center sits at the cell center (not the
  // cell origin), since funnelPolyAtCenter inside atlas.js bakes the
  // triangle relative to (0,0) of the texture.
  const step = pxCell + pxGap;
  const spriteScale = pxCell / GLYPH_REF_PXCELL;
  let fallbackGfx = null;
  for (const f of shapeFunnels) {
    const o = getOpts ? (getOpts(f) || {}) : null;
    const hasOverride = !!(o && (o.fill != null || o.stroke != null));
    const alpha = o && o.alpha != null ? o.alpha : 1;
    if (!hasOverride) {
      const role = f.role === 'output' ? 'output' : 'input';
      const key = funnelKey(role, f.side, isBorder);
      if (scene.textures.exists(key)) {
        const cx = f.c * step + pxCell / 2;
        const cy = f.r * step + pxCell / 2;
        const img = scene.add.image(cx, cy, key).setOrigin(0.5);
        img.setScale(spriteScale);
        if (alpha !== 1) img.setAlpha(alpha);
        wrap.add(img);
        continue;
      }
    }
    // Fallback: per-funnel override OR atlas missing — draw with Graphics
    // using the legacy code path. One scratch Graphics shared by all
    // override funnels in this batch.
    if (!fallbackGfx) {
      fallbackGfx = scene.make.graphics({ add: false });
      wrap.add(fallbackGfx);
    }
    drawSingleFunnel(fallbackGfx, f, pxCell, pxGap, scale, isBorder, o);
  }

  if (laserFunnels.length) {
    renderEmittersAsSprites(scene, wrap, laserFunnels, { pxCell, pxGap, scale, isBorder });
  }

  return wrap;
}

// Single-funnel Graphics fallback. Used when atlas lookups fail OR a per-
// funnel override (boss cross-stage tint) takes the sprite path off the
// table. Mirrors the legacy drawFunnelsInto loop body for one funnel.
function drawSingleFunnel(gfx, f, pxCell, pxGap, scale, isBorder, o) {
  const strokeW = outlineWidth(pxCell);
  const inputFill   = isBorder ? FUNNEL_INPUT_FILL   : FACTORY_FUNNEL_INPUT_FILL;
  const inputStroke = isBorder ? FUNNEL_INPUT_STROKE : FACTORY_FUNNEL_INPUT_STROKE;
  const outFill     = isBorder ? FUNNEL_OUTPUT_FILL   : FACTORY_FUNNEL_OUTPUT_FILL;
  const outStroke   = isBorder ? FUNNEL_OUTPUT_STROKE : FACTORY_FUNNEL_OUTPUT_STROKE;
  const isInput = f.role !== 'output';
  const alpha = o && o.alpha != null ? o.alpha : 1;
  const fill   = o && o.fill   != null ? o.fill   : (isInput ? inputFill   : outFill);
  const stroke = o && o.stroke != null ? o.stroke : (isInput ? inputStroke : outStroke);
  const pts = funnelPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
  if (pts.length < 3) return;
  gfx.fillStyle(fill, alpha);
  gfx.lineStyle(strokeW, stroke, alpha);
  gfx.beginPath();
  gfx.moveTo(pts[0][0], pts[0][1]);
  gfx.lineTo(pts[1][0], pts[1][1]);
  gfx.lineTo(pts[2][0], pts[2][1]);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
}

// Legacy export kept for any direct callers (BorderRenderer, etc.) — the
// implementation is unchanged so a Graphics-only consumer that wants to
// bake into its own gfx still works.
export function drawFunnelsInto(gfx, funnels, pxCell, pxGap, scale, isBorder = false, getOpts = null) {
  gfx.clear();
  const strokeW = outlineWidth(pxCell);
  const inputFill   = isBorder ? FUNNEL_INPUT_FILL   : FACTORY_FUNNEL_INPUT_FILL;
  const inputStroke = isBorder ? FUNNEL_INPUT_STROKE : FACTORY_FUNNEL_INPUT_STROKE;
  const outFill     = isBorder ? FUNNEL_OUTPUT_FILL   : FACTORY_FUNNEL_OUTPUT_FILL;
  const outStroke   = isBorder ? FUNNEL_OUTPUT_STROKE : FACTORY_FUNNEL_OUTPUT_STROKE;

  if (getOpts) {
    for (const f of funnels) {
      const o = getOpts(f) || {};
      if (o.hidden) continue;
      if (o.stageBg == null) continue;
      const cellX = f.c * (pxCell + pxGap);
      const cellY = f.r * (pxCell + pxGap);
      gfx.fillStyle(o.stageBg, o.stageBgAlpha != null ? o.stageBgAlpha : 0.35);
      gfx.fillRoundedRect(cellX, cellY, pxCell, pxCell, Math.max(4, pxCell * 0.1));
    }
  }

  const laserFunnels = [];
  const shapeFunnels = [];
  for (const f of funnels) {
    const o = getOpts ? (getOpts(f) || {}) : null;
    if (o && o.hidden) continue;
    if (f.role === 'emitter' || f.role === 'collector') laserFunnels.push(f);
    else                                                 shapeFunnels.push(f);
  }
  for (const f of shapeFunnels) {
    const pts = funnelPolyPoints(f.r, f.c, f.side, pxCell, pxGap, scale);
    if (pts.length < 3) continue;
    const isInput = f.role !== 'output';
    const o = getOpts ? (getOpts(f) || {}) : null;
    const alpha = o && o.alpha != null ? o.alpha : 1;
    const fill   = o && o.fill   != null ? o.fill   : (isInput ? inputFill   : outFill);
    const stroke = o && o.stroke != null ? o.stroke : (isInput ? inputStroke : outStroke);
    gfx.fillStyle(fill, alpha);
    gfx.lineStyle(strokeW, stroke, alpha);
    gfx.beginPath();
    gfx.moveTo(pts[0][0], pts[0][1]);
    gfx.lineTo(pts[1][0], pts[1][1]);
    gfx.lineTo(pts[2][0], pts[2][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }
  if (laserFunnels.length) drawEmittersInto(gfx, laserFunnels, pxCell, pxGap, scale, isBorder);
}
