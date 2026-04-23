// 1..5 star rating prompt shown after a player finishes a community
// level. Same visual vocabulary as ConfirmModal — shield + rounded panel
// + bottom button row — plus a row of tappable star glyphs. Skip is a
// no-op; submit fires onSubmit(stars).

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';
const MSG_COLOR    = '#485566';

const STAR_FILLED = '\u2605';
const STAR_EMPTY  = '\u2606';
const STAR_ACTIVE = '#f5b400';
const STAR_IDLE   = '#9aa6b2';

const CANCEL_FILL   = 0x9aa6b2;
const CANCEL_HOVER  = 0xacb7c2;
const CONFIRM_FILL  = 0x3fa65a;
const CONFIRM_HOVER = 0x4fc072;

export class RateLevelModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._closed = false;
    this._stars = Number(opts.initialStars) > 0 ? Number(opts.initialStars) : 0;
    const levelName = opts.levelName || '';
    const { width, height } = scene.scale;

    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerup', () => this._finish(opts.onSkip));

    const panelW = Math.min(460, width - 60);
    const panelH = 260;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + 44, 'RATE THIS LEVEL', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    this.subtitle = scene.add.text(width / 2, py + 78,
      levelName ? `"${levelName}"` : 'How was it?', {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px',
      color: MSG_COLOR, align: 'center', wordWrap: { width: panelW - 48 },
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    // Star row — five centered glyphs, each interactive. Hover previews
    // the would-be rating by lighting up stars up to the cursor.
    const starSize = 40, starGap = 12;
    const starTotalW = starSize * 5 + starGap * 4;
    const starStartX = width / 2 - starTotalW / 2 + starSize / 2;
    const starY = py + 140;
    this.stars = [];
    for (let i = 0; i < 5; i++) {
      const sx = starStartX + i * (starSize + starGap);
      const glyph = scene.add.text(sx, starY, STAR_EMPTY, {
        fontFamily: 'system-ui, sans-serif', fontSize: `${starSize}px`, fontStyle: 'bold',
        color: STAR_IDLE,
      }).setOrigin(0.5).setDepth(PANEL_DEPTH);
      glyph.setInteractive({ useHandCursor: true });
      const starN = i + 1;
      glyph.on('pointerover', () => this._preview(starN));
      glyph.on('pointerout',  () => this._render());
      glyph.on('pointerup',   () => { this._stars = starN; this._render(); });
      this.stars.push(glyph);
    }
    this._render();

    const buttonY = py + panelH - 48;
    const buttonW = 140, buttonH = 48, gap = 18;
    const totalW = buttonW * 2 + gap;
    const startX = width / 2 - totalW / 2;

    this.buttons = [
      this._button(startX + buttonW / 2, buttonY, buttonW, buttonH,
        'SKIP', CANCEL_FILL, CANCEL_HOVER, () => this._finish(opts.onSkip)),
      this._button(startX + buttonW + gap + buttonW / 2, buttonY, buttonW, buttonH,
        'SUBMIT', CONFIRM_FILL, CONFIRM_HOVER, () => {
          if (this._stars < 1) return;  // need at least one star
          const n = this._stars;
          this._finish(() => opts.onSubmit && opts.onSubmit(n));
        }),
    ];
    this._submitBtn = this.buttons[1];
    this._refreshSubmitEnabled();
  }

  _preview(n) {
    for (let i = 0; i < this.stars.length; i++) {
      const lit = i < n;
      this.stars[i].setText(lit ? STAR_FILLED : STAR_EMPTY);
      this.stars[i].setColor(lit ? STAR_ACTIVE : STAR_IDLE);
    }
  }

  _render() {
    this._preview(this._stars);
    this._refreshSubmitEnabled();
  }

  _refreshSubmitEnabled() {
    if (!this._submitBtn) return;
    const enabled = this._stars > 0;
    this._submitBtn.container.alpha = enabled ? 1 : 0.5;
  }

  _button(cx, cy, w, h, label, fill, hoverFill, onTap) {
    const scene = this.scene;
    const radius = Math.min(16, Math.floor(h / 2));
    const container = scene.add.container(cx, cy).setDepth(PANEL_DEPTH);
    const drawBg = (bgFill) => {
      bg.clear();
      bg.fillStyle(bgFill, 1);
      bg.lineStyle(2, PANEL_STROKE, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, radius);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, radius);
    };
    const bg = scene.add.graphics();
    drawBg(fill);
    container.add(bg);
    const text = scene.add.text(0, 0, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    container.add(text);

    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    container.add(hit);

    hit.on('pointerover', () => drawBg(hoverFill));
    hit.on('pointerout',  () => drawBg(fill));
    hit.on('pointerup', (p, lx, ly, e) => { if (e) e.stopPropagation(); onTap(); });
    return { container, bg, text, hit };
  }

  _finish(cb) {
    if (this._closed) return;
    this._closed = true;
    this.destroy();
    if (cb) cb();
  }

  destroy() {
    if (this.shield)   this.shield.destroy();
    if (this.panel)    this.panel.destroy();
    if (this.title)    this.title.destroy();
    if (this.subtitle) this.subtitle.destroy();
    for (const s of (this.stars || [])) { s.destroy(); }
    this.stars = null;
    for (const b of (this.buttons || [])) { b.container.destroy(true); }
    this.buttons = null;
  }
}
