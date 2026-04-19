import Phaser from 'phaser';
import { SECTIONS } from '../catalog/index.js';
import { loadProgress } from '../progress.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { BOARD_GAP, BLUEPRINT_BG, BLUEPRINT_STROKE, BLUEPRINT_DOT } from '../constants.js';
import { drawHome } from '../ui/Icons.js';
import { TitleBar } from '../ui/TitleBar.js';

// Level select. Layout mirrors the Player scene's column so this screen
// reads as a "preview" of the in-game layout: the LEVEL SELECT header box,
// each section's level row, and the BOSS tile all sit at the same width as
// the in-game blueprint. An icon island at the bottom — sized identically
// to the Player's island — holds a single centered HOME button.

// These values have to stay in sync with PlayerScene. Moving them to a
// shared helper is a fair cleanup for later; inlining them here keeps the
// constraint explicit.
const REF_DIM             = 5;
const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;

const HEADER_H          = 72;          // matches TitleBar TITLE_H
const HEADER_CORNER_R   = 14;
const HEADER_FRAME_FILL   = 0xffffff;
const HEADER_FRAME_STROKE = 0x1a2332;
const HEADER_TEXT_COLOR   = '#1a2332';

// Unified inter-block margin. Used between every stacked element — header
// to row, row to boss, boss to next section, and between level tiles
// within a row — so the layout reads as an evenly spaced column.
const BLOCK_GAP         = 22;
const BUTTON_CORNER_R   = 12;
const BOSS_H            = 96;
const TOP_MARGIN        = 16;
const BOTTOM_MARGIN     = 16;

const COLOR_GREEN        = 0x4caf50;
const COLOR_GREEN_STROKE = 0x2e7a36;
const COLOR_BLUE         = 0x3b66b8;
const COLOR_BLUE_STROKE  = 0x1f3a74;
const COLOR_GREY         = 0x9aa6b2;
const COLOR_GREY_STROKE  = 0x5a6674;

export default class LevelSelectScene extends Phaser.Scene {
  constructor() { super({ key: 'LevelSelect' }); }

  async create() {
    enableMenuBg();
    fadeIn(this);

    const progress = await loadProgress();
    this._beaten = new Set(progress.beaten);
    this._nextLevelId = this._findNextLevelId();
    this._gfx  = [];
    this._hits = [];
    this._texts = [];

    this._layoutAndRender();

    this._onResize = () => this._relayout();
    this.scale.on('resize', this._onResize);
    this.events.on('shutdown', () => {
      if (this._onResize) this.scale.off('resize', this._onResize);
    });
  }

  _relayout() {
    for (const g of this._gfx)   g.destroy();
    for (const h of this._hits)  h.destroy();
    for (const t of this._texts) t.destroy();
    this._gfx = []; this._hits = []; this._texts = [];
    this._layoutAndRender();
  }

  // First level whose unlock-gate is open and that isn't beaten. Walks
  // every section's regulars THEN its boss before moving on to the next
  // section, so the "next" tile lights up on the boss once all regulars
  // in that section are cleared. Returns `null` when everything is beaten.
  _findNextLevelId() {
    const beaten = this._beaten;
    const ordered = [];
    for (const section of SECTIONS) {
      for (const lvl of section.levels) ordered.push(lvl);
      if (section.boss) ordered.push(section.boss);
    }
    let anyEarlierBeaten = false;
    for (const lvl of ordered) {
      const unlocked = anyEarlierBeaten || lvl === ordered[0];
      if (unlocked && !beaten.has(lvl.id)) return lvl.id;
      if (beaten.has(lvl.id)) anyEarlierBeaten = true;
    }
    return null;
  }

  // Derive the Player scene's blueprint width from the current content box
  // so our header/level/boss/island all match the in-game chrome.
  _computeRefMetrics(box) {
    const { boxW, boxH } = box;
    const availW = boxW - 8;
    const refSlotCols = (REF_DIM - 2) + 1;
    const refSlotRows = (REF_DIM - 2) + 1;
    const topMargin       = TitleBar.HEIGHT + 8;
    const titleToBoardGap = 4;
    const boardToBpGap    = 6;
    const bottomMargin    = 16;
    const chrome          = BLUEPRINT_PAD * 4 + ISLAND_TO_GRID_GAP;
    const stackFixed      = topMargin + titleToBoardGap + boardToBpGap + bottomMargin + chrome;

    const wCellFactor     = REF_DIM;
    const wGapFactor      = Math.max(0, REF_DIM - 1);
    const cellW_board     = (availW - BOARD_GAP * wGapFactor) / wCellFactor;
    const cellW_blueprint = (availW - BLUEPRINT_PAD * 2) / refSlotCols;
    const stackCellFactor = REF_DIM + (refSlotRows + 1);
    const stackGapFactor  = Math.max(0, REF_DIM - 1);
    const cellH_stack     = (boxH - stackFixed - BOARD_GAP * stackGapFactor) / stackCellFactor;
    const refPxCell       = Math.max(24, Math.floor(Math.min(cellW_board, cellW_blueprint, cellH_stack)));

    const bpW     = refSlotCols * refPxCell;
    const islandW = bpW;
    const islandH = refPxCell;
    return { refPxCell, bpW, islandW, islandH };
  }

  _layoutAndRender() {
    const box = compute920Box(this);
    const { boxX, boxY, boxW, boxH } = box;
    const { bpW, islandW, islandH } = this._computeRefMetrics(box);

    const centerX = boxX + Math.round(boxW / 2);

    // 5 tiles per row, uniform BLOCK_GAP between them — same gap as between
    // stacked blocks, so horizontal + vertical spacing read as one rhythm.
    const cols = 5;
    const btnSize = Math.floor((bpW - BLOCK_GAP * (cols - 1)) / cols);

    // ---- Top-justified stack: header + sections ----
    let y = boxY + TOP_MARGIN;
    this._drawHeaderBox(centerX, y + HEADER_H / 2, bpW, HEADER_H, 'LEVEL SELECT');
    y += HEADER_H + BLOCK_GAP;

    for (let si = 0; si < SECTIONS.length; si++) {
      const section = SECTIONS[si];
      const startX = centerX - bpW / 2;
      // Lay out the regular levels in a 5-column grid that wraps over as
      // many rows as the section needs. Each section ends with its boss
      // tile (full width) below the regular grid.
      const lvls = section.levels;
      for (let idx = 0; idx < lvls.length; idx++) {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const cx = startX + c * (btnSize + BLOCK_GAP) + btnSize / 2;
        const cy = y + r * (btnSize + BLOCK_GAP) + btnSize / 2;
        this._drawLevelTile(cx, cy, btnSize, lvls[idx]);
      }
      const rows = Math.max(1, Math.ceil(lvls.length / cols));
      y += rows * btnSize + Math.max(0, rows - 1) * BLOCK_GAP + BLOCK_GAP;

      this._drawBossTile(centerX, y + BOSS_H / 2, bpW, BOSS_H, section);
      y += BOSS_H;
      if (si < SECTIONS.length - 1) y += BLOCK_GAP;
    }

    // ---- Bottom-justified icon island ----
    const islandTotalH = islandH + BLUEPRINT_PAD * 2;
    const islandOriginX = centerX - islandW / 2;
    const islandOriginY = boxY + boxH - BOTTOM_MARGIN - islandTotalH + BLUEPRINT_PAD;
    this._drawIconIsland(islandOriginX, islandOriginY, islandW, islandH);
  }

  _drawHeaderBox(cx, cy, w, h, label) {
    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(HEADER_FRAME_FILL, 1);
    gfx.lineStyle(2, HEADER_FRAME_STROKE, 1);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, HEADER_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, HEADER_CORNER_R);
    this._gfx.push(gfx);
    const text = this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: HEADER_TEXT_COLOR,
    }).setOrigin(0.5).setDepth(11);
    this._texts.push(text);
  }

  _drawLevelTile(cx, cy, size, level) {
    const beaten = this._beaten.has(level.id);
    const isNext = this._nextLevelId === level.id;
    let fill, stroke, clickable;
    if (beaten)      { fill = COLOR_GREEN; stroke = COLOR_GREEN_STROKE; clickable = true;  }
    else if (isNext) { fill = COLOR_BLUE;  stroke = COLOR_BLUE_STROKE;  clickable = true;  }
    else             { fill = COLOR_GREY;  stroke = COLOR_GREY_STROKE;  clickable = false; }

    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(2, stroke, 1);
    gfx.fillRoundedRect(cx - size / 2, cy - size / 2, size, size, BUTTON_CORNER_R);
    gfx.strokeRoundedRect(cx - size / 2, cy - size / 2, size, size, BUTTON_CORNER_R);
    this._gfx.push(gfx);

    const num = this.add.text(cx, cy, String(level.number), {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${Math.floor(size * 0.42)}px`,
      fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5).setDepth(11);
    this._texts.push(num);

    if (clickable) {
      const hit = this.add.rectangle(cx, cy, size, size, 0xffffff, 0)
        .setInteractive({ useHandCursor: true }).setDepth(12);
      hit.on('pointerup', () => fadeTo(this, 'Player', { levelId: level.id }));
      this._hits.push(hit);
    }
  }

  _drawBossTile(cx, cy, w, h, section) {
    const boss = section.boss;
    // Boss tiles share the regular-tile color logic — green if beaten,
    // blue if it's the next playable level, grey otherwise. Sections
    // without a boss authored render the legacy "coming soon" placeholder.
    let fill, stroke, clickable, label;
    if (!boss) {
      fill = COLOR_GREY; stroke = COLOR_GREY_STROKE; clickable = false;
      label = `${section.name.toUpperCase()} BOSS — COMING SOON`;
    } else {
      const beaten = this._beaten.has(boss.id);
      const isNext = this._nextLevelId === boss.id;
      if (beaten)      { fill = COLOR_GREEN; stroke = COLOR_GREEN_STROKE; clickable = true;  }
      else if (isNext) { fill = COLOR_BLUE;  stroke = COLOR_BLUE_STROKE;  clickable = true;  }
      else             { fill = COLOR_GREY;  stroke = COLOR_GREY_STROKE;  clickable = false; }
      label = `BOSS ${boss.number} — ${(boss.name || '').toUpperCase()}`;
    }
    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(2, stroke, 1);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, BUTTON_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, BUTTON_CORNER_R);
    this._gfx.push(gfx);
    const text = this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#ffffff', align: 'center',
    }).setOrigin(0.5).setDepth(11);
    this._texts.push(text);
    if (clickable) {
      const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
        .setInteractive({ useHandCursor: true }).setDepth(12);
      hit.on('pointerup', () => fadeTo(this, 'Player', { levelId: boss.id }));
      this._hits.push(hit);
    }
  }

  _drawIconIsland(originX, originY, islandW, islandH) {
    const frame = this.add.graphics().setDepth(10);
    frame.x = originX; frame.y = originY;
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this._gfx.push(frame);

    // Single centered HOME slot.
    const slot = this.add.graphics().setDepth(10);
    slot.x = originX; slot.y = originY;
    slot.fillStyle(BLUEPRINT_BG, 1);
    slot.lineStyle(1, BLUEPRINT_STROKE, 0.5);
    const slotPad = 4;
    slot.fillRoundedRect(slotPad, slotPad, islandW - slotPad * 2, islandH - slotPad * 2, 8);
    this._gfx.push(slot);

    const iconSize = Math.round(Math.min(islandW, islandH) * 0.55);
    const icon = this.add.graphics().setDepth(11);
    icon.x = originX; icon.y = originY;
    drawHome(icon, islandW / 2, islandH / 2, iconSize, BLUEPRINT_DOT);
    this._gfx.push(icon);

    const hit = this.add.rectangle(originX + islandW / 2, originY + islandH / 2, islandW - 6, islandH - 6, 0xffffff, 0)
      .setInteractive({ useHandCursor: true }).setDepth(12);
    hit.on('pointerup', () => fadeTo(this, 'Home'));
    this._hits.push(hit);
  }
}
