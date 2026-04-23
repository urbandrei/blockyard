// Render a shareable 1080x1920 PNG summarizing a level. Used by
// ExportPanel's Social Share button. Output dimension is the
// widely-supported portrait ceiling (Instagram Stories, TikTok feed,
// Reels, etc.). The render is deliberately a simplified card — not a
// pixel-for-pixel reproduction of the in-game scene — since re-using
// Phaser's renderers off-screen adds substantial complexity. The shape
// palette, border/interior colors, and layout are all keyed to match
// the game so a viewer still reads "this is a Blockyard level" at a
// glance.
//
// Returns a Promise<Blob> (PNG). The caller hands the blob to
// navigator.share({ files: [new File([blob], 'level.png', { type: 'image/png' })], ... }).

const WIDTH  = 1080;
const HEIGHT = 1920;

const BG_TOP       = '#0f1622';   // deep navy
const BG_BOTTOM    = '#17253b';   // slightly lighter navy
const ACCENT       = '#f5b400';
const LIGHT        = '#e6edf5';
const DIM          = '#9aa6b2';

const INTERIOR_COLOR = '#ffd9b5';   // peach floor
const BUFFER_COLOR   = '#6b4423';   // brown border
const INPUT_GREEN    = '#4caf50';
const INPUT_RED      = '#d94c4c';
const INPUT_BLUE     = '#3e8ed0';

const COLOR_HEX = { red: INPUT_RED, green: INPUT_GREEN, blue: INPUT_BLUE };

export async function generateShareImage(level, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  drawBackground(ctx);
  drawTitle(ctx);
  drawLevelMeta(ctx, level);
  drawBoard(ctx, level);
  drawFooter(ctx, opts.url || 'www.block-yard.com');

  return await canvasToBlob(canvas, 'image/png');
}

function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawTitle(ctx) {
  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 96px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BLOCKYARD', WIDTH / 2, 140);

  ctx.fillStyle = DIM;
  ctx.font = '32px system-ui, -apple-system, sans-serif';
  ctx.fillText('A puzzle playground', WIDTH / 2, 210);
}

function drawLevelMeta(ctx, level) {
  const name = level.name || 'untitled';
  ctx.fillStyle = LIGHT;
  ctx.font = 'bold 64px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  wrapText(ctx, name, WIDTH / 2, 310, WIDTH - 160, 72);

  if (level.author) {
    ctx.fillStyle = DIM;
    ctx.font = '38px system-ui, -apple-system, sans-serif';
    ctx.fillText(`by ${level.author}`, WIDTH / 2, 400);
  }

  const hint = (level.instructionalText || '').trim();
  if (hint) {
    ctx.fillStyle = LIGHT;
    ctx.font = 'italic 32px system-ui, -apple-system, sans-serif';
    wrapText(ctx, `"${hint}"`, WIDTH / 2, 460, WIDTH - 200, 42);
  }
}

// Draw the board area centered in the middle of the card. Includes a
// 1-cell buffer ring (brown) with input/output funnels colored per
// their shape type, a peach interior, and colored dots marking initial
// factory positions. Coordinates mirror the game's (cols+2) × (rows+2)
// buffered grid.
function drawBoard(ctx, level) {
  const cols = Number(level?.board?.cols) || 9;
  const rows = Number(level?.board?.rows) || 9;
  const totalCols = cols + 2;   // +2 for buffer ring
  const totalRows = rows + 2;

  // Fit an 880x880 square in the middle of the card. Cell size ceiling
  // keeps it crisp for pretty much every practical cols/rows.
  const maxDim = 880;
  const cell = Math.floor(maxDim / Math.max(totalCols, totalRows));
  const boardW = cell * totalCols;
  const boardH = cell * totalRows;
  const boardX = Math.floor((WIDTH - boardW) / 2);
  const boardY = 580;

  // Buffer ring (brown) — filled behind everything else.
  ctx.fillStyle = BUFFER_COLOR;
  ctx.fillRect(boardX, boardY, boardW, boardH);

  // Interior floor (peach).
  ctx.fillStyle = INTERIOR_COLOR;
  ctx.fillRect(boardX + cell, boardY + cell, cell * cols, cell * rows);

  // Funnels on the border — paint the cell in the shape's color and draw
  // a small triangle pointing into the play area so input/output read as
  // direction arrows.
  const inputs  = Array.isArray(level.inputs)  ? level.inputs  : [];
  const outputs = Array.isArray(level.outputs) ? level.outputs : [];
  for (const f of inputs)  drawFunnelCell(ctx, f, cols, rows, boardX, boardY, cell, 'input');
  for (const f of outputs) drawFunnelCell(ctx, f, cols, rows, boardX, boardY, cell, 'output');

  // Grid lines inside the interior to hint at the game's cell grid.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.lineWidth = 2;
  for (let c = 1; c <= cols - 1; c++) {
    const x = boardX + cell * (c + 1);
    ctx.beginPath();
    ctx.moveTo(x, boardY + cell);
    ctx.lineTo(x, boardY + cell + cell * rows);
    ctx.stroke();
  }
  for (let r = 1; r <= rows - 1; r++) {
    const y = boardY + cell * (r + 1);
    ctx.beginPath();
    ctx.moveTo(boardX + cell, y);
    ctx.lineTo(boardX + cell + cell * cols, y);
    ctx.stroke();
  }

  // Initial factories — colored squares in the interior at their anchor
  // cells. Not geometrically perfect (ignores cell shape / rotation) but
  // enough to convey "something is here".
  const factories = Array.isArray(level.initialFactories) ? level.initialFactories : [];
  for (const f of factories) {
    const anchor = f.slot || f.anchor;
    if (!anchor) continue;
    const r = Number(anchor.row);
    const c = Number(anchor.col);
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    const x = boardX + cell * (c + 1);
    const y = boardY + cell * (r + 1);
    ctx.fillStyle = 'rgba(30, 40, 60, 0.7)';
    ctx.fillRect(x + 3, y + 3, cell - 6, cell - 6);
  }
}

function drawFunnelCell(ctx, funnel, cols, rows, boardX, boardY, cell, role) {
  const type = funnel.type || {};
  const color = COLOR_HEX[type.color] || INPUT_BLUE;
  // The funnel's r/c are in play-area coords; `side` identifies which
  // edge of the buffer ring it sits on. Map into the full buffered grid.
  let gridC = null, gridR = null;
  if (funnel.side === 'top')    { gridC = funnel.c + 1; gridR = 0; }
  if (funnel.side === 'bottom') { gridC = funnel.c + 1; gridR = rows + 1; }
  if (funnel.side === 'left')   { gridR = funnel.r + 1; gridC = 0; }
  if (funnel.side === 'right')  { gridR = funnel.r + 1; gridC = cols + 1; }
  if (gridC == null || gridR == null) return;

  const x = boardX + gridC * cell;
  const y = boardY + gridR * cell;

  ctx.fillStyle = color;
  ctx.fillRect(x + 4, y + 4, cell - 8, cell - 8);

  // Triangle pointing into / out of the play area marks direction.
  ctx.fillStyle = role === 'input' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  const cx = x + cell / 2;
  const cy = y + cell / 2;
  const t = cell * 0.22;
  if (funnel.side === 'top')    { ctx.moveTo(cx, cy + t); ctx.lineTo(cx - t, cy - t); ctx.lineTo(cx + t, cy - t); }
  if (funnel.side === 'bottom') { ctx.moveTo(cx, cy - t); ctx.lineTo(cx - t, cy + t); ctx.lineTo(cx + t, cy + t); }
  if (funnel.side === 'left')   { ctx.moveTo(cx + t, cy); ctx.lineTo(cx - t, cy - t); ctx.lineTo(cx - t, cy + t); }
  if (funnel.side === 'right')  { ctx.moveTo(cx - t, cy); ctx.lineTo(cx + t, cy - t); ctx.lineTo(cx + t, cy + t); }
  ctx.closePath();
  ctx.fill();
}

function drawFooter(ctx, url) {
  ctx.fillStyle = LIGHT;
  ctx.font = 'bold 42px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('play at', WIDTH / 2, HEIGHT - 160);

  ctx.fillStyle = ACCENT;
  ctx.font = 'bold 56px system-ui, -apple-system, sans-serif';
  ctx.fillText(url, WIDTH / 2, HEIGHT - 100);
}

function wrapText(ctx, text, cx, cy, maxWidth, lineHeight) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const startY = cy - (lineHeight * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, startY + i * lineHeight);
  }
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => resolve(b), type);
    } else {
      // Old Safari fallback — build blob from dataURL.
      try {
        const dataUrl = canvas.toDataURL(type);
        const binary = atob(dataUrl.split(',')[1]);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        resolve(new Blob([arr], { type }));
      } catch (e) { resolve(null); }
    }
  });
}
