// Shared shape primitives that show up in multiple renderers (factory body
// labels, buffer labels, future picker UI). Keep this file pure: input is a
// Phaser Graphics + numeric coords, output is strokes/fills on the gfx.

// Axis-aligned form rendering, sized to fit a circumscribed circle of `r`.
// Square: side = r * 1.7 (matches BufferLabelRenderer.drawForm). Triangle:
// equilateral, point-up, height ≈ 2r (visual parity with the label). Caller
// sets fillStyle and lineStyle before the call.
//
// Used by ShapeRenderer's electrocute/acid Graphics overlays and by atlas.js
// to bake the shape glyph atlas. Keeping this in shapes.js (the primitives
// hub) avoids a circular import between ShapeRenderer and atlas.
export function drawShapeForm(gfx, r, form) {
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      gfx.fillRect(-s / 2, -s / 2, s, s);
      gfx.strokeRect(-s / 2, -s / 2, s, s);
      return;
    }
    case 'triangle': {
      const h = r * 2;
      const halfBase = r * 1.05;
      gfx.beginPath();
      gfx.moveTo(0,            -h * 0.6);
      gfx.lineTo(-halfBase,     h * 0.4);
      gfx.lineTo( halfBase,     h * 0.4);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      return;
    }
    case 'circle':
    default: {
      gfx.fillCircle(0, 0, r);
      gfx.strokeCircle(0, 0, r);
    }
  }
}

// Asymmetric blob used as the glyph for color-only labels — reads as a
// paint splash rather than a circle, so the player can tell at a glance
// "this label is a color wildcard". Built from 8 hand-picked vertices
// with radii varying in [0.55, 1.35]·r; the irregular profile (and two
// protrusions that land off the horizontal axis) makes the silhouette
// unmistakably non-circular even at small sizes.
//
// Caller sets `fillStyle` and `lineStyle` before the call.
export function drawPuddle(gfx, cx, cy, r) {
  // 8 vertices, angles chosen unevenly and radii varied on purpose. Two
  // "arms" (upper-left and upper-right) stick out farther than the bulk
  // of the blob; the bottom has a single pointed drip.
  const V = (ang, rad) => [cx + Math.cos(ang) * r * rad, cy + Math.sin(ang) * r * rad];
  const TAU = Math.PI * 2;
  const pts = [
    V(TAU * 0.04, 1.05),   // right, slightly above the horizontal
    V(TAU * 0.12, 1.35),   // upper-right arm — extends out
    V(TAU * 0.23, 0.60),   // dip between the two upper arms
    V(TAU * 0.36, 1.25),   // lower-right lobe, but above bottom tip
    V(TAU * 0.50, 1.30),   // bottom drip (pointed)
    V(TAU * 0.62, 0.70),   // dip before lower-left
    V(TAU * 0.78, 1.20),   // lower-left lobe
    V(TAU * 0.92, 0.75),   // tuck on the left side
  ];

  const N = pts.length;
  const steps = 10;

  gfx.beginPath();
  let [px, py] = midpoint(pts[N - 1], pts[0]);
  gfx.moveTo(px, py);
  for (let i = 0; i < N; i++) {
    const ctrl = pts[i];
    const next = pts[(i + 1) % N];
    const [ex, ey] = midpoint(ctrl, next);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const x = u * u * px + 2 * u * t * ctrl[0] + t * t * ex;
      const y = u * u * py + 2 * u * t * ctrl[1] + t * t * ey;
      gfx.lineTo(x, y);
    }
    px = ex; py = ey;
  }
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
}

function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
