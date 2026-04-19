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

function toCssColor(c) {
  return '#' + c.toString(16).padStart(6, '0');
}
