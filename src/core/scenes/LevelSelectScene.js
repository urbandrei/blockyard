import Phaser from 'phaser';
import { SECTIONS } from '../catalog/index.js';
import { loadProgress } from '../progress.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { BOARD_GAP, BLUEPRINT_BG, BLUEPRINT_STROKE, BLUEPRINT_DOT, BEAT_MS } from '../constants.js';
import { drawHome, drawGear, drawPlayTriangle } from '../ui/Icons.js';
import { SettingsModal } from '../ui/SettingsModal.js';
import { TitleBar } from '../ui/TitleBar.js';
import { wireUiClicks, wireEmptyClicks } from '../audio/sfx.js';

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

const HEADER_H          = 60;
const HEADER_CORNER_R   = 14;
const HEADER_FRAME_FILL   = 0xffffff;
const HEADER_FRAME_STROKE = 0x1a2332;
const HEADER_TEXT_COLOR   = '#1a2332';

// Themed section titles, one per group of 10 levels. The order here
// must match the catalog's section order (sections 1..4 = levels 1-10,
// 11-20, 21-30, 31-40).
const SECTION_TITLES = ['BLOCK YARD', 'PAINT SPILL', 'ACID SWAMP', 'LASER FIELD'];

// Unified inter-block margin. Used between every stacked element — header
// to row, row to boss, boss to next section, and between level tiles
// within a row — so the layout reads as an evenly spaced column.
const BLOCK_GAP         = 12;
const BUTTON_CORNER_R   = 12;
const BOSS_H            = 96;
const TOP_MARGIN        = 6;
const BOTTOM_MARGIN     = 12;

const COLOR_GREEN        = 0x4caf50;
const COLOR_GREEN_STROKE = 0x2e7a36;
const COLOR_BLUE         = 0x3b66b8;
const COLOR_BLUE_STROKE  = 0x1f3a74;
const COLOR_GREY         = 0x9aa6b2;
const COLOR_GREY_STROKE  = 0x5a6674;

// Number of regular levels gated behind the Wild West unlock. Sections 1..4
// (40 levels) make up the main campaign; everything from level 41 onward is
// reachable only through the Wild West sub-page.
const MAIN_SECTION_COUNT = 4;

export default class LevelSelectScene extends Phaser.Scene {
  constructor() { super({ key: 'LevelSelect' }); }

  async create(data) {
    wireUiClicks(this);
    wireEmptyClicks(this);
    enableMenuBg();
    fadeIn(this);

    this._mode = (data && data.mode === 'wildwest') ? 'wildwest' : 'main';
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
      if (this._settingsModal) { try { this._settingsModal.destroy(); } catch (e) {} this._settingsModal = null; }
    });
  }

  _relayout() {
    for (const g of this._gfx)   { try { this.tweens.killTweensOf(g); } catch (e) {} g.destroy(true); }
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

    // ---- Top-justified stack: themed header per section, then tiles ----
    let y = boxY + TOP_MARGIN;

    // Mode controls which slice of SECTIONS we render and whether each
    // section gets its own header. Main mode shows sections 1..4 with their
    // themed headers and a WILD WEST gate at the bottom; wildwest mode shows
    // sections 5+ under one shared "WILD WEST" header (no per-section titles).
    const isWildWest = this._mode === 'wildwest';
    const sectionsToRender = isWildWest
      ? SECTIONS.slice(MAIN_SECTION_COUNT)
      : SECTIONS.slice(0, MAIN_SECTION_COUNT);

    if (isWildWest) {
      this._drawHeaderBox(centerX, y + HEADER_H / 2, bpW, HEADER_H, 'WILD WEST');
      y += HEADER_H + BLOCK_GAP;
    }

    for (let si = 0; si < sectionsToRender.length; si++) {
      const section = sectionsToRender[si];
      if (!isWildWest) {
        const title = SECTION_TITLES[si] || section.name.toUpperCase();
        this._drawHeaderBox(centerX, y + HEADER_H / 2, bpW, HEADER_H, title);
        y += HEADER_H + BLOCK_GAP;
      }

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

      if (section.boss) {
        this._drawBossTile(centerX, y + BOSS_H / 2, bpW, BOSS_H, section);
        y += BOSS_H;
      }
      if (si < sectionsToRender.length - 1) y += BLOCK_GAP;
    }

    if (!isWildWest && SECTIONS.length > MAIN_SECTION_COUNT) {
      const unlocked = this._isWildWestUnlocked();
      y += BLOCK_GAP;
      this._drawWildWestButton(centerX, y + HEADER_H / 2, bpW, HEADER_H, unlocked);
      y += HEADER_H;
    }

    if (isWildWest) {
      y += BLOCK_GAP;
      this._drawBackToMainButton(centerX, y + HEADER_H / 2, Math.floor(bpW / 2), HEADER_H);
      y += HEADER_H;
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

    // Wrap gfx + number in a container so hover/press tweens scale the
    // whole tile around its own center without fighting the absolute
    // positioning of each child.
    const tile = this.add.container(cx, cy).setDepth(10);
    const gfx = this.add.graphics();
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(2, stroke, 1);
    gfx.fillRoundedRect(-size / 2, -size / 2, size, size, BUTTON_CORNER_R);
    gfx.strokeRoundedRect(-size / 2, -size / 2, size, size, BUTTON_CORNER_R);
    tile.add(gfx);

    const num = this.add.text(0, 0, String(level.number), {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${Math.floor(size * 0.42)}px`,
      fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    tile.add(num);
    this._gfx.push(tile);

    if (clickable) {
      const hit = this.add.rectangle(cx, cy, size, size, 0xffffff, 0.001)
        .setInteractive({ useHandCursor: true }).setDepth(12);
      this._attachTileJuice(hit, tile, () => fadeTo(this, 'Player', { levelId: level.id }));
      this._hits.push(hit);
    }
  }

  // Hover/press/release juice for a tile container. Mirrors
  // HomeScene._attachTapJuice — uses direct scale tweens since
  // LevelSelect doesn't run a per-frame pulse to fight.
  _attachTileJuice(hit, target, onTap) {
    const killAll = () => { try { this.tweens.killTweensOf(target); } catch (e) {} };
    const tweenScale = (to, duration, ease) => {
      killAll();
      this.tweens.add({ targets: target, scaleX: to, scaleY: to, duration, ease });
    };
    let pressed = false;
    hit.on('pointerover', () => { if (!pressed) tweenScale(1.06, 140, 'Sine.Out'); });
    hit.on('pointerout',  () => { pressed = false; tweenScale(1.0, 180, 'Sine.Out'); });
    hit.on('pointerdown', () => { pressed = true;  tweenScale(0.92,  90, 'Sine.Out'); });
    hit.on('pointerup',   () => {
      pressed = false;
      // Snap back past 1.0 for a springy release, then settle.
      killAll();
      this.tweens.add({
        targets: target, scaleX: 1.12, scaleY: 1.12, duration: 90, ease: 'Sine.Out',
        onComplete: () => {
          this.tweens.add({
            targets: target, scaleX: 1, scaleY: 1, duration: 160, ease: 'Back.Out',
          });
        },
      });
      if (onTap) onTap();
    });
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

  // Wild West unlocks once every level (and any authored boss) inside the
  // first MAIN_SECTION_COUNT sections is in the beaten set.
  _isWildWestUnlocked() {
    const main = SECTIONS.slice(0, MAIN_SECTION_COUNT);
    for (const s of main) {
      for (const l of s.levels) if (!this._beaten.has(l.id)) return false;
      if (s.boss && !this._beaten.has(s.boss.id)) return false;
    }
    return true;
  }

  _drawWildWestButton(cx, cy, w, h, unlocked) {
    // Visually mirrors the themed section headers (white panel, dark border,
    // dark label) so it reads as the next section in the column. Locked
    // state swaps to the standard grey/grey-stroke combo. When unlocked the
    // panel takes on a warm cream tint and the whole tile breathes on the
    // 2-beat grid so the player's eye catches the new gate.
    const UNLOCKED_FILL   = 0xffe9b8;       // warm cream — distinct from white headers
    const UNLOCKED_STROKE = 0x8a5a1a;       // amber border to match
    const fill   = unlocked ? UNLOCKED_FILL   : COLOR_GREY;
    const stroke = unlocked ? UNLOCKED_STROKE : COLOR_GREY_STROKE;
    const labelColor = unlocked ? HEADER_TEXT_COLOR : '#ffffff';
    const arrowColor = unlocked ? 0x1a2332 : 0xffffff;

    // Container so a single scale tween pulses the panel + label + arrow as
    // one unit, scaling around the bar's center.
    const tile = this.add.container(cx, cy).setDepth(10);
    const gfx = this.add.graphics();
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(2, stroke, 1);
    gfx.fillRoundedRect(-w / 2, -h / 2, w, h, HEADER_CORNER_R);
    gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, HEADER_CORNER_R);
    tile.add(gfx);

    const text = this.add.text(0, 0, 'WILD WEST', {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: labelColor, align: 'center',
    }).setOrigin(0.5);
    tile.add(text);

    // Right-pointing arrow tucked against the right edge.
    const arrowSize = Math.floor(h * 0.55);
    const arrowCX = w / 2 - arrowSize * 0.6 - 8;
    const arrow = this.add.graphics();
    drawPlayTriangle(arrow, arrowCX, 0, arrowSize, arrowColor);
    tile.add(arrow);

    this._gfx.push(tile);

    if (unlocked) {
      this.tweens.add({
        targets: tile,
        scale: { from: 1.0, to: 1.035 },
        duration: BEAT_MS, yoyo: true, repeat: -1, ease: 'Sine.InOut',
      });
      const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
        .setInteractive({ useHandCursor: true }).setDepth(12);
      hit.on('pointerup', () => fadeTo(this, 'LevelSelect', { mode: 'wildwest' }));
      this._hits.push(hit);
    }
  }

  // Mirror of the WILD WEST gate: a section-header-styled bar that takes the
  // user back to the main level select. Always interactive on the wildwest
  // page since reaching it implies the main campaign is already cleared.
  // Shares the cream/amber palette + 2-beat breath pulse with the unlocked
  // WILD WEST bar so both gates read as the same kind of affordance.
  _drawBackToMainButton(cx, cy, w, h) {
    const UNLOCKED_FILL   = 0xffe9b8;
    const UNLOCKED_STROKE = 0x8a5a1a;
    const arrowColor = 0x1a2332;

    const tile = this.add.container(cx, cy).setDepth(10);
    const gfx = this.add.graphics();
    gfx.fillStyle(UNLOCKED_FILL, 1);
    gfx.lineStyle(2, UNLOCKED_STROKE, 1);
    gfx.fillRoundedRect(-w / 2, -h / 2, w, h, HEADER_CORNER_R);
    gfx.strokeRoundedRect(-w / 2, -h / 2, w, h, HEADER_CORNER_R);
    tile.add(gfx);

    const text = this.add.text(0, 0, 'GO BACK', {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: HEADER_TEXT_COLOR, align: 'center',
    }).setOrigin(0.5);
    tile.add(text);

    // Left-pointing arrow tucked against the left edge — the visual mirror
    // of the WILD WEST bar's right-arrow.
    const arrowSize = Math.floor(h * 0.55);
    const arrowCX = -w / 2 + arrowSize * 0.6 + 8;
    const arrow = this.add.graphics();
    const aH = arrowSize * 0.82;
    const halfH = aH / 2;
    const halfW = halfH * 0.78;
    arrow.fillStyle(arrowColor, 1);
    arrow.beginPath();
    arrow.moveTo(arrowCX + halfW, -halfH);
    arrow.lineTo(arrowCX + halfW,  halfH);
    arrow.lineTo(arrowCX - halfW, 0);
    arrow.closePath();
    arrow.fillPath();
    tile.add(arrow);

    this._gfx.push(tile);

    this.tweens.add({
      targets: tile,
      scale: { from: 1.0, to: 1.035 },
      duration: BEAT_MS, yoyo: true, repeat: -1, ease: 'Sine.InOut',
    });

    const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
      .setInteractive({ useHandCursor: true }).setDepth(12);
    hit.on('pointerup', () => fadeTo(this, 'LevelSelect', { mode: 'main' }));
    this._hits.push(hit);
  }

  _drawIconIsland(originX, originY, islandW, islandH) {
    const frame = this.add.graphics().setDepth(10);
    frame.x = originX; frame.y = originY;
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this._gfx.push(frame);

    // Two slots — HOME on the left, SETTINGS (gear) on the right.
    const slots = this.add.graphics().setDepth(10);
    slots.x = originX; slots.y = originY;
    slots.fillStyle(BLUEPRINT_BG, 1);
    slots.lineStyle(1, BLUEPRINT_STROKE, 0.5);
    const slotPad = 4;
    const slotW = islandW / 2;
    slots.fillRoundedRect(slotPad, slotPad, slotW - slotPad * 2, islandH - slotPad * 2, 8);
    slots.fillRoundedRect(slotW + slotPad, slotPad, slotW - slotPad * 2, islandH - slotPad * 2, 8);
    this._gfx.push(slots);

    const iconSize = Math.round(Math.min(slotW, islandH) * 0.55);
    const cy = islandH / 2;
    const addGlyph = (slotIdx, drawFn, onTap) => {
      const icon = this.add.graphics().setDepth(11);
      icon.x = originX; icon.y = originY;
      drawFn(icon, slotIdx * slotW + slotW / 2, cy, iconSize, BLUEPRINT_DOT);
      this._gfx.push(icon);
      const hit = this.add.rectangle(
        originX + slotIdx * slotW + slotW / 2,
        originY + islandH / 2,
        slotW - 6, islandH - 6, 0xffffff, 0,
      ).setInteractive({ useHandCursor: true }).setDepth(12);
      hit.on('pointerup', onTap);
      this._hits.push(hit);
    };
    addGlyph(0, drawHome, () => fadeTo(this, 'Home'));
    addGlyph(1, drawGear, () => this._openSettings());
  }

  _openSettings() {
    if (this._settingsModal) return;
    this._settingsModal = new SettingsModal(this, {
      onClose: () => { this._settingsModal = null; },
    });
  }
}
