// Decorative gears around every factory. Uses the authored gear SVGs
// (`public/gears/*.svg`) loaded as textures in PreloadScene — each
// factory picks a deterministic sparse subset, varies the size,
// direction, and spin speed, and the rotation tracks
// `cumulativeDistance(simTime / CYCLE_MS)` so the gears slow down in
// the shape-slow plateau phases and speed up on the fast transitions.
//
// Rotation stability:
//   Gears are authored in the factory's BASE orientation — we compute
//   anchors from `baseCells` / `baseFunnels`, position the wrap at the
//   factory's *base* world center (unchanged by rotation, since
//   `p.anchor` is preserved across rotations), and the caller sets
//   `wrap.rotation = factoryRotation * π/2` to bring the gears to
//   their rotated visual positions. This guarantees the same gear at
//   the same physical cell-edge across rotations — blueprint, ghost,
//   and placed copies all agree, even while a 90° tween is in flight.
//
// Returned handle:
//   • `wrap`   — container carrying every gear (outline + fill sprite
//                pair per gear), positioned at the factory's base
//                center; tween-compatible with the factory's body/
//                funnel wraps (add `wrap` to the rotation target list,
//                but NOT the x/y target — the base center is fixed).
//   • `gears`  — array of { outline, fill, direction, speedMul } for
//                `spinFactoryGears(...)` to drive each frame.
//   • `destroy()` — tear-down.

import { CYCLE_MS, cumulativeDistance, outlineWidth } from '../constants.js';

const TEXTURES = ['gear_quadrant', 'gear_chainring', 'gear_hexflex', 'gear_triad'];
// SVG viewBox is -100..100 (200 units wide) but the gear's tooth tips
// only reach ~92 units — there's an ~8% padding ring inside the box.
// Rasterized at 800×800, the tooth tips land at ~368 px from center,
// so scale = desiredRadius / 368 makes the painted sprite's outer
// tooth tip sit exactly at `desiredRadius`, matching the old
// Graphics-drawn gears which drew to `radius` directly.
const TEXTURE_NATIVE_R = 368;

// Solid black silhouettes with a medium-grey outline ring that matches
// the factory body stroke in weight — the gear reads as heavy machinery
// against the peach floor without blending into the factory's own dark
// outline where it overlaps.
const GEAR_FILL_TINT    = 0x000000;
const GEAR_OUTLINE_TINT = 0x7a7d82;
const GEAR_ALPHA        = 1;

// Rotations per shape-motion cycle at speedMul = 1, direction = +1.
const BASE_REVS_PER_CYCLE = 0.5;
// Size envelope — min fraction of the anchor's maxR.
const MIN_SIZE_FRAC = 0.75;

function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Compute the base factory's visual center (relative to `anchor.row,col`)
// in wrap-local px coords: average of per-cell centers using `pxCell`
// and `pxGap`. Same formula as `factoryCenter(cells, ...)` in the
// scenes, inlined here to keep this module dependency-free.
function baseCenter(cells, pxCell, pxGap) {
  const step = pxCell + pxGap;
  let sx = 0, sy = 0;
  for (const c of cells) {
    sx += c.c * step + pxCell / 2;
    sy += c.r * step + pxCell / 2;
  }
  return [sx / cells.length, sy / cells.length];
}

// Gear anchors along the OUTER perimeter of the base factory. Any
// outer side that already carries a funnel triangle is skipped so the
// gear never visually clashes with a funnel glyph. Returned positions
// are in wrap-local coords, relative to the base center so the wrap
// can be placed at that center in world space.
function collectAnchors(cells, funnels, pxCell, pxGap) {
  const step = pxCell + pxGap;
  const [bcx, bcy] = baseCenter(cells, pxCell, pxGap);
  const has = new Set(cells.map((c) => `${c.r},${c.c}`));
  const funnelAt = new Set((funnels || []).map((f) => `${f.r},${f.c},${f.side}`));
  const anchors = [];
  const OUTER_OFFSET = pxCell * 0.2;
  const MAX_R        = pxCell * 0.35;
  for (const cell of cells) {
    const cx = cell.c * step + pxCell / 2 - bcx;
    const cy = cell.r * step + pxCell / 2 - bcy;
    const topOuter    = !has.has(`${cell.r - 1},${cell.c}`);
    const bottomOuter = !has.has(`${cell.r + 1},${cell.c}`);
    const leftOuter   = !has.has(`${cell.r},${cell.c - 1}`);
    const rightOuter  = !has.has(`${cell.r},${cell.c + 1}`);
    const topFunnel    = funnelAt.has(`${cell.r},${cell.c},top`);
    const bottomFunnel = funnelAt.has(`${cell.r},${cell.c},bottom`);
    const leftFunnel   = funnelAt.has(`${cell.r},${cell.c},left`);
    const rightFunnel  = funnelAt.has(`${cell.r},${cell.c},right`);
    if (topOuter    && !topFunnel)    anchors.push({ x: cx,                 y: cy - OUTER_OFFSET, maxR: MAX_R });
    if (bottomOuter && !bottomFunnel) anchors.push({ x: cx,                 y: cy + OUTER_OFFSET, maxR: MAX_R });
    if (leftOuter   && !leftFunnel)   anchors.push({ x: cx - OUTER_OFFSET,  y: cy,                maxR: MAX_R });
    if (rightOuter  && !rightFunnel)  anchors.push({ x: cx + OUTER_OFFSET,  y: cy,                maxR: MAX_R });
  }
  return anchors;
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Render the decorative gears for a factory.
//
// `factory.cells` / `factory.funnels` MUST be the BASE (unrotated)
// layout — the caller conveys the current rotation by setting
// `wrap.rotation = factory.rotation * Math.PI/2` so the wrap rotates
// the gears to their visual positions.
export function renderFactoryGears(scene, wrap, factory, { pxCell, pxGap, seed }) {
  // Stubbed — gears disabled globally until the outstanding visual
  // issues (rotation drift on asymmetric factories, squash pivot
  // mismatch, blueprint/ghost seam jitter) are resolved. All call
  // sites get a valid empty handle so the rest of the render stack
  // keeps working unchanged.
  return { wrap, gears: [], destroy() {} };
  // eslint-disable-next-line no-unreachable
  const anchors = collectAnchors(factory.cells, factory.funnels, pxCell, pxGap);
  if (anchors.length === 0) return { wrap, gears: [], destroy() {} };

  const rng = mulberry32(hashStr(seed != null ? seed : factory.id || ''));
  shuffleInPlace(anchors, rng);

  // Sparse: about one third of the perimeter anchors become gears.
  const pickCount = Math.max(1, Math.min(anchors.length, Math.max(2, Math.ceil(anchors.length / 3))));

  const outlinePx = outlineWidth(pxCell);
  const gears = [];
  for (let i = 0; i < pickCount; i++) {
    const anchor     = anchors[i];
    const textureKey = TEXTURES[Math.floor(rng() * TEXTURES.length)];
    const sizeFrac   = MIN_SIZE_FRAC + rng() * (1 - MIN_SIZE_FRAC);
    const radius     = anchor.maxR * sizeFrac;
    const fillScale    = radius / TEXTURE_NATIVE_R;
    const outlineScale = (radius + outlinePx) / TEXTURE_NATIVE_R;
    const direction  = rng() < 0.5 ? -1 : 1;
    const speedMul   = 0.45 + rng() * 1.6;

    // Outline first → behind the fill. Slightly larger so a stroke-
    // width ring of grey peeks past the black silhouette on every tooth.
    const outline = scene.add.image(anchor.x, anchor.y, textureKey);
    outline.setScale(outlineScale);
    outline.setTint(GEAR_OUTLINE_TINT);
    outline.setAlpha(GEAR_ALPHA);
    wrap.add(outline);

    const fill = scene.add.image(anchor.x, anchor.y, textureKey);
    fill.setScale(fillScale);
    fill.setTint(GEAR_FILL_TINT);
    fill.setAlpha(GEAR_ALPHA);
    wrap.add(fill);

    gears.push({ outline, fill, direction, speedMul });
  }

  return {
    wrap,
    gears,
    destroy() {
      for (const g of gears) {
        try { g.outline.destroy(); } catch (e) {}
        try { g.fill.destroy();    } catch (e) {}
      }
      gears.length = 0;
    },
  };
}

export function spinFactoryGears(gears, simTimeMs) {
  if (!gears || gears.length === 0) return;
  const base = cumulativeDistance((simTimeMs || 0) / CYCLE_MS) * Math.PI * 2 * BASE_REVS_PER_CYCLE;
  for (const g of gears) {
    const rot = base * g.speedMul * g.direction;
    if (g.outline) g.outline.rotation = rot;
    if (g.fill)    g.fill.rotation    = rot;
  }
}
