// Flat vector glyphs drawn with Phaser Graphics primitives. Every function
// paints its glyph into the passed `gfx` centered on `(cx, cy)` fitting a
// `size` × `size` bounding box. Caller sets lineStyle/fillStyle before the
// call OR passes a `color` — helpers honor `color` if provided and leave the
// gfx's current line/fill style otherwise.
//
// The glyphs are intentionally low-detail (2-3 primitives each) so they read
// clearly at any cell size the blueprint ends up using.

export function drawHome(gfx, cx, cy, size, color = 0xffffff) {
  const s = size;
  const half = s / 2;
  gfx.lineStyle(Math.max(2, Math.round(s * 0.08)), color, 1);
  gfx.fillStyle(color, 0);
  // Roof — triangle from left eave to right eave, peaked above center.
  gfx.beginPath();
  gfx.moveTo(cx - half * 0.9, cy - half * 0.05);
  gfx.lineTo(cx,               cy - half * 0.75);
  gfx.lineTo(cx + half * 0.9,  cy - half * 0.05);
  gfx.strokePath();
  // Body — rectangle below the roof.
  const bx = cx - half * 0.7;
  const by = cy - half * 0.05;
  const bw = half * 1.4;
  const bh = half * 0.85;
  gfx.strokeRect(bx, by, bw, bh);
  // Door notch — centered rectangle.
  const dw = bw * 0.28;
  const dh = bh * 0.55;
  gfx.strokeRect(cx - dw / 2, by + bh - dh, dw, dh);
}

export function drawBackChevron(gfx, cx, cy, size, color = 0xffffff) {
  const s = size;
  const half = s / 2;
  gfx.lineStyle(Math.max(2, Math.round(s * 0.12)), color, 1);
  gfx.beginPath();
  gfx.moveTo(cx + half * 0.4, cy - half * 0.6);
  gfx.lineTo(cx - half * 0.4, cy);
  gfx.lineTo(cx + half * 0.4, cy + half * 0.6);
  gfx.strokePath();
}

// Question mark is easier to render as a Text glyph than with primitives.
// Caller passes the scene so this helper can create a Phaser Text that sits
// on top of the stroked ring. Returns { ring, text } so callers can destroy.
export function drawQuestion(scene, container, cx, cy, size, color = 0xffffff) {
  const s = size;
  const half = s / 2;
  const ring = scene.make.graphics({ add: false });
  ring.lineStyle(Math.max(2, Math.round(s * 0.1)), color, 1);
  ring.strokeCircle(cx, cy, half * 0.9);
  container.add(ring);
  const text = scene.add.text(cx, cy + 1, '?', {
    fontFamily: 'system-ui, sans-serif',
    fontSize: `${Math.max(12, Math.round(s * 0.7))}px`,
    fontStyle: 'bold',
    color: toCssColor(color),
  }).setOrigin(0.5);
  container.add(text);
  return { ring, text };
}

export function drawPlus(gfx, cx, cy, size, color = 0xffffff) {
  const half = size / 2;
  const line = Math.max(2, Math.round(size * 0.14));
  const reach = half * 0.7;
  gfx.lineStyle(line, color, 1);
  gfx.beginPath();
  gfx.moveTo(cx - reach, cy);
  gfx.lineTo(cx + reach, cy);
  gfx.moveTo(cx, cy - reach);
  gfx.lineTo(cx, cy + reach);
  gfx.strokePath();
}

export function drawMinus(gfx, cx, cy, size, color = 0xffffff) {
  const half = size / 2;
  const line = Math.max(2, Math.round(size * 0.14));
  const reach = half * 0.7;
  gfx.lineStyle(line, color, 1);
  gfx.beginPath();
  gfx.moveTo(cx - reach, cy);
  gfx.lineTo(cx + reach, cy);
  gfx.strokePath();
}

export function drawTrash(gfx, cx, cy, size, color = 0xffffff) {
  const s = size;
  const half = s / 2;
  const line = Math.max(2, Math.round(s * 0.08));
  gfx.lineStyle(line, color, 1);
  // Handle: small rect on top.
  const hw = half * 0.55;
  const hh = half * 0.18;
  gfx.strokeRect(cx - hw / 2, cy - half * 0.85, hw, hh);
  // Lid: wider horizontal line.
  const lidW = half * 1.4;
  gfx.beginPath();
  gfx.moveTo(cx - lidW / 2, cy - half * 0.55);
  gfx.lineTo(cx + lidW / 2, cy - half * 0.55);
  gfx.strokePath();
  // Can body: tapered rect (we approximate with plain rect for simplicity).
  const bw = half * 1.1;
  const bh = half * 1.15;
  gfx.strokeRect(cx - bw / 2, cy - half * 0.4, bw, bh);
  // Three slots inside the can.
  const slotY1 = cy - half * 0.2;
  const slotY2 = cy + half * 0.65;
  for (const dx of [-bw * 0.28, 0, bw * 0.28]) {
    gfx.beginPath();
    gfx.moveTo(cx + dx, slotY1);
    gfx.lineTo(cx + dx, slotY2);
    gfx.strokePath();
  }
}

// 3×3 grid of filled squares. Used for the LEVEL SELECT button.
export function drawGrid(gfx, cx, cy, size, color = 0xffffff) {
  const s = size * 0.85;
  const cellW = s / 3;
  const gap = Math.max(1, cellW * 0.2);
  const inner = cellW - gap;
  gfx.fillStyle(color, 1);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = cx - s / 2 + c * cellW + gap / 2;
      const y = cy - s / 2 + r * cellW + gap / 2;
      gfx.fillRect(x, y, inner, inner);
    }
  }
}

// Circular arrow for RESET. 270° arc from 3 o'clock clockwise through 6, 9,
// 12; arrow at 12 o'clock pointing right so the glyph reads as a natural
// "this loops back around" motion. The arrow's base sits on the arc's
// endpoint so there's no visible gap between them.
export function drawCircleArrow(gfx, cx, cy, size, color = 0xffffff) {
  const r = size * 0.35;
  const stroke = Math.max(2, Math.round(size * 0.12));
  gfx.lineStyle(stroke, color, 1);
  // Sweep from angle 0 (3 o'clock) clockwise to 3π/2 (12 o'clock).
  gfx.beginPath();
  gfx.arc(cx, cy, r, 0, Math.PI * 1.5, false);
  gfx.strokePath();
  // Arrow at 12 o'clock. Base sits on the arc's endpoint; tip extends
  // to the right into the gap. Base is a vertical segment, tip is
  // horizontal — clean right-angled arrowhead.
  const tipBaseX = cx;
  const tipBaseY = cy - r;
  const ah = stroke * 2.6;
  const halfBase = ah * 0.78;
  gfx.fillStyle(color, 1);
  gfx.beginPath();
  gfx.moveTo(tipBaseX + ah,        tipBaseY);              // rightward tip
  gfx.lineTo(tipBaseX,             tipBaseY - halfBase);  // base top
  gfx.lineTo(tipBaseX,             tipBaseY + halfBase);  // base bottom
  gfx.closePath();
  gfx.fillPath();
}

// Canonical web-share icon: three nodes (top-right, middle-left,
// bottom-right) connected by two lines from the middle-left to each of
// the right-side nodes. Matches the Material/Android share glyph.
export function drawShareNet(gfx, cx, cy, size, color = 0xffffff) {
  const nodeR = Math.max(2, Math.round(size * 0.14));
  const line  = Math.max(2, Math.round(size * 0.09));
  const reach = size * 0.34;
  const top    = { x: cx + reach, y: cy - reach };
  const middle = { x: cx - reach, y: cy };
  const bottom = { x: cx + reach, y: cy + reach };

  gfx.lineStyle(line, color, 1);
  gfx.beginPath();
  gfx.moveTo(middle.x, middle.y);
  gfx.lineTo(top.x, top.y);
  gfx.strokePath();
  gfx.beginPath();
  gfx.moveTo(middle.x, middle.y);
  gfx.lineTo(bottom.x, bottom.y);
  gfx.strokePath();

  gfx.fillStyle(color, 1);
  for (const p of [top, middle, bottom]) {
    gfx.fillCircle(p.x, p.y, nodeR);
  }
}

// Three vertical dots — the standard "more actions" overflow glyph.
export function drawKebab(gfx, cx, cy, size, color = 0xffffff) {
  const r = Math.max(2, Math.round(size * 0.12));
  const spacing = size * 0.28;
  gfx.fillStyle(color, 1);
  gfx.fillCircle(cx, cy - spacing, r);
  gfx.fillCircle(cx, cy,            r);
  gfx.fillCircle(cx, cy + spacing, r);
}

// Sideways triangle for PLAY. Points right. Taller than wide so the glyph
// reads as a slim classic play icon rather than a chunky equilateral.
export function drawPlayTriangle(gfx, cx, cy, size, color = 0xffffff) {
  const h = size * 0.82;
  const halfH = h / 2;
  const halfW = halfH * 0.78;
  gfx.fillStyle(color, 1);
  gfx.beginPath();
  gfx.moveTo(cx - halfW, cy - halfH);
  gfx.lineTo(cx - halfW, cy + halfH);
  gfx.lineTo(cx + halfW, cy);
  gfx.closePath();
  gfx.fillPath();
}

function toCssColor(c) {
  return '#' + c.toString(16).padStart(6, '0');
}
