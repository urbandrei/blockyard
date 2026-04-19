import { buildManifoldSegments } from '../model/shape.js';
import { MANIFOLD_STROKE, SHAPE_SCALE, CYCLE_MS, outlineWidth } from '../constants.js';

// Flow lines inside each factory: for every input-to-output pair, draw a path
// through cell centers with quarter-circle arcs at turns, animated as moving
// white dashes. Each dash is its own Graphics-drawn rectangle aligned to a
// sampled point on the path, shifted each frame by the phase-distance curve.

const DASH_COUNT_PER_CELL = 2.2; // how many dashes show up per board cell of path

export function renderFlow(scene, container, { cells, funnels, pxCell, pxGap, scale = SHAPE_SCALE }) {
  const segments = buildManifoldSegments(cells, funnels, pxCell, pxGap, scale);
  const sampled = segments.map((s) => sampleSegment(s));
  const gfx = scene.make.graphics({ add: false });
  container.add(gfx);
  return {
    destroy() { gfx.destroy(); },
    // `time` is the raw scene time in ms — we need monotonic input so the dash
    // advance doesn't wrap back to 0 at the cycle boundary (which was causing
    // the visible "jump" every cycle).
    update(time) { paintFlow(gfx, sampled, time, pxCell); },
  };
}

// Convert a segment with rounded corners (quarter-circle arcs) into an array
// of sampled polyline points, plus precomputed cumulative arc lengths.
function sampleSegment(seg) {
  const pts = seg.pts;
  if (!pts || pts.length < 2) return { samples: [], totalLength: 0 };
  const r = seg.arcR;
  const samples = [];
  const pushSample = (x, y) => {
    const last = samples[samples.length - 1];
    if (last && last.x === x && last.y === y) return;
    const cum = last ? last.cum + Math.hypot(x - last.x, y - last.y) : 0;
    samples.push({ x, y, cum });
  };

  pushSample(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], curr = pts[i];
    if (i < pts.length - 1) {
      const next = pts[i + 1];
      const dxIn = curr[0] - prev[0], dyIn = curr[1] - prev[1];
      const dxOut = next[0] - curr[0], dyOut = next[1] - curr[1];
      const lenIn = Math.hypot(dxIn, dyIn);
      const lenOut = Math.hypot(dxOut, dyOut);
      const isTurn = lenIn > 0 && lenOut > 0 && Math.abs(dxIn * dxOut + dyIn * dyOut) < 1e-6;
      if (isTurn) {
        const rr = Math.min(r, lenIn / 2, lenOut / 2);
        const pEnd   = [curr[0] - (dxIn  / lenIn)  * rr, curr[1] - (dyIn  / lenIn)  * rr];
        const pAfter = [curr[0] + (dxOut / lenOut) * rr, curr[1] + (dyOut / lenOut) * rr];
        pushSample(pEnd[0], pEnd[1]);
        const cross = dxIn * dyOut - dyIn * dxOut;
        const sweep = cross > 0 ? 1 : -1;
        const center = arcCenter(pEnd, pAfter, rr, sweep);
        const a0 = Math.atan2(pEnd[1] - center[1], pEnd[0] - center[0]);
        const a1 = Math.atan2(pAfter[1] - center[1], pAfter[0] - center[0]);
        const steps = 8;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const a = lerpAngle(a0, a1, t, sweep);
          pushSample(center[0] + Math.cos(a) * rr, center[1] + Math.sin(a) * rr);
        }
        continue;
      }
    }
    pushSample(curr[0], curr[1]);
  }
  const totalLength = samples.length ? samples[samples.length - 1].cum : 0;
  return { samples, totalLength };
}

function arcCenter(p1, p2, r, sweep) {
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const d = Math.hypot(dx, dy);
  const perp = [-dy / d, dx / d];
  const half = d / 2;
  const h = Math.sqrt(Math.max(0, r * r - half * half));
  const s = sweep >= 0 ? 1 : -1;
  return [mx + perp[0] * h * s, my + perp[1] * h * s];
}

function lerpAngle(a0, a1, t, sweep) {
  let d = a1 - a0;
  if (sweep >= 0) { while (d < 0) d += 2 * Math.PI; }
  else            { while (d > 0) d -= 2 * Math.PI; }
  return a0 + d * t;
}

function paintFlow(gfx, segmentsSampled, time, pxCell) {
  gfx.clear();
  const strokeW = outlineWidth(pxCell);
  // Linear constant-speed advance: one board cell per cycle, no plateau/ease.
  // Monotonic across cycle boundaries so there's no cycle-boundary jump.
  const advance = (time / CYCLE_MS) * pxCell;
  for (const seg of segmentsSampled) {
    if (!seg.totalLength) continue;
    const dashCount = Math.max(1, Math.round(seg.totalLength / pxCell * DASH_COUNT_PER_CELL));
    const dashStep = seg.totalLength / dashCount;
    const dashLen = Math.max(2, dashStep * 0.45);
    for (let i = 0; i < dashCount; i++) {
      // Dash midpoints are evenly spaced and advance together; that way fade
      // is computed on a stable-per-dash value and the dash's alpha changes
      // smoothly as it slides toward the funnel edge.
      const baseMid = i * dashStep + dashLen / 2;
      const mid = ((baseMid + advance) % seg.totalLength + seg.totalLength) % seg.totalLength;
      const start = (mid - dashLen / 2 + seg.totalLength) % seg.totalLength;
      const end   = (mid + dashLen / 2) % seg.totalLength;
      const alpha = endpointFade(mid, seg.totalLength, pxCell);
      if (alpha <= 0.01) continue;
      drawDash(gfx, seg, start, end, strokeW, alpha);
    }
  }
}

// Fade a dash near the segment's endpoints so the line doesn't punch into the
// funnel's fill. Fades linearly over a margin of ~0.6 * pxCell from each end.
function endpointFade(dist, total, pxCell) {
  const margin = pxCell * 0.6;
  if (total <= margin * 2) return Math.min(dist / margin, (total - dist) / margin, 1);
  const fromStart = dist;
  const fromEnd   = total - dist;
  return Math.max(0, Math.min(1, fromStart / margin, fromEnd / margin));
}

function drawDash(gfx, seg, start, end, strokeW, alpha) {
  if (end > start) {
    strokeSubPath(gfx, seg, start, end, strokeW, alpha);
    return;
  }
  strokeSubPath(gfx, seg, start, seg.totalLength, strokeW, alpha);
  strokeSubPath(gfx, seg, 0, end, strokeW, alpha);
}

function strokeSubPath(gfx, seg, from, to, strokeW, alpha) {
  if (to <= from) return;
  const s = seg.samples;
  gfx.lineStyle(strokeW, MANIFOLD_STROKE, alpha);
  gfx.beginPath();
  const p0 = pointAt(seg, from);
  gfx.moveTo(p0[0], p0[1]);
  for (let i = 1; i < s.length; i++) {
    if (s[i].cum <= from) continue;
    if (s[i].cum >= to) {
      const prev = s[i - 1];
      const t = (to - prev.cum) / (s[i].cum - prev.cum || 1);
      gfx.lineTo(prev.x + (s[i].x - prev.x) * t, prev.y + (s[i].y - prev.y) * t);
      break;
    }
    gfx.lineTo(s[i].x, s[i].y);
  }
  gfx.strokePath();
}

function pointAt(seg, dist) {
  const s = seg.samples;
  if (s.length === 0) return null;
  if (dist <= 0) return [s[0].x, s[0].y];
  if (dist >= seg.totalLength) return [s[s.length - 1].x, s[s.length - 1].y];
  for (let i = 1; i < s.length; i++) {
    if (s[i].cum >= dist) {
      const prev = s[i - 1];
      const t = (dist - prev.cum) / (s[i].cum - prev.cum || 1);
      return [prev.x + (s[i].x - prev.x) * t, prev.y + (s[i].y - prev.y) * t];
    }
  }
  return [s[s.length - 1].x, s[s.length - 1].y];
}
