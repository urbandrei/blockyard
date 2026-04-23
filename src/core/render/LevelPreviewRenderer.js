// Offscreen renderer that produces a faithful snapshot of what the board
// looks like when a player first opens the level. Reuses the same
// renderer modules PlayerScene calls during _renderAll +  _renderBlueprint
// — interior floor, border funnels, locked factories (with flow dashes),
// exterior brown cut-out, frame shadow/outline, buffer labels, blueprint
// frame + dotted slot grid + hint pill + initial factories.
//
// Captured via Phaser RenderTexture. The tree is parked far off-screen
// so the main camera never draws it during the one frame between
// rt.draw and rt.snapshot — we leave visible=true because RT.draw
// respects the visible flag.

import { renderBorder } from './BorderRenderer.js';
import {
  renderInteriorFloor, renderExteriorCheckers,
  renderFrameShadow, renderFrameOutline,
} from './PlayAreaFrame.js';
import { renderBufferLabels } from './BufferLabelRenderer.js';
import { renderFactoryBody } from './FactoryBodyRenderer.js';
import { renderFunnels } from './FunnelRenderer.js';
import {
  normalizeFactory, rotateFactoryShape, isObstacleFactory,
} from '../model/shape.js';
import {
  BOARD_GAP, SHAPE_SCALE,
  BLUEPRINT_BG, BLUEPRINT_DOT, BLUEPRINT_STROKE,
} from '../constants.js';

const VIEWPORT_W = 720;
const VIEWPORT_H = 1080;

const BLUEPRINT_PAD    = 10;
const BLUEPRINT_RADIUS = 12;
const DOT_SPACING      = 6;

/**
 * Render `level`'s initial state to an HTMLImageElement.
 * @param {Phaser.Scene} scene  — any active scene to host offscreen containers + the RT
 * @param {object} level        — must have `board`; border / lockedFactories / initialFactories optional
 * @returns {Promise<HTMLImageElement>}
 */
export function renderLevelPreview(scene, level) {
  return new Promise((resolve, reject) => {
    const owned = [];
    const track = (obj) => { owned.push(obj); return obj; };

    try {
      const layout = computeLayout(level);
      const { pxCell, boardOriginX, boardOriginY } = layout;

      // Root is parked far off-screen. visible=true is required so
      // RenderTexture.draw pulls from the display list.
      const HIDE = -50000;
      const root = track(scene.add.container(HIDE, HIDE));

      // Sub-containers. Order of `add` below is back-to-front per the
      // game's depth stack in CLAUDE.md:
      //   boardContainer (0) → flow (5) → funnels (15) → interactive (20)
      //   → exteriorCheckers (25) → frameShadow (140) → borderFunnels (145)
      //   → bufferLabels (150) → frameOutline (160)
      const boardContainer        = scene.add.container(boardOriginX, boardOriginY);
      const funnelContainer       = scene.add.container(boardOriginX, boardOriginY);
      const interactiveContainer  = scene.add.container(boardOriginX, boardOriginY);
      const exteriorContainer     = scene.add.container(boardOriginX, boardOriginY);
      const shadowContainer       = scene.add.container(boardOriginX, boardOriginY);
      const borderFunnelContainer = scene.add.container(boardOriginX, boardOriginY);
      const labelContainer        = scene.add.container(boardOriginX, boardOriginY);
      const frameContainer        = scene.add.container(boardOriginX, boardOriginY);
      const blueprintContainer    = scene.add.container(layout.blueprintOriginX, layout.blueprintOriginY);

      root.add([
        boardContainer,
        funnelContainer,
        interactiveContainer,
        exteriorContainer,
        shadowContainer,
        borderFunnelContainer,
        labelContainer,
        frameContainer,
        blueprintContainer,
      ]);

      // --- Board area ---
      renderInteriorFloor(scene, boardContainer, { board: level.board, pxCell });
      renderBorder(scene, boardContainer, borderFunnelContainer, level, { pxCell, pxGap: BOARD_GAP });

      // Locked factories — bodies + funnels. Flow dashes are intentionally
      // omitted for the share image so the output is a clean static card
      // (dashes only make sense while the sim is running).
      for (const lf of (level.lockedFactories || [])) {
        drawFactoryInto(scene, lf, {
          interactiveContainer, funnelContainer, pxCell,
        });
      }

      renderExteriorCheckers(scene, exteriorContainer, {
        board: level.board, pxCell, boardOriginX, boardOriginY,
      });
      renderFrameShadow(scene, shadowContainer, { board: level.board, pxCell });
      renderFrameOutline(scene, frameContainer, { board: level.board, pxCell });
      renderBufferLabels(scene, labelContainer, level, { pxCell, pxGap: BOARD_GAP });

      // --- Blueprint area (no flow dashes) ---
      renderBlueprintPreview(scene, blueprintContainer, level, layout);

      const rt = track(scene.add.renderTexture(-50000, -50000, VIEWPORT_W, VIEWPORT_H));
      rt.setVisible(false);
      rt.fill(BLUEPRINT_BG, 1);
      // rt.draw(root, 0, 0) temporarily moves root to origin — its
      // children's local positions then place everything correctly on
      // the RT. Phaser restores root's position after the draw.
      rt.draw(root, 0, 0);

      rt.snapshot((image) => {
        cleanup(owned);
        if (!image) { reject(new Error('renderTexture.snapshot returned no image')); return; }
        resolve(image);
      });
    } catch (err) {
      cleanup(owned);
      reject(err);
    }
  });
}

function cleanup(owned) {
  for (const obj of owned) {
    try { obj.destroy && obj.destroy(true); } catch (e) {}
  }
}

// Simplified PlayerScene._layoutBoardAndBlueprint — no title-bar / icon
// island slots, since the preview omits both. Blueprint outer size is
// reference-based (REF_DIM=5) so it stays stable across levels, but the
// slot grid count comes from the actual board: slotCols = board.cols - 1.
// slotPx then shrinks inside the fixed outer so factories at the top-
// right slots of a 9x9 board don't overflow past the blueprint frame.
function computeLayout(level) {
  const board = level.board || { cols: 9, rows: 9 };
  const topPad = 24;
  const betweenPad = 8;
  const bottomPad = 24;
  const sidePad = 16;

  const REF_DIM = 5;
  const refSlotCols = (REF_DIM - 2) + 1;
  const refSlotRows = (REF_DIM - 2) + 1;
  const slotCols = Math.max(1, (board.cols - 2) + 1);
  const slotRows = Math.max(1, (board.rows - 2) + 1);

  const availW = VIEWPORT_W - sidePad * 2;
  const wFromBoard     = (availW - BOARD_GAP * (board.cols - 1)) / board.cols;
  const wFromBlueprint = availW / refSlotCols;
  const availH = VIEWPORT_H - topPad - betweenPad - bottomPad - BLUEPRINT_PAD * 2;
  const hCellFactor = board.rows + refSlotRows;
  const hFromVert = (availH - BOARD_GAP * (board.rows - 1)) / hCellFactor;
  const pxCell = Math.max(24, Math.floor(Math.min(wFromBoard, wFromBlueprint, hFromVert)));

  const boardW = board.cols * pxCell + (board.cols - 1) * BOARD_GAP;
  const boardH = board.rows * pxCell + (board.rows - 1) * BOARD_GAP;
  const bpW = refSlotCols * pxCell;
  const bpH = refSlotRows * pxCell;
  const slotPx = Math.min(bpW / slotCols, bpH / slotRows);

  const boardOriginX = Math.round((VIEWPORT_W - boardW) / 2);
  const boardOriginY = topPad;
  const blueprintOriginX = Math.round((VIEWPORT_W - bpW) / 2);
  const blueprintOriginY = boardOriginY + boardH + betweenPad + BLUEPRINT_PAD;

  return {
    pxCell, board,
    boardW, boardH,
    bpW, bpH, slotCols, slotRows, slotPx,
    boardOriginX, boardOriginY,
    blueprintOriginX, blueprintOriginY,
  };
}

// Mirrors PlayerScene._drawFactory for a single locked factory, minus
// the flow dashes (static share image doesn't want moving path markers).
function drawFactoryInto(scene, factory, ctx) {
  const { interactiveContainer, funnelContainer, pxCell } = ctx;
  const norm = normalizeFactory(factory.cells, factory.funnels || []);
  const anchor = factory.anchor || { row: 0, col: 0 };
  const absCells = norm.cells.map((cc) => ({
    ...cc, r: anchor.row + cc.r, c: anchor.col + cc.c,
  }));
  const absFunnels = (norm.funnels || []).map((f) => ({
    ...f, r: anchor.row + f.r, c: anchor.col + f.c,
  }));
  const [cx, cy] = factoryCenter(absCells, pxCell, BOARD_GAP);

  const funnelWrap = scene.add.container(cx, cy);
  const bodyWrap   = scene.add.container(cx, cy);
  interactiveContainer.add(bodyWrap);
  funnelContainer.add(funnelWrap);

  const funnels = renderFunnels(scene, funnelWrap, absFunnels, {
    pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
  });
  funnels.setPosition(-cx, -cy);

  const body = renderFactoryBody(scene, bodyWrap, {
    cells: absCells, pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
    converter: factory.converter,
    caution: isObstacleFactory(absFunnels),
    rotation: factory.rotation || 0,
  });
  body.setPosition(-cx, -cy);
}

// Renders the blueprint composer frame + dotted slot grid + optional
// hint pill + initial-factory stacks.
function renderBlueprintPreview(scene, container, level, layout) {
  const { bpW, bpH, slotCols, slotRows, slotPx } = layout;
  const hint = typeof level.instructionalText === 'string' ? level.instructionalText.trim() : '';
  const reservedRow = hint ? 1 : 0;

  // Frame.
  const frame = scene.make.graphics({ add: false });
  frame.fillStyle(BLUEPRINT_BG, 1);
  frame.lineStyle(2, BLUEPRINT_STROKE, 1);
  frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD,
    bpW + BLUEPRINT_PAD * 2, bpH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
  frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD,
    bpW + BLUEPRINT_PAD * 2, bpH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
  container.add(frame);

  // Dotted slot grid — rows from `reservedRow` down to `slotRows`, both
  // horizontal and vertical edges so every slot reads as a cell.
  const dots = scene.make.graphics({ add: false });
  dots.fillStyle(BLUEPRINT_DOT, 0.9);
  for (let r = reservedRow; r <= slotRows; r++) {
    for (let c = 0; c <= slotCols; c++) {
      if (c < slotCols) {
        stampEdge(dots, c * slotPx, r * slotPx, (c + 1) * slotPx, r * slotPx, DOT_SPACING);
      }
      if (r < slotRows) {
        stampEdge(dots, c * slotPx, r * slotPx, c * slotPx, (r + 1) * slotPx, DOT_SPACING);
      }
    }
  }
  container.add(dots);

  // Hint pill across the reserved top row.
  if (hint) {
    const pad = Math.max(4, Math.round(slotPx * 0.12));
    const pillW = bpW - pad * 2;
    const pillH = slotPx - pad * 2;
    const pill = scene.make.graphics({ add: false });
    pill.fillStyle(0xffffff, 1);
    pill.lineStyle(2, 0x1a2332, 1);
    const radius = Math.max(6, Math.round(pillH * 0.25));
    pill.fillRoundedRect(pad, pad, pillW, pillH, radius);
    pill.strokeRoundedRect(pad, pad, pillW, pillH, radius);
    container.add(pill);

    const fontPx = Math.max(11, Math.min(20, Math.floor(pillH * 0.50)));
    const text = scene.add.text(bpW / 2, slotPx / 2, hint, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${fontPx}px`,
      fontStyle: 'bold',
      color: '#1a2332',
      align: 'center',
      wordWrap: { width: pillW - pad * 2 },
    }).setOrigin(0.5);
    container.add(text);
  }

  // Factory stacks per slot.
  const stacks = new Map();
  for (const it of (level.initialFactories || [])) {
    if (!it.slot) continue;
    const key = `${it.slot.row},${it.slot.col}`;
    let stack = stacks.get(key);
    if (!stack) { stack = []; stacks.set(key, stack); }
    stack.push(it);
  }

  for (const [key, stack] of stacks) {
    const [sr, sc] = key.split(',').map(Number);
    const top = stack[stack.length - 1];
    drawBlueprintFactoryInto(scene, container, top, {
      slot: { r: sr, c: sc }, slotPx,
    });
  }
}

// Mirrors PlayerScene._drawBlueprintFactory — the factory body renders at
// its slot's top-left in blueprint-local coords, sized to slotPx.
// Normalize first (the authored cells may start at arbitrary offsets),
// then rotate; rotateFactoryShape normalizes again internally.
function drawBlueprintFactoryInto(scene, container, def, { slot, slotPx }) {
  const norm = normalizeFactory(def.cells, def.funnels || []);
  const rot = rotateFactoryShape(
    { cells: norm.cells, funnels: norm.funnels },
    def.rotation || 0,
  );
  const cellsLocal = rot.cells.map((c) => ({ ...c }));
  const funnelsLocal = rot.funnels.map((f) => ({ ...f }));
  const [cx, cy] = factoryCenter(cellsLocal, slotPx, 0);
  const ox = slot.c * slotPx;
  const oy = slot.r * slotPx;

  const funnelWrap = scene.add.container(ox + cx, oy + cy);
  const bodyWrap   = scene.add.container(ox + cx, oy + cy);
  container.add(funnelWrap);
  container.add(bodyWrap);

  const funnels = renderFunnels(scene, funnelWrap, funnelsLocal, {
    pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
  });
  funnels.setPosition(-cx, -cy);

  const body = renderFactoryBody(scene, bodyWrap, {
    cells: cellsLocal, pxCell: slotPx, pxGap: 0, scale: SHAPE_SCALE,
    converter: def.converter,
    caution: isObstacleFactory(funnelsLocal),
    rotation: def.rotation || 0,
  });
  body.setPosition(-cx, -cy);
}

// Copy of HomeScene's local factoryCenter — not exported there, so we
// inline to avoid widening the module's surface.
function factoryCenter(cells, pxCell, pxGap) {
  if (!cells || cells.length === 0) return [0, 0];
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const { r, c } of cells) {
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (c < minC) minC = c; if (c > maxC) maxC = c;
  }
  const step = pxCell + pxGap;
  return [
    ((minC + maxC) * step + pxCell) / 2,
    ((minR + maxR) * step + pxCell) / 2,
  ];
}

// PlayerScene's local helper — dotted line between (x1,y1) and (x2,y2).
function stampEdge(gfx, x1, y1, x2, y2, spacing) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    gfx.fillCircle(x1 + dx * t, y1 + dy * t, 1.3);
  }
}

export { VIEWPORT_W as PREVIEW_WIDTH, VIEWPORT_H as PREVIEW_HEIGHT };
