// Texture atlas for everything we can bake once and reuse as a sprite.
//
// Static atlases (game-lifetime):
//   • shape glyphs    — 9 form×color combos
//   • funnel glyphs   — 2 roles × 4 sides × 2 isBorder = 16 combos (input/output)
//   • emitter glyphs  — 2 roles (emitter/collector) × 4 sides = 8 combos
//   • buffer labels   — input/output × {form+color, form-only, color-only}
//                       + emitter / collector bullseyes
//   • marks           — green check + red X
//
// Level-scoped caches (cleared on scene shutdown):
//   • factory body blobs (bezier perimeter + caution stripes)
//   • acid-pit fill components (rounded blob + per-cell rects + bridges)
//
// Why bake: the hot-path renderers (ShapeRenderer.spawn fires every time the
// sim emits a shape) currently construct a fresh Phaser.Graphics per object
// and run fill/stroke calls. Replacing those with reusable Image sprites
// removes the per-spawn vector work — the GPU just blits a quad.
//
// Animated overlays (acid color-morph, electrocution arcs, bolt fill, body
// powered-glow, pit wobble + bubbles) stay as Graphics drawn on top of the
// baked sprite; they're inherently per-frame and can't be cached.

import {
  COLOR_HEX, FORMS, COLORS, traceFactoryLoops, unitVec,
} from '../../model/shape.js';
import {
  SHAPE_SCALE, BLOCK_LIGHT, BLOCK_DARK, BLOCK_STROKE, SINGLE_CELL_FILL,
  FUNNEL_INPUT_FILL, FUNNEL_INPUT_STROKE,
  FUNNEL_OUTPUT_FILL, FUNNEL_OUTPUT_STROKE,
  FACTORY_FUNNEL_INPUT_FILL, FACTORY_FUNNEL_INPUT_STROKE,
  FACTORY_FUNNEL_OUTPUT_FILL, FACTORY_FUNNEL_OUTPUT_STROKE,
  EMITTER_FILL, EMITTER_STROKE, COLLECTOR_FILL, COLLECTOR_STROKE,
  outlineWidth,
} from '../../constants.js';
import { drawShapeForm, drawPuddle } from '../shapes.js';

// ---- Reference dimensions ---------------------------------------------------

// Shapes bake into a 96×96 texture with a logical radius of 42 — leaves room
// for stroke + a touch of antialias bleed. Consumers compute scale as
// `realRadius / SHAPE_REF_RADIUS`.
export const SHAPE_REF_SIZE   = 96;
export const SHAPE_REF_RADIUS = 42;

// Funnels / emitters / buffer labels bake at a logical pxCell of 100 so the
// integer math (Math.round) inside the existing geometry helpers behaves the
// same as it does at real-world cell sizes (60–80px). Consumers compute scale
// as `realPxCell / GLYPH_REF_PXCELL`.
export const GLYPH_REF_PXCELL = 100;

// ---- Texture key builders ---------------------------------------------------
// Stable keys so any renderer can resolve the cached texture without holding
// a reference to the atlas.

const KEY_PREFIX = 'bk:';
export function shapeKey(form, color) { return `${KEY_PREFIX}shape:${form}:${color}`; }
export function funnelKey(role, side, isBorder) {
  return `${KEY_PREFIX}funnel:${isBorder ? 'b' : 'f'}:${role}:${side}`;
}
export function emitterKey(role, side) { return `${KEY_PREFIX}emit:${role}:${side}`; }
export function bufferLabelKey(role, form, color) {
  if (role === 'emitter' || role === 'collector') return `${KEY_PREFIX}lbl:${role}`;
  return `${KEY_PREFIX}lbl:${role}:${form || 'x'}:${color || 'x'}`;
}
export function markKey(kind) { return `${KEY_PREFIX}mark:${kind}`; }

// Per-scene cache for parameterized textures (factory bodies + acid fills).
function getSceneCache(scene) {
  if (!scene.__bakedGeometryCache) scene.__bakedGeometryCache = new Set();
  return scene.__bakedGeometryCache;
}

// ---- Static atlas: idempotent one-shot bake ---------------------------------

// Called once from PreloadScene.create(). Re-entry is safe — every bake is
// guarded by `scene.textures.exists(key)` so a hot-reload (Vite HMR or scene
// restart) doesn't re-bake.
export function ensureStaticAtlases(scene) {
  if (!scene || !scene.textures) return;
  if (scene.registry && scene.registry.get('atlasReady')) return;

  bakeShapeAtlas(scene);
  bakeFunnelAtlas(scene);
  bakeEmitterAtlas(scene);
  bakeBufferLabelAtlas(scene);
  bakeMarkAtlas(scene);

  if (scene.registry) scene.registry.set('atlasReady', true);
}

// Generate a texture from a scratch Graphics. Phaser's generateTexture takes
// (key, w, h) and rasterizes the current path state into the texture manager.
function bakeFromGraphics(scene, key, draw, w, h) {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ add: false });
  // The bake surface is centered at (w/2, h/2) — geometry is drawn relative
  // to that center, so the resulting Image's origin (0.5, 0.5) sits where
  // the source's origin sat.
  g.translateCanvas(w / 2, h / 2);
  draw(g);
  g.generateTexture(key, w, h);
  g.destroy();
}

// ---- Shape glyphs (3 forms × 3 colors = 9) ----------------------------------

function bakeShapeAtlas(scene) {
  const strokeW = 3; // matches outlineWidth(pxCell) which is fixed at 3.
  for (const form of FORMS) {
    for (const color of COLORS) {
      const key = shapeKey(form, color);
      bakeFromGraphics(scene, key, (g) => {
        g.fillStyle(COLOR_HEX[color], 1);
        g.lineStyle(strokeW, 0x000000, 1);
        drawShapeForm(g, SHAPE_REF_RADIUS, form);
      }, SHAPE_REF_SIZE, SHAPE_REF_SIZE);
    }
  }
}

// ---- Funnel glyphs (input/output × 4 sides × border/factory) ----------------
// Bake the funnel triangle relative to the CENTER of a logical cell at
// GLYPH_REF_PXCELL. Consumers position the sprite at the cell center and
// scale by realPxCell / GLYPH_REF_PXCELL — the triangle's offset (which side
// of the cell it juts toward) lives inside the texture.

function bakeFunnelAtlas(scene) {
  const sides = ['top', 'bottom', 'left', 'right'];
  const roles = ['input', 'output'];
  for (const isBorder of [false, true]) {
    for (const role of roles) {
      for (const side of sides) {
        const key = funnelKey(role, side, isBorder);
        bakeFromGraphics(scene, key, (g) => drawFunnelForBake(g, role, side, isBorder),
          GLYPH_REF_PXCELL, GLYPH_REF_PXCELL);
      }
    }
  }
}

// Cell-center-relative funnel polygon for the bake surface. Mirrors
// funnelPolyPoints, but normalized so (0,0) sits at the texture center.
function funnelPolyAtCenter(side, pxCell) {
  const inner = pxCell * SHAPE_SCALE;
  const halfInner = inner / 2;
  const funInner = pxCell * SHAPE_SCALE;
  const h = Math.round(funInner * 0.5);
  const base = Math.round(funInner * 0.55);
  const half = base / 2;
  const halfH = h / 2;
  // Cell-center origin: cx=cy=0; box extends [-halfInner, halfInner] both axes.
  switch (side) {
    case 'top':    return [[0, -halfInner + halfH],          [-half, -halfInner - halfH],         [half, -halfInner - halfH]];
    case 'bottom': return [[0,  halfInner - halfH],          [-half,  halfInner + halfH],         [half,  halfInner + halfH]];
    case 'left':   return [[-halfInner + halfH, 0],          [-halfInner - halfH, -half],         [-halfInner - halfH,  half]];
    case 'right':  return [[ halfInner - halfH, 0],          [ halfInner + halfH, -half],         [ halfInner + halfH,  half]];
  }
  return [];
}

function drawFunnelForBake(g, role, side, isBorder) {
  const isInput = role !== 'output';
  const fill   = isBorder ? (isInput ? FUNNEL_INPUT_FILL   : FUNNEL_OUTPUT_FILL)
                          : (isInput ? FACTORY_FUNNEL_INPUT_FILL : FACTORY_FUNNEL_OUTPUT_FILL);
  const stroke = isBorder ? (isInput ? FUNNEL_INPUT_STROKE : FUNNEL_OUTPUT_STROKE)
                          : (isInput ? FACTORY_FUNNEL_INPUT_STROKE : FACTORY_FUNNEL_OUTPUT_STROKE);
  const pts = funnelPolyAtCenter(side, GLYPH_REF_PXCELL);
  g.fillStyle(fill, 1);
  g.lineStyle(outlineWidth(GLYPH_REF_PXCELL), stroke, 1);
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  g.lineTo(pts[1][0], pts[1][1]);
  g.lineTo(pts[2][0], pts[2][1]);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

// ---- Emitter / collector glyphs (8) -----------------------------------------
// Same approach: bake at cell-center origin with the two half-triangles.

function emitterPolysAtCenter(side, pxCell) {
  const GAP_FRAC  = 0.18;
  const FIN_WIDEN = 1.05;
  const OUT_FRAC  = 0.6;
  const inner = pxCell * SHAPE_SCALE;
  const halfInner = inner / 2;
  const funInner = pxCell * SHAPE_SCALE;
  const h = Math.round(funInner * 0.6);
  const base = Math.round(funInner * 0.68 * FIN_WIDEN);
  const half = base / 2;
  const gap = Math.max(2, Math.round(base * GAP_FRAC));
  const halfGap = gap / 2;
  const outH = Math.round(h * OUT_FRAC);
  const inH  = h - outH;
  switch (side) {
    case 'top': {
      const tipY  = -halfInner - outH;
      const baseY = -halfInner + inH;
      return [
        [[-halfGap, baseY], [-half,    baseY], [-halfGap, tipY]],
        [[ halfGap, baseY], [ halfGap, tipY],  [ half,    baseY]],
      ];
    }
    case 'bottom': {
      const tipY  = halfInner + outH;
      const baseY = halfInner - inH;
      return [
        [[-halfGap, baseY], [-halfGap, tipY], [-half,    baseY]],
        [[ halfGap, baseY], [ half,    baseY], [ halfGap, tipY]],
      ];
    }
    case 'left': {
      const tipX  = -halfInner - outH;
      const baseX = -halfInner + inH;
      return [
        [[baseX, -halfGap], [baseX, -half],    [tipX, -halfGap]],
        [[baseX,  halfGap], [tipX,   halfGap], [baseX,  half]],
      ];
    }
    case 'right': {
      const tipX  = halfInner + outH;
      const baseX = halfInner - inH;
      return [
        [[baseX, -halfGap], [tipX,  -halfGap], [baseX, -half]],
        [[baseX,  halfGap], [baseX,  half],    [tipX,   halfGap]],
      ];
    }
  }
  return [];
}

function bakeEmitterAtlas(scene) {
  const sides = ['top', 'bottom', 'left', 'right'];
  const roles = ['emitter', 'collector'];
  for (const role of roles) {
    for (const side of sides) {
      const key = emitterKey(role, side);
      bakeFromGraphics(scene, key, (g) => {
        const isCollector = role === 'collector';
        const fill   = isCollector ? COLLECTOR_FILL   : EMITTER_FILL;
        const stroke = isCollector ? COLLECTOR_STROKE : EMITTER_STROKE;
        const polys = emitterPolysAtCenter(side, GLYPH_REF_PXCELL);
        g.fillStyle(fill, 1);
        g.lineStyle(outlineWidth(GLYPH_REF_PXCELL), stroke, 1);
        for (const poly of polys) {
          if (poly.length < 3) continue;
          g.beginPath();
          g.moveTo(poly[0][0], poly[0][1]);
          for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
          g.closePath();
          g.fillPath();
          g.strokePath();
        }
      }, GLYPH_REF_PXCELL, GLYPH_REF_PXCELL);
    }
  }
}

// ---- Buffer label tiles -----------------------------------------------------
// 1 box per (role, form|null, color|null). Drawn centered on the texture; the
// consumer positions the sprite at the cell center.

function bakeBufferLabelAtlas(scene) {
  const pxCell = GLYPH_REF_PXCELL;
  // Emitter / collector — bullseye, no per-shape variants.
  for (const role of ['emitter', 'collector']) {
    bakeFromGraphics(scene, bufferLabelKey(role), (g) => drawBufferLabel(g, role, null, null, pxCell),
      pxCell, pxCell);
  }
  // Input / output — every form×color combo, plus form-only and color-only.
  for (const role of ['input', 'output']) {
    for (const form of FORMS) {
      for (const color of COLORS) {
        bakeFromGraphics(scene, bufferLabelKey(role, form, color),
          (g) => drawBufferLabel(g, role, form, color, pxCell), pxCell, pxCell);
      }
    }
    for (const form of FORMS) {
      bakeFromGraphics(scene, bufferLabelKey(role, form, null),
        (g) => drawBufferLabel(g, role, form, null, pxCell), pxCell, pxCell);
    }
    for (const color of COLORS) {
      bakeFromGraphics(scene, bufferLabelKey(role, null, color),
        (g) => drawBufferLabel(g, role, null, color, pxCell), pxCell, pxCell);
    }
  }
}

const LABEL_RADIUS_FRAC = 0.26 * 0.5; // SHAPE_RADIUS_FRAC * 0.5 from BufferLabelRenderer.
function drawBufferLabel(g, role, form, color, pxCell) {
  const isEmitter   = role === 'emitter';
  const isCollector = role === 'collector';
  const isOutput    = role === 'output';
  const boxFill   = isEmitter   ? EMITTER_FILL   :
                    isCollector ? COLLECTOR_FILL :
                    isOutput    ? FUNNEL_OUTPUT_FILL : FUNNEL_INPUT_FILL;
  const boxStroke = isEmitter   ? EMITTER_STROKE   :
                    isCollector ? COLLECTOR_STROKE :
                    isOutput    ? FUNNEL_OUTPUT_STROKE : FUNNEL_INPUT_STROKE;
  const boxSize = SHAPE_SCALE * pxCell;
  const boxR    = Math.max(3, Math.round(boxSize * 0.18));
  const strokeW = outlineWidth(pxCell);
  const iconR   = Math.max(4, Math.round(pxCell * LABEL_RADIUS_FRAC));

  g.fillStyle(boxFill, 1);
  g.lineStyle(strokeW, boxStroke, 1);
  g.fillRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
  g.strokeRoundedRect(-boxSize / 2, -boxSize / 2, boxSize, boxSize, boxR);
  if (isEmitter || isCollector) {
    const dotR  = iconR * 0.55;
    const ringR = iconR * 1.05;
    g.lineStyle(Math.max(2, strokeW), 0xd02020, 1);
    g.strokeCircle(0, 0, ringR);
    g.fillStyle(0xd02020, 1);
    g.fillCircle(0, 0, dotR);
    return;
  }
  drawLabelForm(g, iconR, strokeW, form, color);
}

function drawLabelForm(g, r, strokeW, form, color) {
  const colorHex = color != null ? COLOR_HEX[color] : null;
  // {form, color}: filled in color
  // {form, !color}: filled white
  // {!form, color}: puddle blob filled in color
  if (!form && colorHex != null) {
    g.fillStyle(colorHex, 1);
    g.lineStyle(strokeW, 0x000000, 1);
    drawPuddle(g, 0, 0, r);
    return;
  }
  const fill = colorHex != null ? colorHex : 0xffffff;
  g.fillStyle(fill, 1);
  g.lineStyle(strokeW, 0x000000, 1);
  switch (form) {
    case 'circle':   g.fillCircle(0, 0, r); g.strokeCircle(0, 0, r); break;
    case 'square': {
      const s = r * 1.7;
      g.fillRect(-s / 2, -s / 2, s, s);
      g.strokeRect(-s / 2, -s / 2, s, s);
      break;
    }
    case 'triangle': {
      const h = r * 2;
      const halfBase = r * 1.05;
      g.beginPath();
      g.moveTo(0,           -h * 0.6);
      g.lineTo(-halfBase,    h * 0.4);
      g.lineTo( halfBase,    h * 0.4);
      g.closePath();
      g.fillPath();
      g.strokePath();
      break;
    }
    default:
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
  }
}

// ---- Marks (✓ / ✗) ----------------------------------------------------------

function bakeMarkAtlas(scene) {
  const pxCell = GLYPH_REF_PXCELL;
  const STROKE_FRAC = 0.18;
  const EXTENT_FRAC = 0.48;
  const boxSize = SHAPE_SCALE * pxCell;
  const half = boxSize * EXTENT_FRAC;
  const w    = Math.max(3, Math.round(boxSize * STROKE_FRAC));
  bakeFromGraphics(scene, markKey('x'), (g) => {
    g.lineStyle(w, 0xd02020, 1);
    g.beginPath();
    g.moveTo(-half, -half); g.lineTo( half,  half);
    g.moveTo( half, -half); g.lineTo(-half,  half);
    g.strokePath();
  }, pxCell, pxCell);
  bakeFromGraphics(scene, markKey('check'), (g) => {
    const r = boxSize * EXTENT_FRAC;
    g.lineStyle(w, 0x2ea84a, 1);
    g.beginPath();
    g.moveTo(-r,           r * 0.08);
    g.lineTo(-r * 0.20,    r * 0.70);
    g.lineTo( r * 0.95,   -r * 0.65);
    g.strokePath();
  }, pxCell, pxCell);
}

// ---- Factory body cache (level-scoped) --------------------------------------
// Keyed by a hash of the cell config + visual flags + pxCell. The bake
// renders the bezier blob (and caution stripes when applicable) into a
// RenderTexture sized to the body's bounding box; the texture is named so
// callers can resolve it via scene.textures.get() later.
//
// Returns { textureKey, anchorX, anchorY }. anchor describes where the
// texture's top-left lands in the original (cell-relative) coord system —
// the consumer positions the sprite at (anchorX + tw/2, anchorY + th/2)
// when the sprite has origin (0.5, 0.5), or directly at (anchorX, anchorY)
// for origin (0, 0).

export function getOrBakeFactoryBody(scene, opts) {
  const { cells, pxCell, pxGap, scale = SHAPE_SCALE, fill, stroke, caution, rotation = 0 } = opts;
  if (!cells || cells.length === 0) return null;
  // Cache key uses NORMALIZED cells (shifted to origin 0,0) so two factories
  // with the same shape but different anchors share the texture. The bake
  // itself draws using normalized cells too — positional offset is supplied
  // by the consumer via the sprite's position (centroid of the absolute
  // cells, in cell-pixel coords).
  const norm = normalizedCells(cells);
  const flags = `c=${caution ? 1 : 0}r=${caution ? (((rotation % 4) + 4) % 4) : 0}f=${fill ?? 'd'}s=${stroke ?? 'd'}sc=${scale}`;
  const key = `${KEY_PREFIX}fbody:${pxCell}:${pxGap}:${flags}:${normCellsHash(norm)}`;
  if (scene.textures.exists(key)) return key;
  const cache = getSceneCache(scene);
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { r, c } of norm.cells) {
    const x0 = c * step + m, y0 = r * step + m;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + inner > maxX) maxX = x0 + inner;
    if (y0 + inner > maxY) maxY = y0 + inner;
  }
  // Centroid of the normalized cells (matches factoryCellsCenter math: it's
  // the midpoint of the cell-pixel bounding box, NOT the average of cell
  // centers, because the legacy code used midpoint).
  let mnR = Infinity, mxR = -Infinity, mnC = Infinity, mxC = -Infinity;
  for (const { r, c } of norm.cells) {
    if (r < mnR) mnR = r; if (r > mxR) mxR = r;
    if (c < mnC) mnC = c; if (c > mxC) mxC = c;
  }
  const cx = ((mnC + mxC) * step + pxCell) / 2;
  const cy = ((mnR + mxR) * step + pxCell) / 2;
  // Symmetric bounds around the centroid so the texture is centered on it.
  const margin = Math.max(8, outlineWidth(pxCell) + 4);
  const halfW = Math.max(cx - minX, maxX - cx) + margin;
  const halfH = Math.max(cy - minY, maxY - cy) + margin;
  const tw = Math.ceil(halfW * 2);
  const th = Math.ceil(halfH * 2);

  const g = scene.make.graphics({ add: false });
  // Translate so the centroid (cx, cy) in cell-pixel coords lands at the
  // texture center (tw/2, th/2). Consumer places the sprite at the
  // factory's centroid in absolute cell-pixel coords; origin (0.5, 0.5).
  g.translateCanvas(tw / 2 - cx, th / 2 - cy);
  drawFactoryBodyForBake(g, norm.cells, pxCell, pxGap, scale, {
    fill: fill ?? null, stroke: stroke ?? null, caution: !!caution, rotation,
  });
  g.generateTexture(key, tw, th);
  g.destroy();
  cache.add(key);
  return key;
}

// ---- Acid pit fill cache ----------------------------------------------------

// Bake an acid-pit component fill. Cache key uses normalized cells; the
// bake centers on the component's centroid so two pits of the same shape
// (different anchors) share the texture. Consumer places the sprite at the
// component's centroid (in absolute cell-pixel coords).
export function getOrBakeAcidFill(scene, opts) {
  const { cells, label, pxCell, pxGap } = opts;
  if (!cells || cells.length === 0) return null;
  const norm = normalizedCells(cells);
  const key = `${KEY_PREFIX}acidfill:${pxCell}:${pxGap}:${label || 'x'}:${normCellsHash(norm)}`;
  if (scene.textures.exists(key)) return key;
  const cache = getSceneCache(scene);
  const step = pxCell + pxGap;
  const ACID_FILL_SCALE = 0.58;
  const ACID_CORNER_FRAC = 0.38;
  const inner = pxCell * ACID_FILL_SCALE;
  const m = (pxCell - inner) / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let mnR = Infinity, mxR = -Infinity, mnC = Infinity, mxC = -Infinity;
  for (const { r, c } of norm.cells) {
    const x0 = c * step + m, y0 = r * step + m;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + inner > maxX) maxX = x0 + inner;
    if (y0 + inner > maxY) maxY = y0 + inner;
    if (r < mnR) mnR = r; if (r > mxR) mxR = r;
    if (c < mnC) mnC = c; if (c > mxC) mxC = c;
  }
  // Bridges between adjacent same-component cells overflow past `inner`
  // by (step - inner) — extend the bounds for bridges + stroke.
  const bridgePad = (step - inner);
  const stroke = Math.max(2, Math.round(pxCell * 0.05));
  const margin = Math.max(stroke, bridgePad);
  // Component centroid in cell-pixel coords (matches factoryCellsCenter
  // convention for consistency).
  const cx = ((mnC + mxC) * step + pxCell) / 2;
  const cy = ((mnR + mxR) * step + pxCell) / 2;
  const halfW = Math.max(cx - minX, maxX - cx) + margin;
  const halfH = Math.max(cy - minY, maxY - cy) + margin;
  const tw = Math.ceil(halfW * 2);
  const th = Math.ceil(halfH * 2);

  const g = scene.make.graphics({ add: false });
  g.translateCanvas(tw / 2 - cx, th / 2 - cy);
  drawAcidFillForBake(g, norm.cells, pxCell, pxGap, label, ACID_FILL_SCALE, ACID_CORNER_FRAC);
  g.generateTexture(key, tw, th);
  g.destroy();
  cache.add(key);
  return key;
}

// Centroid helper exposed for consumers that need to compute a sprite
// position to match the centered-bake convention. Returns the (cx, cy)
// centroid in cell-pixel coords using the cell-bbox-midpoint method
// shared by factoryCellsCenter.
export function cellsCentroid(cells, pxCell, pxGap) {
  if (!cells || cells.length === 0) return [0, 0];
  let mnR = Infinity, mxR = -Infinity, mnC = Infinity, mxC = -Infinity;
  for (const { r, c } of cells) {
    if (r < mnR) mnR = r; if (r > mxR) mxR = r;
    if (c < mnC) mnC = c; if (c > mxC) mxC = c;
  }
  const step = pxCell + pxGap;
  return [
    ((mnC + mxC) * step + pxCell) / 2,
    ((mnR + mxR) * step + pxCell) / 2,
  ];
}

// ---- Disposal ---------------------------------------------------------------
// Walk the per-scene cache, remove every cached texture from the texture
// manager, and clear the cache. Static atlases are never disposed.

export function disposeBakedGeometryCache(scene) {
  const cache = scene.__bakedGeometryCache;
  if (!cache) return;
  for (const key of cache) {
    try { scene.textures.remove(key); } catch (e) { /* tolerate */ }
    BAKE_ANCHORS.delete(key);
  }
  cache.clear();
}

// ---- Helpers ----------------------------------------------------------------

// Normalize a factory's cell array to a canonical form: shifted so the
// minimum row/col is 0, and sorted lexicographically. Strips per-cell flags
// that don't affect the body silhouette (label, bolt) — those render as
// separate Graphics layered on top.
function normalizedCells(cells) {
  let minR = Infinity, minC = Infinity;
  for (const cc of cells) {
    if (cc.r < minR) minR = cc.r;
    if (cc.c < minC) minC = cc.c;
  }
  const out = cells.map((cc) => ({ r: cc.r - minR, c: cc.c - minC }));
  out.sort((a, b) => (a.r - b.r) || (a.c - b.c));
  return { cells: out, originR: minR, originC: minC };
}

function normCellsHash(norm) {
  // Compact hash: cell list serialized as r,c|r,c|... Cheap and stable.
  return norm.cells.map((c) => `${c.r},${c.c}`).join('|');
}

// ---- Inlined factory-body bake (avoids cyclic import with FactoryBodyRenderer) ----

function drawFactoryBodyForBake(g, cells, pxCell, pxGap, scale, { fill, stroke, caution, rotation }) {
  // Resolve the effective fill — same logic as renderFactoryBody, minus the
  // bolt-driven circuit-board check (the body sprite is captured in its
  // unpowered state; the lit-green overlay stays as a Graphics layer above).
  const CAUTION_YELLOW = 0xd6a30b;
  let effectiveFill;
  if (caution)                          effectiveFill = CAUTION_YELLOW;
  else if (fill != null)                effectiveFill = fill;
  else if (cells && cells.length === 1) effectiveFill = SINGLE_CELL_FILL;
  else                                   effectiveFill = mixColor(BLOCK_LIGHT, BLOCK_DARK, 0.5);
  const effectiveStroke = stroke != null ? stroke : BLOCK_STROKE;

  drawBodyPath(g, cells, pxCell, pxGap, scale, effectiveFill, effectiveStroke);
  if (caution) drawCautionStripes(g, cells, pxCell, pxGap, scale, rotation);
}

function drawBodyPath(g, cells, pxCell, pxGap, scale, fill, stroke) {
  const loops = traceFactoryLoops(cells, pxCell, pxGap, scale);
  if (loops.length === 0) return;
  const strokeW = outlineWidth(pxCell);
  const cornerR = Math.max(3, Math.round(pxCell * scale * 0.18));
  let outerIdx = 0;
  if (loops.length > 1) {
    let maxArea = -Infinity;
    for (let i = 0; i < loops.length; i++) {
      const a = loopArea(loops[i]);
      if (a > maxArea) { maxArea = a; outerIdx = i; }
    }
  }
  g.lineStyle(strokeW, stroke, 1);
  for (let i = 0; i < loops.length; i++) {
    g.fillStyle(i === outerIdx ? fill : fill, 1);
    g.beginPath();
    traceLoopSubpath(g, loops[i], cornerR);
    g.fillPath();
    g.strokePath();
  }
}

function traceLoopSubpath(g, loop, cornerR) {
  const n = loop.length;
  let minHalf = Infinity;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    if (d < minHalf) minHalf = d;
  }
  const r = Math.max(1, Math.min(cornerR, minHalf));
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const toPrev = unitVec(prev[0] - curr[0], prev[1] - curr[1]);
    const toNext = unitVec(next[0] - curr[0], next[1] - curr[1]);
    const pIn  = [curr[0] + toPrev[0] * r, curr[1] + toPrev[1] * r];
    const pOut = [curr[0] + toNext[0] * r, curr[1] + toNext[1] * r];
    if (i === 0) g.moveTo(pIn[0], pIn[1]);
    else         g.lineTo(pIn[0], pIn[1]);
    sampleQuadratic(g, pIn, curr, pOut, 8);
  }
  g.closePath();
}

function sampleQuadratic(g, p0, p1, p2, steps) {
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    g.lineTo(x, y);
  }
}

function loopArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function drawCautionStripes(g, cells, pxCell, pxGap, scale, rotation = 0) {
  const CAUTION_BLACK = 0x1a1a1a;
  const step = pxCell + pxGap;
  const inner = pxCell * scale;
  const m = (pxCell - inner) / 2;
  const stripeW = Math.max(6, Math.round(pxCell * 0.24));
  const pitch = stripeW * 2;
  const rects = [];
  const set = new Set(cells.map((c) => `${c.r},${c.c}`));
  for (const { r, c } of cells) {
    rects.push([c * step + m, r * step + m, inner, inner]);
    if (set.has(`${r},${c + 1}`)) rects.push([c * step + m + inner, r * step + m, step - inner, inner]);
    if (set.has(`${r + 1},${c}`)) rects.push([c * step + m, r * step + m + inner, inner, step - inner]);
    if (set.has(`${r},${c + 1}`) && set.has(`${r + 1},${c}`) && set.has(`${r + 1},${c + 1}`)) {
      rects.push([c * step + m + inner, r * step + m + inner, step - inner, step - inner]);
    }
  }
  if (rects.length === 0) return;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    if (cell.r < minR) minR = cell.r;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.c > maxC) maxC = cell.c;
  }
  const cx = ((minC + maxC) * step + pxCell) / 2;
  const cy = ((minR + maxR) * step + pxCell) / 2;
  const useBackslash = (((rotation % 4) + 4) % 4) % 2 === 1;
  const dFn = useBackslash
    ? (px, py) => (px - cx) - (py - cy)
    : (px, py) => (px - cx) + (py - cy);
  let dcMin = Infinity, dcMax = -Infinity;
  for (const [x, y, w, h] of rects) {
    for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
      const dv = dFn(px, py);
      if (dv < dcMin) dcMin = dv;
      if (dv > dcMax) dcMax = dv;
    }
  }
  g.fillStyle(CAUTION_BLACK, 1);
  const halfW = stripeW / 2;
  const kStart = Math.floor((dcMin - halfW) / pitch) - 1;
  const kEnd   = Math.ceil((dcMax + halfW) / pitch) + 1;
  for (let k = kStart; k <= kEnd; k++) {
    const d = k * pitch;
    const d1 = d - halfW, d2 = d + halfW;
    for (const [x, y, w, h] of rects) {
      let rMin = Infinity, rMax = -Infinity;
      for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        const dv = dFn(px, py);
        if (dv < rMin) rMin = dv;
        if (dv > rMax) rMax = dv;
      }
      if (rMax < d1 || rMin > d2) continue;
      const poly = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      let p = clipHalfPlane(poly, (px, py) => dFn(px, py) - d1);
      p = clipHalfPlane(p, (px, py) => d2 - dFn(px, py));
      if (p.length < 3) continue;
      g.beginPath();
      g.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
      g.closePath();
      g.fillPath();
    }
  }
}

function clipHalfPlane(poly, f) {
  if (!poly || poly.length === 0) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a[0], a[1]);
    const fb = f(b[0], b[1]);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function mixColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// ---- Acid fill bake ---------------------------------------------------------
// Mirrors AcidPitRenderer.paintComponent's static layers: the rounded-bezier
// blob + per-cell rounded patches + bridges between adjacent same-label
// cells. Wobble outline / interior bubbles / edge bubbles are NOT baked —
// they continue to redraw per tick on a Graphics overlay above this sprite.

const ACID_WHITE = 0xeeeeee;

function drawAcidFillForBake(g, cells, pxCell, pxGap, label, ACID_FILL_SCALE, ACID_CORNER_FRAC) {
  const fillHex = label ? COLOR_HEX[label] : ACID_WHITE;
  const step = pxCell + pxGap;
  const fillInner = pxCell * ACID_FILL_SCALE;
  const fillM = (pxCell - fillInner) / 2;
  const fillCornerR = Math.max(3, Math.round(fillInner * ACID_CORNER_FRAC));

  // Base rounded-bezier blob.
  const loops = traceFactoryLoops(cells, pxCell, pxGap, ACID_FILL_SCALE);
  g.fillStyle(fillHex, 1);
  g.lineStyle(Math.max(2, Math.round(pxCell * 0.05)), fillHex, 1);
  for (const loop of loops) {
    g.beginPath();
    traceLoopSubpathAcid(g, loop, fillCornerR);
    g.fillPath();
    g.strokePath();
  }

  // Per-cell rounded patches.
  const cellSet = new Set(cells.map((cc) => `${cc.r},${cc.c}`));
  const has = (r, c) => cellSet.has(`${r},${c}`);
  g.fillStyle(fillHex, 1);
  for (const { r, c } of cells) {
    g.fillRoundedRect(c * step + fillM, r * step + fillM, fillInner, fillInner, fillCornerR);
  }
  const bridgeW = step - fillInner;
  for (const { r, c } of cells) {
    if (has(r, c + 1)) g.fillRect(c * step + fillM + fillInner, r * step + fillM, bridgeW, fillInner);
    if (has(r + 1, c)) g.fillRect(c * step + fillM, r * step + fillM + fillInner, fillInner, bridgeW);
    if (has(r, c + 1) && has(r + 1, c) && has(r + 1, c + 1)) {
      g.fillRect(c * step + fillM + fillInner, r * step + fillM + fillInner, bridgeW, bridgeW);
    }
  }
}

// Same as traceLoopSubpath but with a higher sample count for the rounder
// acid silhouette (matches AcidPitRenderer.traceAcidLoopSubpath).
function traceLoopSubpathAcid(g, loop, cornerR) {
  const n = loop.length;
  let minHalf = Infinity;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    if (d < minHalf) minHalf = d;
  }
  const r = Math.max(1, Math.min(cornerR, minHalf));
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const toPrev = unitVec(prev[0] - curr[0], prev[1] - curr[1]);
    const toNext = unitVec(next[0] - curr[0], next[1] - curr[1]);
    const pIn  = [curr[0] + toPrev[0] * r, curr[1] + toPrev[1] * r];
    const pOut = [curr[0] + toNext[0] * r, curr[1] + toNext[1] * r];
    if (i === 0) g.moveTo(pIn[0], pIn[1]);
    else         g.lineTo(pIn[0], pIn[1]);
    sampleQuadratic(g, pIn, curr, pOut, 10);
  }
  g.closePath();
}
