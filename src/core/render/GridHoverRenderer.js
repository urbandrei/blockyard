import { HOVER_GRID_COLOR, HOVER_GRID_RADIUS } from '../constants.js';

// Draws a dotted grid inside the playable interior (non-buffer cells) and
// fades the dots out as a soft circle around the pointer. The whole graphics
// gets cleared + redrawn every frame from the scene's `update()` loop.
//
// Usage from a scene:
//   this.gridHover = new GridHoverRenderer(this, this.boardContainer,
//                                          { board, pxCell, pxGap });
//   // each frame:
//   const p = this.input.activePointer;
//   this.gridHover.update(p.x - this.boardOriginX, p.y - this.boardOriginY);

const DOT_SPACING = 6;         // px between dots along an edge
const DOT_RADIUS  = 1.2;       // px

export class GridHoverRenderer {
  constructor(scene, container, { board, pxCell, pxGap }) {
    this.scene = scene;
    this.pxCell = pxCell;
    this.pxGap = pxGap;
    this.step = pxCell + pxGap;
    // Playable-interior cell bounds (rows/cols 1..n-2 for an n×n board; the
    // outer ring is buffer, not playable).
    this.rFrom = 1; this.rTo = board.rows - 2;
    this.cFrom = 1; this.cTo = board.cols - 2;
    this.gfx = scene.make.graphics({ add: false });
    container.add(this.gfx);
  }

  // pointerX / pointerY are in BOARD-LOCAL coordinates (subtract boardOrigin
  // before calling). Pass null to hide the grid entirely (e.g. when the
  // pointer leaves the scene).
  update(pointerX, pointerY) {
    const gfx = this.gfx;
    gfx.clear();
    if (pointerX == null || pointerY == null) return;
    const maxR = HOVER_GRID_RADIUS * this.step;
    const maxR2 = maxR * maxR;

    // Paint cell edges with per-dot alpha. We walk every interior cell within
    // the bounding square of the hover radius and stamp dots along its four
    // edges. Adjacent cells share edges so dots double up — acceptable at
    // this size and preserves clean corners.
    const startR = Math.max(this.rFrom, Math.floor(this.rFrom + (pointerY - maxR) / this.step));
    const endR   = Math.min(this.rTo,   Math.floor(this.rFrom + (pointerY + maxR) / this.step) + 1);
    const startC = Math.max(this.cFrom, Math.floor(this.cFrom + (pointerX - maxR) / this.step));
    const endC   = Math.min(this.cTo,   Math.floor(this.cFrom + (pointerX + maxR) / this.step) + 1);

    for (let r = startR; r <= endR; r++) {
      for (let c = startC; c <= endC; c++) {
        const x0 = c * this.step;
        const y0 = r * this.step;
        const x1 = x0 + this.pxCell;
        const y1 = y0 + this.pxCell;
        this._stampEdge(gfx, x0, y0, x1, y0, pointerX, pointerY, maxR2); // top
        this._stampEdge(gfx, x0, y1, x1, y1, pointerX, pointerY, maxR2); // bottom
        this._stampEdge(gfx, x0, y0, x0, y1, pointerX, pointerY, maxR2); // left
        this._stampEdge(gfx, x1, y0, x1, y1, pointerX, pointerY, maxR2); // right
      }
    }
  }

  destroy() { this.gfx.destroy(); }

  // Stamp dots along a single axis-aligned edge, each dot's alpha set from
  // its distance to the pointer.
  _stampEdge(gfx, x1, y1, x2, y2, px, py, maxR2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const stepN = Math.max(1, Math.round(len / DOT_SPACING));
    for (let i = 0; i <= stepN; i++) {
      const t = i / stepN;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      const ddx = x - px, ddy = y - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 >= maxR2) continue;
      const alpha = 1 - d2 / maxR2;    // quadratic-ish soft falloff
      gfx.fillStyle(HOVER_GRID_COLOR, alpha * 0.9);
      gfx.fillCircle(x, y, DOT_RADIUS);
    }
  }
}
