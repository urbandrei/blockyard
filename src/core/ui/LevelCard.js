// One row in the Community search list. Renders the level's name, author,
// status chip, a like-toggle, and a PLAY button. Caller wires `onPlay`,
// `onToggleLike`, `onDelete` (delete is optional — community.js can later
// add a long-press to delete; not wired in MVP).
//
// Status colors track the level's lifecycle:
//   private  → grey   (only on this device)
//   pending  → orange (submitted, awaiting backend review — Milestone H)
//   public   → green  (approved by admin)
//   imported → blue   (loaded from JSON; not authored here)

const STATUS_PALETTE = {
  unfinished: { fill: 0xe0a800, label: 'unfinished' },
  private:    { fill: 0x9aa6b2, label: 'private'    },
  pending:    { fill: 0xff8a3a, label: 'pending'    },
  public:     { fill: 0x4caf50, label: 'public'     },
  imported:   { fill: 0x3b66b8, label: 'imported'   },
};

export class LevelCard {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number} opts.x          center
   * @param {number} opts.y          center
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {object} opts.level
   * @param {boolean} opts.liked
   * @param {() => void} opts.onPlay
   * @param {() => void} opts.onToggleLike
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this._liked = !!opts.liked;
    this._build();
  }

  _build() {
    const { x, y, width, height, level } = this.opts;
    const sx = x - width / 2;
    const sy = y - height / 2;

    this.bg = this.scene.add.rectangle(x, y, width, height, 0x223047, 1)
      .setStrokeStyle(2, 0x3a5a88, 1);

    // Name (top-left).
    this.name = this.scene.add.text(sx + 16, sy + 12, level.name || 'untitled', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0, 0);

    // Author / id (below name).
    const meta = level.author ? `by ${level.author}` : 'anonymous';
    this.meta = this.scene.add.text(sx + 16, sy + 38, meta, {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px',
      color: '#9aa6b2',
    }).setOrigin(0, 0);

    // Status chip.
    const status = STATUS_PALETTE[level.status] || STATUS_PALETTE.private;
    const chipW = 80, chipH = 22;
    const chipCX = sx + 16 + chipW / 2;
    const chipCY = sy + height - chipH / 2 - 12;
    this.chip = this.scene.add.rectangle(chipCX, chipCY, chipW, chipH, status.fill, 1)
      .setStrokeStyle(1, 0x1a2332, 1);
    this.chipText = this.scene.add.text(chipCX, chipCY, status.label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);

    // PLAY button (right-aligned). Hidden for unfinished drafts — they
    // don't have a blueprint yet, so "playing" would just show an empty
    // play area. The EDIT button takes that slot instead.
    const playable = level.status !== 'unfinished';
    const playW = 80, playH = 36;
    const playCX = sx + width - playW / 2 - 16;
    const playCY = y;
    if (playable) {
      this.playBg = this.scene.add.rectangle(playCX, playCY, playW, playH, 0x3b66b8, 1)
        .setStrokeStyle(2, 0x1a2332, 1)
        .setInteractive({ useHandCursor: true });
      this.playText = this.scene.add.text(playCX, playCY, 'PLAY', {
        fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5);
      this.playBg.on('pointerover', () => this.playBg.setFillStyle(0x4a76c8, 1));
      this.playBg.on('pointerout',  () => this.playBg.setFillStyle(0x3b66b8, 1));
      this.playBg.on('pointerup', () => this.opts.onPlay && this.opts.onPlay());
    }

    // EDIT button (left of PLAY, or rightmost when PLAY is hidden) — only
    // for levels that exist locally (authored here or imported).
    const editW = 70, editH = 36;
    const editCX = playable
      ? playCX - playW / 2 - 8 - editW / 2
      : sx + width - editW / 2 - 16;
    if (this.opts.onEdit) {
      this.editBg = this.scene.add.rectangle(editCX, playCY, editW, editH, 0x2a3b55, 1)
        .setStrokeStyle(2, 0x1a2332, 1)
        .setInteractive({ useHandCursor: true });
      this.editText = this.scene.add.text(editCX, playCY, 'EDIT', {
        fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
        color: '#e6edf5',
      }).setOrigin(0.5);
      this.editBg.on('pointerover', () => this.editBg.setFillStyle(0x3a4d6f, 1));
      this.editBg.on('pointerout',  () => this.editBg.setFillStyle(0x2a3b55, 1));
      this.editBg.on('pointerup', () => this.opts.onEdit());
    }

    // Like (heart) toggle — left of EDIT (or PLAY when no EDIT).
    const likeR = 16;
    const likeAnchor = this.opts.onEdit ? (editCX - editW / 2) : (playCX - playW / 2);
    const likeCX = likeAnchor - 8 - likeR;
    this.likeBg = this.scene.add.circle(likeCX, playCY, likeR, this._liked ? 0xd94c4c : 0x2a3b55, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    this.likeGlyph = this.scene.add.text(likeCX, playCY, '\u2665', {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px',
      color: this._liked ? '#ffffff' : '#9aa6b2',
    }).setOrigin(0.5);
    this.likeBg.on('pointerup', async () => {
      if (!this.opts.onToggleLike) return;
      const next = await this.opts.onToggleLike();
      this._setLiked(!!next);
    });
  }

  _setLiked(liked) {
    this._liked = liked;
    this.likeBg.setFillStyle(liked ? 0xd94c4c : 0x2a3b55, 1);
    this.likeGlyph.setColor(liked ? '#ffffff' : '#9aa6b2');
  }

  destroy() {
    this.bg.destroy();
    this.name.destroy();
    this.meta.destroy();
    this.chip.destroy();
    this.chipText.destroy();
    if (this.playBg)   this.playBg.destroy();
    if (this.playText) this.playText.destroy();
    if (this.editBg)   this.editBg.destroy();
    if (this.editText) this.editText.destroy();
    this.likeBg.destroy();
    this.likeGlyph.destroy();
  }
}
