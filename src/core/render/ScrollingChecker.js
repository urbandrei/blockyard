// Tiled brown checker background used on menu scenes. Optionally scrolls
// diagonally so the page feels alive while a player is deciding where to
// go. Matches the exterior-checker palette (BUFFER_FILL / BUFFER_FILL_ALT)
// used in-game so the transition into the editor/player feels continuous.
//
// Usage:
//   this.bg = new ScrollingChecker(this, { scroll: true });
//   // in scene update:
//   update(time, delta) { this.bg.update(delta); }
//   // shutdown handled automatically via scene events.

import { BUFFER_FILL, BUFFER_FILL_ALT } from '../constants.js';

const DEFAULT_TILE    = 48;      // logical-canvas px
const DEFAULT_SCROLL  = 18;      // px / second
const BG_DEPTH        = -10000;  // well below any scene content

export class ScrollingChecker {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} [opts]
   * @param {number}  [opts.tile=48]      tile size in logical px
   * @param {boolean} [opts.scroll=false] animate the pattern diagonally
   * @param {number}  [opts.scrollPx=18]  scroll velocity in logical px/sec
   * @param {number}  [opts.dirX=1]       scroll direction sign (x)
   * @param {number}  [opts.dirY=1]       scroll direction sign (y)
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.tile = opts.tile || DEFAULT_TILE;
    this.scroll = !!opts.scroll;
    this.scrollPx = opts.scrollPx != null ? opts.scrollPx : DEFAULT_SCROLL;
    this.dirX = opts.dirX == null ? 1 : opts.dirX;
    this.dirY = opts.dirY == null ? 1 : opts.dirY;
    this.offsetX = 0;
    this.offsetY = 0;
    this._build();
    scene.events.once('shutdown', () => this.destroy());
    scene.events.once('destroy',  () => this.destroy());
  }

  _build() {
    const sw = this.scene.scale.width;
    const sh = this.scene.scale.height;
    // Oversized canvas so the pattern always extends past every edge, even
    // after a full scroll cycle has shifted it by 2× tile.
    const pad = this.tile * 2;
    const totalW = sw + pad * 2;
    const totalH = sh + pad * 2;

    const gfx = this.scene.make.graphics({ add: false });
    const cols = Math.ceil(totalW / this.tile) + 1;
    const rows = Math.ceil(totalH / this.tile) + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const parity = (r + c) & 1;
        gfx.fillStyle(parity ? BUFFER_FILL_ALT : BUFFER_FILL, 1);
        gfx.fillRect(c * this.tile, r * this.tile, this.tile, this.tile);
      }
    }
    gfx.setDepth(BG_DEPTH);
    gfx.x = -pad;
    gfx.y = -pad;
    this.scene.add.existing(gfx);
    this.gfx = gfx;
    this._basePad = pad;
  }

  update(delta) {
    if (!this.scroll || !this.gfx) return;
    // Move along (dirX, dirY); wrap by 2× tile so the checker parity stays
    // continuous across the seam.
    const step = (this.scrollPx * (delta || 16)) / 1000;
    const period = this.tile * 2;
    this.offsetX = (this.offsetX + step * this.dirX) % period;
    this.offsetY = (this.offsetY + step * this.dirY) % period;
    if (this.offsetX < 0) this.offsetX += period;
    if (this.offsetY < 0) this.offsetY += period;
    this.gfx.x = -this._basePad + this.offsetX;
    this.gfx.y = -this._basePad + this.offsetY;
  }

  destroy() {
    if (this.gfx) { this.gfx.destroy(); this.gfx = null; }
  }
}
