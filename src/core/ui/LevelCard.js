// One row in the Community search list. Layout, left→right:
//
//   [name / author]  ............  [stars] [LIKE] [SHARE] [PLAY] [⋮ MORE]
//   [status chip]
//
// The right-side stack is built right→left so optional elements just fall
// out of the layout when absent:
//
//   MORE     ⋮ — present when opts.moreItems has entries; caller builds
//                the items list, LevelCard fires opts.onMore(worldX, worldY)
//                so the scene can open a dropdown at the right spot.
//   PLAY     the big blue pill; always visible for playable levels.
//   SHARE    3-node web-share glyph; always visible for remote levels.
//   LIKE     heart circle; fires opts.onToggleLike.
//   STARS    display-only, reflects ratingAvg/ratingCount on the level.

import { drawShareNet, drawKebab } from './Icons.js';

const STATUS_PALETTE = {
  unfinished: { fill: 0xe0a800, label: 'unfinished' },
  private:    { fill: 0x9aa6b2, label: 'private'    },
  pending:    { fill: 0xff8a3a, label: 'pending'    },
  public:     { fill: 0x4caf50, label: 'public'     },
  imported:   { fill: 0x3b66b8, label: 'imported'   },
};

const BTN_H     = 36;
const BTN_GAP   = 8;
const CIRCLE_R  = 16;
const EDGE_PAD  = 16;
const PLAY_W    = 80;
const MORE_W    = 28;
const STAR_SIZE = 18;
const STAR_GAP  = 2;
const STAR_ACTIVE = '#f5b400';
const STAR_IDLE   = '#42506a';
const STAR_FILLED = '\u2605';
const STAR_EMPTY  = '\u2606';

export class LevelCard {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x / opts.y              center of the card
   * @param {number} opts.width / opts.height
   * @param {object} opts.level
   * @param {boolean} opts.liked
   * @param {() => void} opts.onPlay
   * @param {() => void} [opts.onToggleLike]
   * @param {() => void} [opts.onNativeShare]     three-node share button
   * @param {Array<{label:string,onTap:()=>void,destructive?:boolean}>} [opts.moreItems]
   *        Filtered, in-order list of actions to put in the ⋮ dropdown.
   * @param {(anchorX:number, anchorY:number) => void} [opts.onMore]
   *        Fired when the ⋮ is tapped. Scene renders the dropdown.
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this._liked = !!opts.liked;
    this._pillButtons = [];
    this._circles = [];
    this._stars = [];
    this._build();
  }

  _build() {
    const { x, y, width, height, level } = this.opts;
    const sx = x - width / 2;
    const sy = y - height / 2;

    this.bg = this.scene.add.rectangle(x, y, width, height, 0x223047, 1)
      .setStrokeStyle(2, 0x3a5a88, 1);

    this.name = this.scene.add.text(sx + EDGE_PAD, sy + 12, level.name || 'untitled', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0, 0);

    const authorStr = level.author ? `by ${level.author}` : 'anonymous';
    this.meta = this.scene.add.text(sx + EDGE_PAD, sy + 38, authorStr, {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#9aa6b2',
    }).setOrigin(0, 0);

    // Status chip (bottom-left).
    const status = STATUS_PALETTE[level.status] || STATUS_PALETTE.private;
    const chipW = 80, chipH = 22;
    const chipCX = sx + EDGE_PAD + chipW / 2;
    const chipCY = sy + height - chipH / 2 - 12;
    this.chip = this.scene.add.rectangle(chipCX, chipCY, chipW, chipH, status.fill, 1)
      .setStrokeStyle(1, 0x1a2332, 1);
    this.chipText = this.scene.add.text(chipCX, chipCY, status.label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);

    // ---- right-aligned button stack (right → left cursor) ----
    const rowY = y;
    const playable = level.status !== 'unfinished';
    const isRemote = level.origin === 'remote';
    const moreItems = Array.isArray(this.opts.moreItems) ? this.opts.moreItems : [];
    let cursor = sx + width - EDGE_PAD;

    // ⋮ MORE (rightmost when present)
    if (moreItems.length > 0 && this.opts.onMore) {
      const cx = cursor - MORE_W / 2;
      this._addMoreButton(cx, rowY);
      cursor -= MORE_W + BTN_GAP;
    }

    // PLAY
    if (playable) {
      const cx = cursor - PLAY_W / 2;
      this._addPill(cx, rowY, PLAY_W, BTN_H, 'PLAY',
        0x3b66b8, 0x4a76c8, '#ffffff', '14px',
        () => this.opts.onPlay && this.opts.onPlay(),
        { asPlay: true });
      cursor -= PLAY_W + BTN_GAP;
    }

    // SHARE (native) — three-node glyph
    if (this.opts.onNativeShare) {
      const cx = cursor - CIRCLE_R;
      this._addShareCircle(cx, rowY);
      cursor -= CIRCLE_R * 2 + 6;
    }

    // LIKE
    if (this.opts.onToggleLike) {
      const cx = cursor - CIRCLE_R;
      this._addLikeCircle(cx, rowY);
      cursor -= CIRCLE_R * 2 + 6;
    }

    // Rating stars (display-only) — sit just left of LIKE.
    if (isRemote) {
      const widthStars = STAR_SIZE * 5 + STAR_GAP * 4;
      const cursorRightEdge = cursor;
      const startX = cursorRightEdge - widthStars + STAR_SIZE / 2;
      this._addRatingStars(startX, rowY, level);
      cursor = cursorRightEdge - widthStars - 8;
    }
  }

  _addPill(cx, cy, w, h, label, fill, hoverFill, textColor, fontSize, onTap, meta = {}) {
    const rect = this.scene.add.rectangle(cx, cy, w, h, fill, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    const text = this.scene.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize, fontStyle: 'bold',
      color: textColor,
    }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(hoverFill, 1));
    rect.on('pointerout',  () => rect.setFillStyle(fill, 1));
    rect.on('pointerup', () => onTap && onTap());
    this._pillButtons.push({ rect, text });
    if (meta.asPlay) { this.playBg = rect; this.playText = text; }
    return { rect, text };
  }

  _addLikeCircle(cx, cy) {
    const bg = this.scene.add.circle(cx, cy, CIRCLE_R, this._liked ? 0xd94c4c : 0x2a3b55, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    const glyph = this.scene.add.text(cx, cy, '\u2665', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px',
      color: this._liked ? '#ffffff' : '#9aa6b2',
    }).setOrigin(0.5);
    bg.on('pointerup', async () => {
      const next = await this.opts.onToggleLike();
      this._setLiked(!!next);
    });
    this.likeBg = bg;
    this.likeGlyph = glyph;
    this._circles.push(bg, glyph);
  }

  // Native share — circle with the three-node web-share glyph drawn via
  // Phaser Graphics (not a text glyph, since emoji share variants render
  // inconsistently across platforms).
  _addShareCircle(cx, cy) {
    const bg = this.scene.add.circle(cx, cy, CIRCLE_R, 0x2a3b55, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    const gfx = this.scene.add.graphics();
    drawShareNet(gfx, cx, cy, CIRCLE_R * 1.3, 0xe6edf5);
    bg.on('pointerover', () => bg.setFillStyle(0x3a4d6f, 1));
    bg.on('pointerout',  () => bg.setFillStyle(0x2a3b55, 1));
    bg.on('pointerup', () => this.opts.onNativeShare && this.opts.onNativeShare());
    this.shareBg = bg;
    this.shareGlyphGfx = gfx;
    this._circles.push(bg, gfx);
  }

  _addMoreButton(cx, cy) {
    const bg = this.scene.add.rectangle(cx, cy, MORE_W, BTN_H, 0x2a3b55, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    const gfx = this.scene.add.graphics();
    drawKebab(gfx, cx, cy, BTN_H * 0.7, 0xe6edf5);
    bg.on('pointerover', () => bg.setFillStyle(0x3a4d6f, 1));
    bg.on('pointerout',  () => bg.setFillStyle(0x2a3b55, 1));
    bg.on('pointerup', () => {
      // World transform handles the scroll container's y offset, so the
      // scene can anchor its dropdown at the screen-space position.
      const m = bg.getWorldTransformMatrix();
      this.opts.onMore && this.opts.onMore(m.tx, m.ty);
    });
    this.moreBg = bg;
    this.moreGlyphGfx = gfx;
    this._circles.push(bg, gfx);
  }

  _addRatingStars(startX, cy, level) {
    const count = Number(level.ratingCount) || 0;
    const avg   = Number(level.ratingAvg)   || 0;
    // Rounded half-up to integer — the scene's filter bucketing (r1..r5)
    // already rounds up, so using the rounded value here keeps the visual
    // consistent with what the filter labels promise.
    const lit = count > 0 ? Math.round(avg) : 0;
    for (let i = 0; i < 5; i++) {
      const filled = i < lit;
      const s = this.scene.add.text(startX + i * (STAR_SIZE + STAR_GAP), cy,
        filled ? STAR_FILLED : STAR_EMPTY, {
        fontFamily: 'system-ui, sans-serif', fontSize: `${STAR_SIZE}px`, fontStyle: 'bold',
        color: filled ? STAR_ACTIVE : STAR_IDLE,
      }).setOrigin(0.5);
      this._stars.push(s);
    }
    if (count > 0) {
      const tail = this.scene.add.text(startX + 5 * (STAR_SIZE + STAR_GAP) + 2,
        cy, `(${count})`, {
        fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#9aa6b2',
      }).setOrigin(0, 0.5);
      this._stars.push(tail);
    }
  }

  _setLiked(liked) {
    this._liked = liked;
    if (this.likeBg)    this.likeBg.setFillStyle(liked ? 0xd94c4c : 0x2a3b55, 1);
    if (this.likeGlyph) this.likeGlyph.setColor(liked ? '#ffffff' : '#9aa6b2');
  }

  destroy() {
    this.bg.destroy();
    this.name.destroy();
    this.meta.destroy();
    this.chip.destroy();
    this.chipText.destroy();
    for (const p of this._pillButtons) { p.rect.destroy(); p.text.destroy(); }
    for (const c of this._circles)     { c.destroy(); }
    for (const s of this._stars)       { s.destroy(); }
    this._pillButtons.length = 0;
    this._circles.length = 0;
    this._stars.length = 0;
  }

  static pieces(card) {
    const out = [card.bg, card.name, card.meta, card.chip, card.chipText];
    for (const p of card._pillButtons) { out.push(p.rect, p.text); }
    for (const c of card._circles)     { out.push(c); }
    for (const s of card._stars)       { out.push(s); }
    return out;
  }
}
