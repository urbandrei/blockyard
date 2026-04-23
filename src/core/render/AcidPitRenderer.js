import { traceFactoryLoops, COLOR_HEX } from '../model/shape.js';
import { ACID_WHITE, BOARD_GAP } from '../constants.js';

// Renders acid-pit terrain as rounded, inset puddles in the playable
// interior. Shapes fly over them. Single-cell storage (level.acidPits[]);
// the renderer unions ALL adjacent acid cells into one contiguous blob
// regardless of label, so different-label neighbours merge smoothly with
// a gradient seam at the shared edge (no internal black border).
//
// Returns { destroy, tick(timeMs) }. `tick` redraws the subtle wobble on
// each cosmetic frame; fills and base outline are static per render.

// Visual tuning.
//   ACID_OUTLINE_SCALE — how much of each cell the blob's OUTLINE wraps
//                       around. Sets the outer boundary that the wobble
//                       oscillates across.
//   ACID_FILL_SCALE    — fraction of each cell that's actually painted.
//                       Kept smaller than the outline scale so even the
//                       outline's inward wobble never exposes raw floor
//                       inside the blob.
//   ACID_CORNER_FRAC   — corner radius (fraction of `inner`). Higher than
//                       factories so the puddle reads as bulbous.
const ACID_OUTLINE_SCALE = 0.64;
const ACID_FILL_SCALE = 0.58;
const ACID_CORNER_FRAC = 0.38;
// Subtle breathing on the perimeter — a touch of life, not a quiver.
const WOBBLE_AMP_FRAC = 0.018;
const WOBBLE_FREQ_FRAC = 1.1;
const WOBBLE_ANG_VEL = 0.45;
const PERIMETER_SAMPLE_PX = 5;
// Bubbles.
const INTERIOR_BUBBLE_PER_CELL = 0.6;     // ~0.6 live bubbles per acid cell at any time
const INTERIOR_BUBBLE_LIFE_MS = 1100;
// Fraction of the life that's the pop phase — smaller = faster pop.
const POP_FRAC = 0.18;
const INTERIOR_BUBBLE_R_FRAC = 0.055;     // max radius = 5.5% of pxCell
const EDGE_BUBBLE_R_FRAC = 0.032;
const EDGE_BUBBLE_EVERY_SAMPLES = 14;     // one edge bubble every ~N perimeter samples
// Extra inset for edge bubbles beyond their own radius — higher = tucked
// further inside the outline.
const EDGE_BUBBLE_EXTRA_INSET_FRAC = 0.045;   // fraction of pxCell

export function renderAcidPits(scene, container, level, { pxCell, pxGap = BOARD_GAP }) {
  const pits = (level && level.acidPits) || [];
  container.removeAll(true);

  // Three gfx layers:
  //   fillGfx    — base blob fill + per-cell color patches + gradient seams (static).
  //   edgeGfx    — rounded outer outline, redrawn each tick for subtle wobble.
  //   bubbleGfx  — interior + edge bubbles, redrawn each tick.
  const fillGfx = scene.add.graphics();
  const edgeGfx = scene.add.graphics();
  const bubbleGfx = scene.add.graphics();
  container.add(fillGfx);
  container.add(edgeGfx);
  container.add(bubbleGfx);

  if (pits.length === 0) {
    return { destroy() { fillGfx.destroy(); edgeGfx.destroy(); bubbleGfx.destroy(); }, tick() {} };
  }

  const labelByCell = new Map();
  for (const p of pits) {
    labelByCell.set(`${p.r},${p.c}`, (p.label && p.label.color) || null);
  }
  const hexOf = (labelName) => labelName ? COLOR_HEX[labelName] : ACID_WHITE;

  const components = sameLabelComponents(pits, labelByCell);
  const step = pxCell + pxGap;

  // Precompute per-component state.
  const compStates = components.map((comp) => {
    paintComponent(fillGfx, comp, labelByCell, hexOf, pxCell, pxGap);
    const loops = traceFactoryLoops(comp.cells, pxCell, pxGap, ACID_OUTLINE_SCALE);
    const loopSamples = loops.map((loop) => resampleBezierLoop(loop, pxCell, PERIMETER_SAMPLE_PX));
    // Edge bubbles — steady bubbles anchored to specific samples around the
    // perimeter. Each is attached to a sampleIdx; per tick its position is
    // read from the wobbled sample so the bubble rides the wave.
    const edgeBubbles = [];
    for (let li = 0; li < loopSamples.length; li++) {
      const samples = loopSamples[li];
      for (let i = 0; i < samples.length; i += EDGE_BUBBLE_EVERY_SAMPLES) {
        // Pseudo-random radius + outward offset based on sample index so
        // the pattern is deterministic across redraws.
        const seed = mulberry32((li * 1013 + i * 37) | 0);
        edgeBubbles.push({
          loopIdx: li,
          sampleIdx: i,
          rFrac: 0.6 + 0.4 * seed(),
          offsetFrac: -0.1 - 0.3 * seed(), // slightly inward
          wobblePhase: seed() * Math.PI * 2,
        });
      }
    }
    // Interior bubble homes — random positions within each acid cell. We
    // lazily spawn live bubbles at these home points; each bubble runs its
    // grow/hold/pop cycle and despawns, with a replacement spawned elsewhere.
    return { comp, loops, loopSamples, edgeBubbles, liveBubbles: [] };
  });

  // Top up interior bubbles so each component holds a rough quota.
  const quotaFor = (comp) => Math.max(1, Math.round(comp.cells.length * INTERIOR_BUBBLE_PER_CELL));

  const rand = mulberry32(0xac1d1d);

  const tick = (timeMs) => {
    const t = (timeMs || 0) / 1000;
    const ampBase = Math.max(0.5, pxCell * WOBBLE_AMP_FRAC);
    const freq = (2 * Math.PI) / (pxCell * WOBBLE_FREQ_FRAC);
    const strokeW = Math.max(2, Math.round(pxCell * 0.05));
    const edgeBubbleR = Math.max(1.5, pxCell * EDGE_BUBBLE_R_FRAC);
    const intBubbleR = Math.max(2, pxCell * INTERIOR_BUBBLE_R_FRAC);

    edgeGfx.clear();
    bubbleGfx.clear();

    for (const state of compStates) {
      // ---- Outline (wobbled, per-segment color blend) ----
      const wobbledLoops = state.loopSamples.map((samples) =>
        wobblePoints(samples, ampBase, freq, t * WOBBLE_ANG_VEL),
      );
      const outlineHex = darkenHex(hexOf(state.comp.label), 0.55);
      for (let li = 0; li < wobbledLoops.length; li++) {
        const wobbled = wobbledLoops[li];
        if (wobbled.length < 3) continue;
        drawSmoothOutline(edgeGfx, wobbled, strokeW, outlineHex);
      }

      // ---- Edge bubbles (steady, ride the wave) ----
      for (const eb of state.edgeBubbles) {
        const wobbled = wobbledLoops[eb.loopIdx];
        const samples = state.loopSamples[eb.loopIdx];
        if (!wobbled || eb.sampleIdx >= wobbled.length) continue;
        const pt = wobbled[eb.sampleIdx];
        const sN = samples[eb.sampleIdx];
        // Gentle slow size breath per-bubble so the row doesn't feel robotic.
        const br = edgeBubbleR * eb.rFrac * (0.85 + 0.15 * Math.sin(t * 0.9 + eb.wobblePhase));
        // Bubble sits inside the border — offset inward by its radius
        // (tangent to inner edge) + an extra inset so there's a visible
        // margin between the bubble and the outline.
        const inset = br + pxCell * EDGE_BUBBLE_EXTRA_INSET_FRAC;
        const ox = pt[0] - sN.nx * inset;
        const oy = pt[1] - sN.ny * inset;
        drawBubble(bubbleGfx, ox, oy, br);
      }

      // ---- Interior bubbles (grow / pop) ----
      // Progress existing bubbles, remove completed.
      const live = state.liveBubbles;
      for (let i = live.length - 1; i >= 0; i--) {
        const b = live[i];
        const age = timeMs - b.birth;
        if (age >= INTERIOR_BUBBLE_LIFE_MS) { live.splice(i, 1); continue; }
      }
      // Top up.
      const quota = quotaFor(state.comp);
      while (live.length < quota) {
        const cell = state.comp.cells[Math.floor(rand() * state.comp.cells.length)];
        // Inset within the cell's fill area so bubbles sit inside the blob.
        const inner = pxCell * ACID_FILL_SCALE;
        const m = (pxCell - inner) / 2;
        const pad = Math.max(2, intBubbleR * 1.2);
        const x = cell.c * step + m + pad + rand() * (inner - 2 * pad);
        const y = cell.r * step + m + pad + rand() * (inner - 2 * pad);
        live.push({
          x, y,
          birth: timeMs + rand() * 600,  // staggered spawn
          sizeFrac: 0.6 + 0.4 * rand(),
          popSeed: rand() * Math.PI * 2,  // random rotation for the starburst
        });
      }
      // Draw each bubble at its current scale based on life progress.
      //   Grow (0 → 0.3):        circle scales 0 → peak.
      //   Hold (0.3 → 1 - POP_FRAC): full circle.
      //   Pop  (last POP_FRAC):  circle vanishes, short star-burst.
      const popStart = 1 - POP_FRAC;
      for (const b of live) {
        const age = timeMs - b.birth;
        if (age < 0) continue;                // not yet started (stagger)
        const t01 = age / INTERIOR_BUBBLE_LIFE_MS;
        const peakR = intBubbleR * b.sizeFrac;
        if (t01 < popStart) {
          const s = t01 < 0.3 ? t01 / 0.3 : 1;
          const r = peakR * s;
          if (r > 0.5) drawBubble(bubbleGfx, b.x, b.y, r);
        } else {
          const popT = (t01 - popStart) / POP_FRAC;
          drawPopBurst(bubbleGfx, b.x, b.y, peakR, popT, b.popSeed);
        }
      }
    }
  };

  tick(0);

  return {
    destroy() { fillGfx.destroy(); edgeGfx.destroy(); bubbleGfx.destroy(); },
    tick,
  };
}

// Bubble — transparent interior, black outline. Reads as a glassy
// circle on top of the acid blob instead of a painted-on white dot.
function drawBubble(gfx, x, y, r) {
  gfx.lineStyle(1.2, 0x1a2332, 0.85);
  gfx.strokeCircle(x, y, r);
}

// Star-burst "pop" — a small, quick black-outline star. Juice dialled
// down: short reach, thin spikes, no central dot.
function drawPopBurst(gfx, x, y, peakR, popT, popSeed) {
  const spikeAlpha = Math.max(0, 1 - popT);
  if (spikeAlpha <= 0) return;
  const ease = 1 - (1 - popT) * (1 - popT);
  const reach = peakR * (0.9 + ease * 0.6);   // topped out at ~1.5× peakR
  const spikeW = Math.max(0.8, peakR * 0.1);
  const POINTS = 5;
  gfx.lineStyle(spikeW, 0x1a2332, spikeAlpha);
  for (let i = 0; i < POINTS; i++) {
    const ang = popSeed + (i * 2 * Math.PI) / POINTS;
    const x1 = x + Math.cos(ang) * peakR * 0.25;
    const y1 = y + Math.sin(ang) * peakR * 0.25;
    const x2 = x + Math.cos(ang) * reach;
    const y2 = y + Math.sin(ang) * reach;
    gfx.beginPath();
    gfx.moveTo(x1, y1);
    gfx.lineTo(x2, y2);
    gfx.strokePath();
  }
}

// Deterministic PRNG so edge-bubble placements + sizes don't jitter per frame.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Filling
// ------------------------------------------------------------------

// Paint the fill for one union-component:
//   1. Base rounded blob fill via drawFactoryBodyInto (neutral colour —
//      hidden by the per-cell and bridge patches that follow, only
//      visible if there's a weird gap).
//   2. Per-cell rounded-rect patches (label color, cornerR matching the
//      blob's bezier corners so outer-corner cells render as rounded).
//   3. Per-bridge rectangles between adjacent cells — same-label bridges
//      get a solid fill; different-label bridges get a multi-sub-rect
//      gradient strip that blends A into B across the shared edge.
//   4. Per-2x2 center patches for full 2x2 blocks.
function paintComponent(gfx, comp, labelByCell, hexOf, pxCell, pxGap) {
  const step = pxCell + pxGap;
  const fillInner = pxCell * ACID_FILL_SCALE;
  const fillM = (pxCell - fillInner) / 2;
  const fillCornerR = Math.max(3, Math.round(fillInner * ACID_CORNER_FRAC));

  // Component is guaranteed same-label, so one colour paints everything.
  const label = labelByCell.get(`${comp.cells[0].r},${comp.cells[0].c}`) || null;
  const fillHex = hexOf(label);

  // Base rounded-bezier blob — sits fully inside the outline's wobble
  // range thanks to ACID_FILL_SCALE < ACID_OUTLINE_SCALE.
  drawAcidBlob(gfx, comp.cells, pxCell, pxGap, ACID_FILL_SCALE, fillCornerR, fillHex);

  const cellSet = new Set(comp.cells.map((cc) => `${cc.r},${cc.c}`));
  const has = (r, c) => cellSet.has(`${r},${c}`);

  // Per-cell rounded patches. drawAcidBlob already covered most pixels,
  // but the explicit rounded-rect per cell makes sure the corners align
  // with the cell grid at the same cornerR the outline uses.
  gfx.fillStyle(fillHex, 1);
  for (const { r, c } of comp.cells) {
    gfx.fillRoundedRect(c * step + fillM, r * step + fillM, fillInner, fillInner, fillCornerR);
  }

  // Bridges between adjacent same-label cells — flat rect, same colour.
  const bridgeW = step - fillInner;
  for (const { r, c } of comp.cells) {
    if (has(r, c + 1)) {
      gfx.fillRect(c * step + fillM + fillInner, r * step + fillM, bridgeW, fillInner);
    }
    if (has(r + 1, c)) {
      gfx.fillRect(c * step + fillM, r * step + fillM + fillInner, fillInner, bridgeW);
    }
    // 2x2 center patch — always uniform colour now.
    if (has(r, c + 1) && has(r + 1, c) && has(r + 1, c + 1)) {
      gfx.fillRect(c * step + fillM + fillInner, r * step + fillM + fillInner, bridgeW, bridgeW);
    }
  }

  // Different-label acid neighbours are deliberately NOT bridged — the
  // floor gap between them reads as a clean separator, same as between an
  // acid pit and a non-acid floor cell. (Earlier half-bridge attempts only
  // covered the central fillInner span and left messy partial brown at the
  // rounded-corner shoulders + the 4-cell diagonal corner.)
}


// ------------------------------------------------------------------
// Blob rendering with a custom corner radius
// ------------------------------------------------------------------

// Draw the union-blob as a filled rounded bezier path. Mirrors
// FactoryBodyRenderer.drawFactoryBodyInto but lets us pick a rounder
// cornerR than factories use. Fills with a single `fillColor` — per-cell
// colors and seams paint on top.
function drawAcidBlob(gfx, cells, pxCell, pxGap, scale, cornerR, fillColor) {
  const loops = traceFactoryLoops(cells, pxCell, pxGap, scale);
  if (loops.length === 0) return;
  // For multi-loop cases (e.g. a ring with a hole) we don't support
  // holeFill — acid pits don't have meaningful holes — but we still pick
  // the largest-area loop as the outer for consistency with factories.
  let outerIdx = 0;
  if (loops.length > 1) {
    let maxArea = -Infinity;
    for (let i = 0; i < loops.length; i++) {
      const a = Math.abs(loopSignedArea(loops[i]));
      if (a > maxArea) { maxArea = a; outerIdx = i; }
    }
  }
  // Stroke with the same color so there's no visible dark band — the real
  // colored outline is drawn in edgeGfx on every tick.
  gfx.fillStyle(fillColor, 1);
  gfx.lineStyle(Math.max(2, Math.round(pxCell * 0.05)), fillColor, 1);
  for (let i = 0; i < loops.length; i++) {
    gfx.beginPath();
    traceAcidLoopSubpath(gfx, loops[i], cornerR);
    gfx.fillPath();
    gfx.strokePath();
  }
  void outerIdx;
}

// Append one loop as a subpath with rounded bezier corners. `cornerR` is
// clamped per-vertex so it never exceeds half the shortest adjacent edge.
function traceAcidLoopSubpath(gfx, loop, cornerR) {
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
    const toPrev = unit(prev[0] - curr[0], prev[1] - curr[1]);
    const toNext = unit(next[0] - curr[0], next[1] - curr[1]);
    const pIn  = [curr[0] + toPrev[0] * r, curr[1] + toPrev[1] * r];
    const pOut = [curr[0] + toNext[0] * r, curr[1] + toNext[1] * r];
    if (i === 0) gfx.moveTo(pIn[0], pIn[1]);
    else         gfx.lineTo(pIn[0], pIn[1]);
    sampleQuadratic(gfx, pIn, curr, pOut, 10);
  }
  gfx.closePath();
}

function sampleQuadratic(gfx, p0, p1, p2, steps) {
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    gfx.lineTo(x, y);
  }
}

// ------------------------------------------------------------------
// Components
// ------------------------------------------------------------------

// Same-label adjacency: adjacent cells merge into one blob ONLY if they
// share the same label. Different-label cells, even if adjacent, are
// separate components with their own outlines. No gradient seams.
function sameLabelComponents(pits, labelByCell) {
  const set = new Set();
  for (const p of pits) set.add(`${p.r},${p.c}`);
  const labelAt = (r, c) => labelByCell.get(`${r},${c}`) || null;
  const visited = new Set();
  const comps = [];
  for (const p of pits) {
    const key = `${p.r},${p.c}`;
    if (visited.has(key)) continue;
    const compLabel = labelAt(p.r, p.c);
    const stack = [{ r: p.r, c: p.c }];
    const cells = [];
    while (stack.length) {
      const cur = stack.pop();
      const ck = `${cur.r},${cur.c}`;
      if (visited.has(ck)) continue;
      if (!set.has(ck)) continue;
      if (labelAt(cur.r, cur.c) !== compLabel) continue;
      visited.add(ck);
      cells.push({ r: cur.r, c: cur.c });
      stack.push({ r: cur.r - 1, c: cur.c });
      stack.push({ r: cur.r + 1, c: cur.c });
      stack.push({ r: cur.r, c: cur.c - 1 });
      stack.push({ r: cur.r, c: cur.c + 1 });
    }
    comps.push({ cells, label: compLabel });
  }
  return comps;
}

// ------------------------------------------------------------------
// Perimeter polyline with rounded corners
// ------------------------------------------------------------------

// Build a dense polyline tracing `loop` with rounded bezier corners (same
// geometry as drawFactoryBodyInto's traceLoopSubpath) plus evenly-sampled
// points along the straight edges. Each output point carries outward
// normal + arc-length so `wobblePoints` can perturb along a sine.
function resampleBezierLoop(loop, pxCell, spacingPx) {
  if (!loop || loop.length < 3) return [];
  const n = loop.length;
  const cornerR = Math.max(3, Math.round(pxCell * ACID_OUTLINE_SCALE * ACID_CORNER_FRAC));
  // Clamp corner radius against the shortest adjacent half-edge.
  let minHalf = Infinity;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    if (d < minHalf) minHalf = d;
  }
  const r = Math.max(1, Math.min(cornerR, minHalf));

  // First pass — gather endpoints of each bezier corner so the straight
  // segments between corners can be sampled separately.
  const corners = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    const toPrev = unit(prev[0] - curr[0], prev[1] - curr[1]);
    const toNext = unit(next[0] - curr[0], next[1] - curr[1]);
    const pIn  = [curr[0] + toPrev[0] * r, curr[1] + toPrev[1] * r];
    const pOut = [curr[0] + toNext[0] * r, curr[1] + toNext[1] * r];
    corners[i] = { pIn, pOut, curr };
  }

  // Second pass — interleave: straight segment (prev.pOut → curr.pIn),
  // then bezier corner (curr.pIn → curr.curr → curr.pOut).
  const samples = [];
  let sAccum = 0;
  const pushLine = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    const steps = Math.max(1, Math.round(len / spacingPx));
    const nx = dy / len, ny = -dx / len;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      samples.push({
        x: a[0] + dx * t, y: a[1] + dy * t,
        nx, ny, s: sAccum + t * len,
      });
    }
    sAccum += len;
  };
  const pushBezier = (p0, p1, p2) => {
    const totalLen = approxBezierLen(p0, p1, p2);
    const steps = Math.max(4, Math.round(totalLen / spacingPx));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
      const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
      // Tangent via derivative: 2(1-t)(P1-P0) + 2t(P2-P1).
      const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
      const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
      const tl = Math.hypot(tx, ty) || 1;
      samples.push({
        x, y,
        nx: ty / tl, ny: -tx / tl,
        s: sAccum + (k / steps) * totalLen,
      });
    }
    sAccum += totalLen;
  };

  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const curr = corners[i];
    pushLine(prev.pOut, curr.pIn);
    pushBezier(curr.pIn, curr.curr, curr.pOut);
  }

  // Outward orientation — loop is CW or CCW? Flip normals if inward.
  const signedA = loopSignedArea(loop);
  const sign = signedA < 0 ? 1 : -1;
  for (const p of samples) { p.nx *= sign; p.ny *= sign; }
  return samples;
}

function wobblePoints(samples, amp, freq, phase) {
  const out = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const offset = amp * Math.sin(freq * p.s + phase);
    out[i] = [p.x + p.nx * offset, p.y + p.ny * offset];
  }
  return out;
}

function approxBezierLen(p0, p1, p2) {
  // Chord + 2× control-arm average; tight for gentle curves.
  const chord = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  const arm   = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
              + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  return (chord + arm) / 2;
}

function loopSignedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function unit(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

// ------------------------------------------------------------------
// Colored perimeter stroke
// ------------------------------------------------------------------

// Stroke the wobbled perimeter in a single uniform colour — each component
// is same-label so no per-segment blending is needed.
function drawSmoothOutline(gfx, wobbled, strokeW, strokeHex) {
  const n = wobbled.length;
  if (n < 2) return;
  gfx.lineStyle(strokeW, strokeHex, 1);
  gfx.beginPath();
  gfx.moveTo(wobbled[0][0], wobbled[0][1]);
  for (let i = 1; i < n; i++) {
    gfx.lineTo(wobbled[i][0], wobbled[i][1]);
  }
  gfx.closePath();
  gfx.strokePath();
}

function darkenHex(hex, t) {
  const r = Math.round(((hex >> 16) & 0xff) * t);
  const g = Math.round(((hex >> 8) & 0xff) * t);
  const b = Math.round((hex & 0xff) * t);
  return (r << 16) | (g << 8) | b;
}

// ------------------------------------------------------------------
// Color helpers
// ------------------------------------------------------------------

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

