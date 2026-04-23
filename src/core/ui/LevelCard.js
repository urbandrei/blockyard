// One row in the Community search list. Renders the level's name, author,
// rating (for remote levels), status chip, and a right-aligned button
// stack that's built conditionally from whichever handlers the caller
// wires:
//
//   onPlay        — always when level.status !== 'unfinished'
//   onEdit        — for drafts the player can still modify (local/imported)
//   onDelete      — for levels the player owns (local/imported/remote-mine)
//   onHide        — for remote levels authored by someone else
//   onToggleLike  — remote levels
//   onShare       — remote levels
//
// Status colors track the level's lifecycle:
//   private  → grey   (only on this device)
//   pending  → orange (submitted, awaiting moderator review)
//   public   → green  (approved)
//   imported → blue   (loaded from JSON; not authored here)

const STATUS_PALETTE = {
  unfinished: { fill: 0xe0a800, label: 'unfinished' },
  private:    { fill: 0x9aa6b2, label: 'private'    },
  pending:    { fill: 0xff8a3a, label: 'pending'    },
  public:     { fill: 0x4caf50, label: 'public'     },
  imported:   { fill: 0x3b66b8, label: 'imported'   },
};

// Common dimensions — tuning these rebalances the whole right-side stack.
const BTN_H        = 36;
const BTN_GAP      = 8;
const CIRCLE_R     = 16;
const EDGE_PAD     = 16;
const PLAY_W       = 80;
const MEDIUM_W     = 70;

export class LevelCard {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x
   * @param {number} opts.y
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {object} opts.level
   * @param {boolean} opts.liked
   * @param {() => void} opts.onPlay
   * @param {() => void} [opts.onToggleLike]
   * @param {() => void} [opts.onEdit]
   * @param {() => void} [opts.onDelete]
   * @param {() => void} [opts.onHide]
   * @param {() => void} [opts.onShare]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this._liked = !!opts.liked;
    this._pillButtons = [];   // text-pill buttons tracked for destroy()
    this._circles = [];       // small circle buttons tracked for destroy()
    this._build();
  }

  _build() {
    const { x, y, width, height, level } = this.opts;
    const sx = x - width / 2;
    const sy = y - height / 2;

    this.bg = this.scene.add.rectangle(x, y, width, height, 0x223047, 1)
      .setStrokeStyle(2, 0x3a5a88, 1);

    // Name (top-left).
    this.name = this.scene.add.text(sx + EDGE_PAD, sy + 12, level.name || 'untitled', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0, 0);

    // Author + rating on a single "meta" line. For remote levels we
    // append ★ avg (count) inline so the card stays compact; local-only
    // levels have no rating and just show the author.
    const authorStr = level.author ? `by ${level.author}` : 'anonymous';
    const metaStr = this._buildMetaLine(level, authorStr);
    this.meta = this.scene.add.text(sx + EDGE_PAD, sy + 38, metaStr, {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px',
      color: '#9aa6b2',
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

    // ---- right-aligned button stack ----
    //
    // Right-to-left cursor — every button reserves its width + a gap and
    // moves the cursor left. Unused slots just don't advance.
    const rowY = y;
    const playable = level.status !== 'unfinished';
    let cursor = sx + width - EDGE_PAD;

    if (playable) {
      const cx = cursor - PLAY_W / 2;
      this._addPill(cx, rowY, PLAY_W, BTN_H, 'PLAY',
        0x3b66b8, 0x4a76c8, '#ffffff', '14px',
        () => this.opts.onPlay && this.opts.onPlay(),
        { asPlay: true });
      cursor -= PLAY_W + BTN_GAP;
    }

    if (this.opts.onEdit) {
      const cx = cursor - MEDIUM_W / 2;
      this._addPill(cx, rowY, MEDIUM_W, BTN_H, 'EDIT',
        0x2a3b55, 0x3a4d6f, '#e6edf5', '12px',
        () => this.opts.onEdit());
      cursor -= MEDIUM_W + BTN_GAP;
    }

    if (this.opts.onDelete) {
      const cx = cursor - MEDIUM_W / 2;
      this._addPill(cx, rowY, MEDIUM_W, BTN_H, 'DELETE',
        0xd94c4c, 0xe46060, '#ffffff', '12px',
        () => this.opts.onDelete());
      cursor -= MEDIUM_W + BTN_GAP;
    }

    if (this.opts.onHide) {
      const cx = cursor - MEDIUM_W / 2;
      this._addPill(cx, rowY, MEDIUM_W, BTN_H, 'HIDE',
        0x2a3b55, 0x3a4d6f, '#e6edf5', '12px',
        () => this.opts.onHide());
      cursor -= MEDIUM_W + BTN_GAP;
    }

    // LIKE + SHARE are small circle buttons — only for remote levels.
    if (this.opts.onToggleLike) {
      const cx = cursor - CIRCLE_R;
      this.likeBg = this.scene.add.circle(cx, rowY, CIRCLE_R,
        this._liked ? 0xd94c4c : 0x2a3b55, 1)
        .setStrokeStyle(2, 0x1a2332, 1)
        .setInteractive({ useHandCursor: true });
      this.likeGlyph = this.scene.add.text(cx, rowY, '\u2665', {
        fontFamily: 'system-ui, sans-serif', fontSize: '18px',
        color: this._liked ? '#ffffff' : '#9aa6b2',
      }).setOrigin(0.5);
      this.likeBg.on('pointerup', async () => {
        const next = await this.opts.onToggleLike();
        this._setLiked(!!next);
      });
      this._circles.push(this.likeBg, this.likeGlyph);
      cursor -= CIRCLE_R * 2 + 6;
    }

    if (this.opts.onShare) {
      const cx = cursor - CIRCLE_R;
      this.shareBg = this.scene.add.circle(cx, rowY, CIRCLE_R, 0x2a3b55, 1)
        .setStrokeStyle(2, 0x1a2332, 1)
        .setInteractive({ useHandCursor: true });
      this.shareGlyph = this.scene.add.text(cx, rowY, '\u2197', {
        fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
        color: '#e6edf5',
      }).setOrigin(0.5);
      this.shareBg.on('pointerover', () => this.shareBg.setFillStyle(0x3a4d6f, 1));
      this.shareBg.on('pointerout',  () => this.shareBg.setFillStyle(0x2a3b55, 1));
      this.shareBg.on('pointerup', () => this.opts.onShare());
      this._circles.push(this.shareBg, this.shareGlyph);
      cursor -= CIRCLE_R * 2 + 6;
    }
  }

  _buildMetaLine(level, authorStr) {
    const isRemote = level.origin === 'remote';
    const count = Number(level.ratingCount) || 0;
    const avg   = Number(level.ratingAvg)   || 0;
    if (isRemote && count > 0) {
      return `${authorStr}   \u2605 ${avg.toFixed(1)} (${count})`;
    }
    if (isRemote) {
      return `${authorStr}   \u2606 not rated yet`;
    }
    return authorStr;
  }

  _addPill(cx, cy, w, h, label, fill, hoverFill, textColor, fontSize, onTap, opts = {}) {
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
    if (opts.asPlay) {
      this.playBg = rect;
      this.playText = text;
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
    this._pillButtons.length = 0;
    this._circles.length = 0;
  }

  // Every GameObject this card owns, flattened. Used by CommunityScene to
  // reparent the card into its scroll container without touching
  // LevelCard's build-time coordinates.
  static pieces(card) {
    const out = [card.bg, card.name, card.meta, card.chip, card.chipText];
    for (const p of card._pillButtons) { out.push(p.rect, p.text); }
    for (const c of card._circles)     { out.push(c); }
    return out;
  }
}
