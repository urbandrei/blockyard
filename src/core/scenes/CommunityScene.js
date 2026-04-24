import Phaser from 'phaser';
import {
  listAll, applyFilter, getLikes, toggleLike,
  toggleHide, getHidden, getLocalIds,
  deleteLevel as deleteLocalLevel,
} from '../community.js';
import { ConfirmModal } from '../ui/ConfirmModal.js';
import { RateLevelModal } from '../ui/RateLevelModal.js';
import { shareLevel as nativeShareLevel, encodeShareString as encodeShareForClient } from '../ui/socialShare.js';
import { wireUiClicks, wireEmptyClicks } from '../audio/sfx.js';
import { LevelCard } from '../ui/LevelCard.js';
import { TextInputOverlay } from '../ui/TextInputOverlay.js';
import { ImportModal } from '../ui/ImportModal.js';
import { EditorModePicker } from '../ui/EditorModePicker.js';
import { platform } from '../../platform/index.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { copyText } from '../ui/clipboard.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { BOARD_GAP, BLUEPRINT_BG, BLUEPRINT_STROKE, BLUEPRINT_DOT } from '../constants.js';
import { drawHome, drawGear } from '../ui/Icons.js';
import { SettingsModal } from '../ui/SettingsModal.js';
import { TitleBar } from '../ui/TitleBar.js';

// Community hub — styled to match LevelSelect / Home: a content-box-anchored
// column with a rounded header pill, a primary "LEVEL DESIGNER" button,
// search + filter row, paginated community level cards, IMPORT + DISCORD
// footer, and a bottom icon island carrying the HOME shortcut.

// Shared chrome metrics — kept in lockstep with LevelSelect.
const REF_DIM             = 5;
const BLUEPRINT_PAD       = 10;
const BLUEPRINT_RADIUS    = 12;
const ISLAND_TO_GRID_GAP  = 14;

const HEADER_H            = 72;
const HEADER_CORNER_R     = 14;
const HEADER_FRAME_FILL   = 0xffffff;
const HEADER_FRAME_STROKE = 0x1a2332;
const HEADER_TEXT_COLOR   = '#1a2332';

const BTN_CORNER_R  = 12;
const BTN_H         = 54;
const SMALL_BTN_H   = 42;
const BLOCK_GAP     = 18;
const TOP_MARGIN    = 16;
const BOTTOM_MARGIN = 16;

const PRIMARY_FILL   = 0x3b66b8;
const PRIMARY_STROKE = 0x1f3a74;
const PRIMARY_TEXT   = '#ffffff';

const MUTED_FILL    = 0x2a3b55;
const MUTED_STROKE  = 0x3a5a88;
const MUTED_TEXT    = '#e6edf5';

const SEARCH_FILL    = 0xffffff;
const SEARCH_STROKE  = 0x1a2332;
const SEARCH_TEXT    = '#1a2332';
const SEARCH_EMPTY   = '#9aa6b2';

const DISCORD_FILL   = 0x5865F2;
const DISCORD_STROKE = 0x3b46b0;

const CARD_H   = 88;
const CARD_GAP = 10;
const PAGE_SIZE = 5;

const DISCORD_URL = 'https://discord.gg/Rhb3wbZedF';

// The filter menu is split into two arrays: FILTER_TOP is the default
// visible stack (max 5 rows), FILTER_MORE is revealed when the user
// taps "Show more". Each row is:
//   { filter: '<key>', label } — sets this._filter
//   { sort:   '<key>', label } — sets this._sort
//   { divider: true }          — visual separator in the menu
const FILTER_TOP = [
  { filter: 'all',    label: 'All levels'      },
  { filter: 'mine',   label: 'My levels'       },
  { filter: 'others', label: "Others' levels"  },
  { filter: 'liked',  label: 'Liked only'      },
  { filter: 'hidden', label: 'Hidden only'     },
];
const FILTER_MORE = [
  { filter: 'unfinished', label: 'Unfinished drafts' },
  { filter: 'private',    label: 'Private (finished)' },
  { divider: true },
  { filter: 'r5',     label: 'Rated 5\u2605'   },
  { filter: 'r4',     label: 'Rated 4\u2605+'  },
  { filter: 'r3',     label: 'Rated 3\u2605+'  },
  { filter: 'r2',     label: 'Rated 2\u2605+'  },
  { filter: 'r1',     label: 'Rated 1\u2605+'  },
  { divider: true },
  { sort: 'recent',     label: 'Sort: recent'      },
  { sort: 'likesDesc',  label: 'Sort: most liked'  },
  { sort: 'likesAsc',   label: 'Sort: least liked' },
  { sort: 'ratingDesc', label: 'Sort: top rated'   },
];

export default class CommunityScene extends Phaser.Scene {
  constructor() { super({ key: 'Community' }); }

  async create() {
    wireUiClicks(this);
    wireEmptyClicks(this);
    enableMenuBg();
    fadeIn(this);

    this._levels = [];
    this._likes = new Set();
    this._hidden = new Set();
    this._localIds = new Set();
    this._query = '';
    this._filter = 'all';
    this._sort = 'recent';
    this._page = 0;

    this._gfx = [];
    this._hits = [];
    this._texts = [];
    this._cards = [];

    this._layoutAndRender();
    await this._refreshLevels();

    // Post-play rating prompt — PlayerScene stashes a level id on the
    // game registry when a community level is beaten. Consume once.
    const pending = this.game.registry.get('pendingRating');
    if (pending && pending.id) {
      this.game.registry.set('pendingRating', null);
      this._showRatingPrompt(pending);
    }

    this._onResize = () => this._relayout();
    this.scale.on('resize', this._onResize);
    this.events.on('shutdown', () => {
      if (this._onResize) this.scale.off('resize', this._onResize);
      if (this._settingsModal) { try { this._settingsModal.destroy(); } catch (e) {} this._settingsModal = null; }
      this._teardown();
    });
  }

  _relayout() {
    this._destroyChrome();
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._showMoreBtn) { this._destroyButton(this._showMoreBtn); this._showMoreBtn = null; }
    if (this._emptyText)   { this._emptyText.destroy(); this._emptyText = null; }
    if (this._offlineBanner) { this._offlineBanner.destroy(); this._offlineBanner = null; }
    this._layoutAndRender();
    this._renderList();
  }

  // Same `bpW` as LevelSelect so the header pill, buttons, and level
  // cards all line up with the in-game blueprint width the player knows.
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
    this._bpW = bpW;
    this._centerX = centerX;

    // --- top: header + primary actions + search row ---
    let y = boxY + TOP_MARGIN;
    this._drawHeaderBox(centerX, y + HEADER_H / 2, bpW, HEADER_H, 'COMMUNITY');
    y += HEADER_H + BLOCK_GAP;

    this._makeButton(centerX, y + BTN_H / 2, bpW, BTN_H, 'LEVEL DESIGNER',
      PRIMARY_FILL, PRIMARY_STROKE, PRIMARY_TEXT,
      () => fadeTo(this, 'Editor', { designerMode: true, bossMode: false, stageCount: 1 }));
    y += BTN_H + BLOCK_GAP;

    // Search + filter row.
    const filterW = 96;
    const gap     = 10;
    const searchW = bpW - filterW - gap;
    const searchCX = centerX - bpW / 2 + searchW / 2;
    const filterCX = centerX + bpW / 2 - filterW / 2;
    const rowCY = y + SMALL_BTN_H / 2;
    this._drawSearchBox(searchCX, rowCY, searchW, SMALL_BTN_H);
    this._makeButton(filterCX, rowCY, filterW, SMALL_BTN_H, 'FILTER',
      MUTED_FILL, MUTED_STROKE, MUTED_TEXT,
      () => this._toggleFilterMenu(filterCX, rowCY + SMALL_BTN_H / 2));
    y += SMALL_BTN_H + BLOCK_GAP;

    this._listOriginY = y;

    // --- bottom-justified: icon island → DISCORD (optional) → IMPORT ---
    const islandTotalH = islandH + BLUEPRINT_PAD * 2;
    const islandOriginX = centerX - islandW / 2;
    const islandOriginY = boxY + boxH - BOTTOM_MARGIN - islandTotalH + BLUEPRINT_PAD;
    this._drawIconIsland(islandOriginX, islandOriginY, islandW, islandH);

    const islandTopEdge = boxY + boxH - BOTTOM_MARGIN - islandTotalH;
    const hasDiscord = !!platform.canOpenExternal;
    let cursor = islandTopEdge - BLOCK_GAP;
    if (hasDiscord) {
      cursor -= SMALL_BTN_H;
      this._makeButton(centerX, cursor + SMALL_BTN_H / 2, bpW, SMALL_BTN_H, 'JOIN DISCORD',
        DISCORD_FILL, DISCORD_STROKE, '#ffffff',
        () => platform.openExternal(DISCORD_URL));
      cursor -= 10;
    }
    cursor -= BTN_H;
    this._makeButton(centerX, cursor + BTN_H / 2, bpW, BTN_H, 'IMPORT LEVEL',
      PRIMARY_FILL, PRIMARY_STROKE, PRIMARY_TEXT,
      () => this._openImportPicker());
    this._listBottom = cursor - BLOCK_GAP;
  }

  // ---------- chrome draws ----------

  _drawHeaderBox(cx, cy, w, h, label) {
    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(HEADER_FRAME_FILL, 1);
    gfx.lineStyle(2, HEADER_FRAME_STROKE, 1);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, HEADER_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, HEADER_CORNER_R);
    this._gfx.push(gfx);
    const t = this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: HEADER_TEXT_COLOR,
    }).setOrigin(0.5).setDepth(11);
    this._texts.push(t);
  }

  _makeButton(cx, cy, w, h, label, fill, stroke, textColor, onTap) {
    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(fill, 1);
    gfx.lineStyle(2, stroke, 1);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, BTN_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, BTN_CORNER_R);
    this._gfx.push(gfx);
    const t = this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: textColor, letterSpacing: 1,
    }).setOrigin(0.5).setDepth(11);
    this._texts.push(t);
    const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
      .setInteractive({ useHandCursor: true }).setDepth(12);
    hit.on('pointerup', onTap);
    this._hits.push(hit);
    return { gfx, t, hit };
  }

  _drawSearchBox(cx, cy, w, h) {
    const gfx = this.add.graphics().setDepth(10);
    gfx.fillStyle(SEARCH_FILL, 1);
    gfx.lineStyle(2, SEARCH_STROKE, 1);
    gfx.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, BTN_CORNER_R);
    gfx.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, BTN_CORNER_R);
    this._gfx.push(gfx);
    const label = this._query || 'search by name…';
    const color = this._query ? SEARCH_TEXT : SEARCH_EMPTY;
    this.searchPlaceholder = this.add.text(cx - w / 2 + 14, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', color,
    }).setOrigin(0, 0.5).setDepth(11);
    this._texts.push(this.searchPlaceholder);
    const hit = this.add.rectangle(cx, cy, w, h, 0xffffff, 0)
      .setInteractive({ useHandCursor: true }).setDepth(12);
    hit.on('pointerup', () => this._openSearchInput(cx, cy, w, h));
    this._hits.push(hit);
    this._searchCfg = { cx, cy, w, h };
  }

  _drawIconIsland(originX, originY, islandW, islandH) {
    const frame = this.add.graphics().setDepth(10);
    frame.x = originX; frame.y = originY;
    frame.fillStyle(BLUEPRINT_BG, 1);
    frame.lineStyle(2, BLUEPRINT_STROKE, 1);
    frame.fillRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    frame.strokeRoundedRect(-BLUEPRINT_PAD, -BLUEPRINT_PAD, islandW + BLUEPRINT_PAD * 2, islandH + BLUEPRINT_PAD * 2, BLUEPRINT_RADIUS);
    this._gfx.push(frame);

    // Two slots — HOME + SETTINGS.
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

  // ---------- search + filter ----------

  _openSearchInput(cx, cy, w, h) {
    if (this._searchInput) { this._searchInput.destroy(); this._searchInput = null; }
    this._searchInput = new TextInputOverlay(this, {
      x: cx, y: cy, width: w, height: h,
      value: this._query || '',
      placeholder: 'search by name…',
      maxLength: 40,
      onCommit: (v) => {
        this._query = (v || '').trim();
        if (this.searchPlaceholder) {
          this.searchPlaceholder
            .setText(this._query || 'search by name…')
            .setColor(this._query ? SEARCH_TEXT : SEARCH_EMPTY);
        }
        this._page = 0;
        this._renderList();
        this._searchInput = null;
      },
      onCancel: () => { this._searchInput = null; },
    });
  }

  _openEditorModePicker() {
    if (this._modePicker) return;
    this._modePicker = new EditorModePicker(this, {
      onPick: ({ bossMode, stageCount }) => {
        this._modePicker = null;
        fadeTo(this, 'Editor', { designerMode: true, bossMode, stageCount });
      },
      onClose: () => { this._modePicker = null; },
    });
  }

  _toggleFilterMenu(anchorX, anchorY) {
    if (this._filterMenu) { this._closeFilterMenu(); return; }
    this._renderFilterMenu(anchorX, anchorY);
  }

  _renderFilterMenu(anchorX, anchorY) {
    this._closeFilterMenu();
    // Top 5 are always shown; the rest appear only when the user taps
    // the expander. Once expanded, the choice sticks for the session so
    // hopping through the menu feels stable.
    const expanded = !!this._filterMenuExpanded;
    const rows = expanded ? [...FILTER_TOP, ...FILTER_MORE] : FILTER_TOP.slice();
    // Always end with an expander row.
    rows.push({ expand: true });

    const w = 230, rowH = 32, dividerH = 10, pad = 6;
    const menuH = pad * 2 + rows.reduce((s, r) => s + (r.divider ? dividerH : rowH), 0);
    const px = Math.max(8, Math.min(this.scale.width - w - 8, anchorX - w / 2));
    const py = Math.max(8, Math.min(this.scale.height - menuH - 8, anchorY + 6));

    const shield = this.add.rectangle(this.scale.width / 2, this.scale.height / 2,
      this.scale.width, this.scale.height, 0x000000, 0).setDepth(8000).setInteractive();
    const panel = this.add.graphics().setDepth(8001);
    panel.fillStyle(0xffffff, 1);
    panel.lineStyle(2, 0x1a2332, 1);
    panel.fillRoundedRect(px, py, w, menuH, 10);
    panel.strokeRoundedRect(px, py, w, menuH, 10);

    const items = [];
    const dividers = [];
    let cy = py + pad + rowH / 2;
    for (const row of rows) {
      if (row.divider) {
        const line = this.add.graphics().setDepth(8001);
        line.lineStyle(1, 0xdbe3ee, 1);
        const y = cy - rowH / 2 + dividerH / 2;
        line.beginPath();
        line.moveTo(px + pad + 4, y);
        line.lineTo(px + w - pad - 4, y);
        line.strokePath();
        dividers.push(line);
        cy += dividerH;
        continue;
      }
      const rect = this.add.rectangle(px + w / 2, cy, w - pad * 2, rowH - 2, 0xffffff, 1)
        .setStrokeStyle(1, 0x1a2332, 0.4)
        .setInteractive({ useHandCursor: true })
        .setDepth(8001);
      let label;
      let color = '#1a2332';
      if (row.expand) {
        label = expanded ? '\u25B4 Show less' : '\u25BE Show more';
        color = '#3b66b8';
      } else {
        const active = (row.filter && row.filter === this._filter)
                    || (row.sort   && row.sort   === this._sort);
        label = (active ? '\u2713 ' : '') + row.label;
      }
      const text = this.add.text(px + w / 2, cy, label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold',
        color,
      }).setOrigin(0.5).setDepth(8001);
      rect.on('pointerover', () => rect.setFillStyle(0xeef3fb, 1));
      rect.on('pointerout',  () => rect.setFillStyle(0xffffff, 1));
      rect.on('pointerup', () => {
        if (row.expand) {
          this._filterMenuExpanded = !expanded;
          this._renderFilterMenu(anchorX, anchorY);
          return;
        }
        if (row.filter) this._filter = row.filter;
        if (row.sort)   this._sort   = row.sort;
        this._page = 0;
        this._closeFilterMenu();
        this._renderList();
      });
      items.push({ rect, text });
      cy += rowH;
    }
    shield.on('pointerdown', () => this._closeFilterMenu());
    this._filterMenu = { shield, panel, items, dividers };
  }

  _closeFilterMenu() {
    if (!this._filterMenu) return;
    this._filterMenu.shield.destroy();
    this._filterMenu.panel.destroy();
    for (const { rect, text } of this._filterMenu.items) { rect.destroy(); text.destroy(); }
    for (const g of (this._filterMenu.dividers || [])) g.destroy();
    this._filterMenu = null;
  }

  // ---------- import + toast ----------

  _openImportPicker() {
    if (this._importModal) { this._importModal.destroy(); this._importModal = null; }
    this._importModal = new ImportModal(this, {
      onImport: async (stamped) => {
        this._toast(`Imported "${stamped.name || 'untitled'}"`);
        await this._refreshLevels();
      },
      onClose: () => { this._importModal = null; },
    });
  }

  // Produce a shareable deep-link for any finished level.
  //   - Remote approved levels → short `?level=<id>` (server-resident).
  //   - Local finished levels (private/pending/imported) → shortener
  //     call with a `?play=<b64>` fallback when the API can't respond.
  async _buildShareUrl(level) {
    if (level.origin === 'remote' && level.id) {
      return `https://www.block-yard.com/?level=${encodeURIComponent(level.id)}`;
    }
    const shareString = encodeShareForClient(level);
    let code = null;
    try { code = await platform.shortenShareCode(shareString); } catch (e) {}
    const base = 'https://www.block-yard.com';
    return code
      ? `${base}/?s=${encodeURIComponent(code)}`
      : `${base}/?play=${encodeURIComponent(shareString)}`;
  }

  async _shareLevelLink(level) {
    this._toast('Preparing share link\u2026');
    const url = await this._buildShareUrl(level);
    const ok = `Share link copied${level.name ? ` — ${level.name}` : ''}`;
    copyText(url).then(
      () => this._toast(ok),
      () => this._toast('Could not copy link'),
    );
  }

  // Per-card dropdown. Rendered at the kebab button's world position so
  // it aligns under the ⋮ regardless of scroll offset. Closes on outside
  // tap, on item tap, or when the list is re-rendered (new search page,
  // refresh, etc.) via _closeMoreMenu.
  _openMoreMenu(anchorX, anchorY, items) {
    this._closeMoreMenu();
    if (!items || !items.length) return;

    const rowH = 34;
    const pad = 6;
    const w = 180;
    const h = pad * 2 + rowH * items.length;

    // Pin the menu to the right edge of the kebab button and drop below
    // it; clamp so it never bleeds past the viewport.
    const px = Math.max(8, Math.min(this.scale.width - w - 8, anchorX - w + 14));
    const py = Math.max(8, Math.min(this.scale.height - h - 8, anchorY + 22));

    const shield = this.add.rectangle(this.scale.width / 2, this.scale.height / 2,
      this.scale.width, this.scale.height, 0x000000, 0)
      .setDepth(9500).setInteractive();
    const panel = this.add.graphics().setDepth(9501);
    panel.fillStyle(0xffffff, 1);
    panel.lineStyle(2, 0x1a2332, 1);
    panel.fillRoundedRect(px, py, w, h, 10);
    panel.strokeRoundedRect(px, py, w, h, 10);

    const rowElements = items.map((item, i) => {
      const cy = py + pad + rowH / 2 + i * rowH;
      const rect = this.add.rectangle(px + w / 2, cy, w - pad * 2, rowH - 2, 0xffffff, 1)
        .setStrokeStyle(1, 0x1a2332, 0.4)
        .setInteractive({ useHandCursor: true })
        .setDepth(9502);
      const text = this.add.text(px + pad + 10, cy, item.label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold',
        color: item.destructive ? '#b32727' : '#1a2332',
      }).setOrigin(0, 0.5).setDepth(9502);
      rect.on('pointerover', () => rect.setFillStyle(0xeef3fb, 1));
      rect.on('pointerout',  () => rect.setFillStyle(0xffffff, 1));
      rect.on('pointerup', () => {
        this._closeMoreMenu();
        try { item.onTap && item.onTap(); } catch (e) { console.warn('[community] menu action failed', e); }
      });
      return { rect, text };
    });
    shield.on('pointerdown', () => this._closeMoreMenu());
    this._moreMenu = { shield, panel, rowElements };
  }

  _closeMoreMenu() {
    if (!this._moreMenu) return;
    this._moreMenu.shield.destroy();
    this._moreMenu.panel.destroy();
    for (const { rect, text } of this._moreMenu.rowElements) { rect.destroy(); text.destroy(); }
    this._moreMenu = null;
  }

  // Hand any finished level to the shared native-share helper. Remote
  // summaries need a fetch to recover the full body; local levels
  // already carry everything the helper needs.
  async _nativeShareAny(level) {
    let body = level;
    if (level.origin === 'remote') {
      const res = await platform.fetchLevel(level.id).catch(() => null);
      body = res && res.level;
      if (!body) { this._toast('Could not fetch level — try again later'); return; }
    }
    // The helper expects a share-string; encode the body the same way
    // ExportPanel does so the `?play=<b64>` fallback works. Our encoding
    // strips the runtime-only fields inside socialShare.js's helper.
    const shareString = encodeShareForClient(body);
    await nativeShareLevel({
      scene: this,
      level: { ...body, name: level.name, author: level.author },
      shareString,
      onStatus: (msg) => { if (msg) this._toast(msg); },
    });
  }

  // Post-play rating prompt. Opens RateLevelModal; on submit, fires
  // platform.rateLevel and refreshes the list so the new average shows up
  // on the card. Skip is a no-op.
  _showRatingPrompt({ id, name }) {
    if (this._rateModal) { this._rateModal.destroy(); this._rateModal = null; }
    this._rateModal = new RateLevelModal(this, {
      levelName: name,
      onSubmit: async (stars) => {
        this._rateModal = null;
        try {
          await platform.rateLevel(id, stars);
          this._toast(`Thanks! Rated \u2605 ${stars}`);
          await this._refreshLevels();
          this._renderList();
        } catch (e) {
          this._toast('Could not save rating — try again later');
        }
      },
      onSkip: () => { this._rateModal = null; },
    });
  }

  // Local-only toggle. The hidden set is per-device so each player can
  // curate their own feed without touching anyone else's view. We fire
  // and forget the refresh — waiting on persistIndex isn't user-visible.
  async _hideLevel(id, name) {
    await toggleHide(id);
    this._hidden = await getHidden();
    this._toast(`Hid "${name || 'level'}" — show it again via filter \u2192 Hidden only`);
    this._renderList();
  }

  // Confirm-before-destroy. For remote entries owned by this device we
  // also call the API so the level disappears from the public feed; for
  // local-only drafts there's nothing on the server to tell.
  _confirmDelete(level) {
    if (this._confirmModal) { this._confirmModal.destroy(); this._confirmModal = null; }
    const isRemote = level.origin === 'remote';
    const message = isRemote
      ? 'This will remove the level from the community feed for everyone. This cannot be undone.'
      : 'This will remove the level from your device. This cannot be undone.';
    this._confirmModal = new ConfirmModal(this, {
      title: 'DELETE LEVEL?',
      message,
      confirmLabel: 'DELETE',
      cancelLabel:  'CANCEL',
      destructive:  true,
      onConfirm: async () => {
        this._confirmModal = null;
        await this._deleteLevel(level);
      },
      onCancel: () => { this._confirmModal = null; },
    });
  }

  async _deleteLevel(level) {
    const id = level.id;
    const isRemote = level.origin === 'remote';
    let remoteOk = true;
    // Publish-owned remote copies need a server delete; best-effort so a
    // cold API doesn't leave the local state stale when we already wiped
    // the on-device index.
    if (isRemote || this._localIds.has(id)) {
      remoteOk = await platform.deleteRemoteLevel(id);
    }
    // Always clear locally — if we authored this level here it's tracked
    // in one of the local indexes; otherwise this is a safe no-op.
    try { await deleteLocalLevel(id); } catch (e) {}
    this._toast(remoteOk ? `Deleted "${level.name || 'level'}"` : 'Deleted locally — server delete failed');
    await this._refreshLevels();
  }

  _toast(message) {
    if (this._toastText) this._toastText.destroy();
    const y = (this._listBottom || (this.scale.height - 80)) - 8;
    this._toastText = this.add.text(this._centerX || this.scale.width / 2, y, message, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#e6edf5',
      backgroundColor: '#1a2332', padding: { x: 12, y: 6 },
    }).setOrigin(0.5, 1).setDepth(9500);
    this.tweens.add({
      targets: this._toastText, alpha: 0, duration: 1600, delay: 1200,
      onComplete: () => { if (this._toastText) { this._toastText.destroy(); this._toastText = null; } },
    });
  }

  // ---------- level list ----------

  async _refreshLevels() {
    const local = await listAll();
    this._likes    = await getLikes();
    this._hidden   = await getHidden();
    this._localIds = await getLocalIds();

    // Remote fetch. `platform.searchLevels` returns `{ offline: true }` on a
    // failed fetch so we can flip the banner without losing the local list.
    // Page size is intentionally larger than the on-screen PAGE_SIZE — the
    // scene does its own client-side filtering and pagination on the merged
    // pool, and the backend stays a simple list endpoint.
    let remote = [];
    this._offline = false;
    try {
      const res = await platform.searchLevels({ pageSize: 50, sort: 'recent' });
      if (res && res.offline) this._offline = true;
      else if (res && Array.isArray(res.levels)) {
        remote = res.levels.map((e) => ({ ...e, origin: 'remote' }));
      }
    } catch (e) {
      this._offline = true;
    }

    // Merge: server copy wins on id collision (so a level you submitted
    // shows its real server-side like count once approved).
    const byId = new Map();
    for (const l of local) byId.set(l.id, l);
    for (const l of remote) byId.set(l.id, l);
    this._levels = [...byId.values()];
    this._renderList();
  }

  _renderList() {
    // Any per-card dropdown anchored at world coordinates becomes stale
    // the moment we rebuild — close it first.
    this._closeMoreMenu();
    // Tear down anything from the previous render — cards, the scroll
    // container + its mask, the load-more button, and the empty-state
    // placeholder.
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._loadMoreBtn) { this._destroyButton(this._loadMoreBtn); this._loadMoreBtn = null; }
    if (this._emptyText)   { this._emptyText.destroy(); this._emptyText = null; }
    if (this._offlineBanner) { this._offlineBanner.destroy(); this._offlineBanner = null; }
    if (this._scrollContainer) {
      try { this._scrollContainer.clearMask(true); } catch (e) {}
      this._scrollContainer.destroy(true);
      this._scrollContainer = null;
    }
    if (this._scrollCatch) { this._scrollCatch.destroy(); this._scrollCatch = null; }
    if (this._scrollMaskGfx) { this._scrollMaskGfx.destroy(); this._scrollMaskGfx = null; }
    this._destroyScrollbar();
    // Detach prior-render input listeners before we re-register — otherwise
    // each LOAD MORE leaves stale wheel/move/up handlers piling up.
    if (this._scrollWheelHandler) { this.input.off('wheel',        this._scrollWheelHandler); this._scrollWheelHandler = null; }
    if (this._scrollMoveHandler)  { this.input.off('pointermove',  this._scrollMoveHandler);  this._scrollMoveHandler  = null; }
    if (this._scrollUpHandler)    { this.input.off('pointerup',    this._scrollUpHandler);    this._scrollUpHandler    = null; }

    const filtered = applyFilter(this._levels, {
      query: this._query, filter: this._filter, sort: this._sort,
      likes: this._likes, hidden: this._hidden, localIds: this._localIds,
    });
    const endIdx = (this._page + 1) * PAGE_SIZE;
    const page = filtered.slice(0, endIdx);

    if (this._offlineBanner) { this._offlineBanner.destroy(); this._offlineBanner = null; }
    if (this._offline) {
      this._offlineBanner = this.add.text(this._centerX, this._listOriginY + 18,
        'community offline — showing local levels only', {
        fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'italic',
        color: '#ff9a5c',
      }).setOrigin(0.5, 0).setDepth(11);
    }

    if (page.length === 0) {
      const emptyY = this._listOriginY + (this._offline ? 48 : 40);
      this._emptyText = this.add.text(this._centerX, emptyY,
        'No community levels yet — design one or import a JSON.', {
        fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#e6edf5',
      }).setOrigin(0.5).setDepth(11);
      return;
    }

    const cardW = this._bpW;
    const cardX = this._centerX;
    const viewportTop    = this._listOriginY;
    const viewportBottom = this._listBottom || (viewportTop + 400);
    const viewportH      = Math.max(60, viewportBottom - viewportTop);

    // Scroll container holds every card + the LOAD MORE button. Its
    // y-offset shifts to reveal off-band content. Depth sits under the
    // chrome buttons but above the menu bg.
    this._scrollContainer = this.add.container(0, 0).setDepth(10);
    this._scrollOffset = 0;

    // Geometry mask clips the container to the band between the search
    // row and the footer so overflowing cards don't bleed past the
    // chrome. The mask graphic itself is NOT added to the scene — Phaser
    // uses it purely as a clipping source.
    this._scrollMaskGfx = this.make.graphics({ add: false });
    this._scrollMaskGfx.fillStyle(0xffffff, 1);
    this._scrollMaskGfx.fillRect(0, viewportTop, this.scale.width, viewportH);
    this._scrollContainer.setMask(this._scrollMaskGfx.createGeometryMask());

    // Build cards in absolute scene coordinates (container is at 0,0)
    // and reparent their pieces into the container. Keeps LevelCard
    // untouched while letting the whole list translate together.
    let stackY = viewportTop;
    for (let i = 0; i < page.length; i++) {
      const level = page[i];
      const cy = stackY + CARD_H / 2;
      const editable = level.origin === 'local' || level.origin === 'imported';
      const isRemote = level.origin === 'remote';
      // "Mine" = authored on this device (local/imported) OR published from
      // this device (remote entry whose id lives in our local index).
      const isMine    = editable || (isRemote && this._localIds.has(level.id));
      const canDelete = isMine;
      const canHide   = isRemote && !isMine;
      // "Finished" = past the unfinished-draft stage. That's the gate for
      // share affordances — you can't meaningfully share a level that
      // doesn't even have a valid solution yet.
      const isFinished = !!level.status && level.status !== 'unfinished';
      // Per-level dropdown items — pre-filtered here so LevelCard can
      // render the ⋮ button only when there's actually something in the
      // menu. Order reflects what appears in the open dropdown.
      const moreItems = [];
      if (editable) moreItems.push({
        label: 'Edit',
        onTap: () => fadeTo(this, 'Editor', { designerMode: true, levelId: level.id }),
      });
      if (isFinished) moreItems.push({
        label: 'Copy link',
        onTap: () => this._shareLevelLink(level),
      });
      if (canHide) moreItems.push({
        label: 'Hide',
        onTap: () => this._hideLevel(level.id, level.name),
      });
      if (canDelete) moreItems.push({
        label: 'Delete',
        onTap: () => this._confirmDelete(level),
        destructive: true,
      });

      const card = new LevelCard(this, {
        x: cardX, y: cy, width: cardW, height: CARD_H,
        level,
        liked: this._likes.has(level.id),
        onPlay: isRemote
          ? async () => {
              // Remote list entries are summaries only — fetch the full body
              // before handing it to the Player scene. If the server went
              // offline between render and tap, surface a toast instead of
              // stranding the player on a broken scene.
              const res = await platform.fetchLevel(level.id);
              const body = res && res.level;
              if (body) {
                fadeTo(this, 'Player', {
                  levelData: body,
                  communityId: level.id,
                  communityName: level.name,
                });
              } else {
                this._toast('Could not fetch level — try again later');
              }
            }
          : () => fadeTo(this, 'Player', { levelData: level }),
        onToggleLike: async () => {
          // Optimistic local toggle first so the heart flips immediately.
          const next = await toggleLike(level.id);
          if (next) this._likes.add(level.id); else this._likes.delete(level.id);
          if (isRemote) {
            // Best-effort remote sync. If it fails we keep the optimistic
            // local state — the refresh on next entry will reconcile.
            try { await platform.likeLevel(level.id, next); }
            catch (e) { console.warn('[community] likeLevel failed', e); }
          }
          return next;
        },
        onNativeShare: isFinished
          ? () => this._nativeShareAny(level)
          : undefined,
        moreItems,
        onMore: moreItems.length > 0
          ? (ax, ay) => this._openMoreMenu(ax, ay, moreItems)
          : undefined,
      });
      for (const p of LevelCard.pieces(card)) this._scrollContainer.add(p);
      this._cards.push(card);
      stackY += CARD_H + CARD_GAP;
    }

    // LOAD MORE tile — always rendered so the user can keep pulling in
    // more levels as the backend catalog grows. Taps bump the page.
    const loadMoreCY = stackY + SMALL_BTN_H / 2;
    this._loadMoreBtn = this._makeButton(cardX, loadMoreCY, 220, SMALL_BTN_H, 'LOAD MORE',
      MUTED_FILL, MUTED_STROKE, MUTED_TEXT,
      () => this._loadMore());
    for (const p of [this._loadMoreBtn.gfx, this._loadMoreBtn.t, this._loadMoreBtn.hit]) {
      if (p) this._scrollContainer.add(p);
    }
    stackY += SMALL_BTN_H + CARD_GAP;

    // Drag-to-scroll surface — transparent rect under the cards. Cards'
    // own interactive buttons (PLAY/EDIT/heart) sit on top and get their
    // clicks first; pointer-down on empty space falls through to this
    // catcher and starts a scroll drag.
    const contentH = Math.max(0, stackY - viewportTop);
    this._scrollMin = Math.min(0, viewportH - contentH);
    this._scrollCatch = this.add.rectangle(this._centerX, viewportTop + viewportH / 2,
      cardW, viewportH, 0xffffff, 0)
      .setInteractive({ useHandCursor: false })
      .setDepth(9);
    this._wireScrollInput(cardW, viewportTop, viewportBottom);

    // Scrollbar — drawn only when the content actually overflows the
    // viewport. Sits outside the right edge of the card column with a
    // visible gap so it reads as a separate UI element rather than an
    // extension of the cards.
    this._renderScrollbar(cardX + cardW / 2 + 22, viewportTop, viewportH, contentH);
  }

  // Thin vertical scrollbar with a thumb proportional to the visible
  // fraction of the list. Re-rendered from scratch on every _renderList
  // pass; position tracked via _setScrollOffset.
  _renderScrollbar(x, viewportTop, viewportH, contentH) {
    this._destroyScrollbar();
    if (contentH <= viewportH + 0.5) return;   // fits — no bar needed

    const TRACK_W        = 20;
    const TRACK_FILL     = 0xffffff;
    const TRACK_ALPHA    = 0.92;
    const TRACK_STROKE   = 0x1a2332;
    const TRACK_STROKE_W = 2;
    const THUMB_FILL     = 0x3b66b8;   // menu-primary blue — high contrast vs the white track
    const THUMB_STROKE   = 0x1f3a74;
    const THUMB_STROKE_W = 2;
    const RADIUS         = TRACK_W / 2;
    const MIN_THUMB_H    = 52;

    const track = this.add.graphics().setDepth(11);
    track.fillStyle(TRACK_FILL, TRACK_ALPHA);
    track.lineStyle(TRACK_STROKE_W, TRACK_STROKE, 1);
    track.fillRoundedRect(x - TRACK_W / 2, viewportTop, TRACK_W, viewportH, RADIUS);
    track.strokeRoundedRect(x - TRACK_W / 2, viewportTop, TRACK_W, viewportH, RADIUS);

    // Track hit — clicking an empty stretch of the track jumps the
    // thumb's centre to that Y. Padded outward so mis-taps a few pixels
    // off the bar still register.
    const trackHit = this.add.rectangle(x, viewportTop + viewportH / 2, TRACK_W + 10, viewportH, 0xffffff, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(11);
    trackHit.on('pointerdown', (p) => this._onScrollbarTrackDown(p));

    const thumb = this.add.graphics().setDepth(12);
    const thumbH = Math.max(MIN_THUMB_H, Math.round(viewportH * (viewportH / contentH)));
    const maxThumbY = viewportTop + viewportH - thumbH;
    const thumbHit = this.add.rectangle(x, viewportTop + thumbH / 2, TRACK_W + 10, thumbH, 0xffffff, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(13);
    thumbHit.on('pointerdown', (p) => this._onScrollbarThumbDown(p));

    this._scrollbar = {
      track, trackHit, thumb, thumbHit,
      x, viewportTop, viewportH, contentH,
      thumbW: TRACK_W, thumbH, maxThumbY,
      thumbFill: THUMB_FILL, thumbStroke: THUMB_STROKE, thumbStrokeW: THUMB_STROKE_W,
      radius: RADIUS,
    };

    // Scene-level listeners that drive the drag. Kept separate from the
    // card-catcher's drag handlers so the two systems don't conflict.
    const moveHandler = (p) => this._onScrollbarMove(p);
    const upHandler   = () => { this._scrollbarDragOffset = null; };
    this.input.on('pointermove', moveHandler);
    this.input.on('pointerup',   upHandler);
    this._scrollbar.moveHandler = moveHandler;
    this._scrollbar.upHandler   = upHandler;

    this._scrollbarDragOffset = null;
    this._paintScrollThumb();
  }

  // Click on the track — jump the thumb so its centre lands on the
  // click, then start a drag so the user can continue dragging from
  // wherever they landed.
  _onScrollbarTrackDown(p) {
    const sb = this._scrollbar;
    if (!sb) return;
    this._scrollbarDragOffset = sb.thumbH / 2;
    this._setThumbCentreY(p.y);
  }

  // Pointerdown on the thumb — record WHERE inside the thumb the user
  // grabbed so subsequent moves preserve that grab point.
  _onScrollbarThumbDown(p) {
    const sb = this._scrollbar;
    if (!sb) return;
    const thumbY = this._currentThumbY();
    this._scrollbarDragOffset = p.y - thumbY;
  }

  _onScrollbarMove(p) {
    if (this._scrollbarDragOffset == null) return;
    const sb = this._scrollbar;
    if (!sb) return;
    const thumbY = p.y - this._scrollbarDragOffset;
    this._setScrollFromThumbY(thumbY);
  }

  _currentThumbY() {
    const sb = this._scrollbar;
    if (!sb) return 0;
    const range = Math.max(1e-6, -this._scrollMin);
    const t = Math.min(1, Math.max(0, -this._scrollOffset / range));
    return sb.viewportTop + t * (sb.maxThumbY - sb.viewportTop);
  }

  _setThumbCentreY(y) {
    const sb = this._scrollbar;
    if (!sb) return;
    this._setScrollFromThumbY(y - sb.thumbH / 2);
  }

  // Convert a proposed thumb-top Y to a scroll offset and apply it.
  // Clamps inside the viewport band; _setScrollOffset does the scroll
  // clamping + thumb repaint.
  _setScrollFromThumbY(thumbY) {
    const sb = this._scrollbar;
    if (!sb) return;
    const clampedY = Math.max(sb.viewportTop, Math.min(sb.maxThumbY, thumbY));
    const range = sb.maxThumbY - sb.viewportTop;
    const t = range > 0 ? (clampedY - sb.viewportTop) / range : 0;
    // scroll offset in [scrollMin, 0]. t=0 → top (offset=0); t=1 → bottom.
    this._setScrollOffset(t * this._scrollMin);
  }

  _paintScrollThumb() {
    const sb = this._scrollbar;
    if (!sb) return;
    const thumbY = this._currentThumbY();
    sb.thumb.clear();
    sb.thumb.fillStyle(sb.thumbFill, 1);
    sb.thumb.lineStyle(sb.thumbStrokeW, sb.thumbStroke, 1);
    sb.thumb.fillRoundedRect(sb.x - sb.thumbW / 2, thumbY, sb.thumbW, sb.thumbH, sb.radius);
    sb.thumb.strokeRoundedRect(sb.x - sb.thumbW / 2, thumbY, sb.thumbW, sb.thumbH, sb.radius);
    // Keep the thumb hit rect glued to the thumb so pointerdown on it
    // kicks off a drag from the right spot.
    if (sb.thumbHit) sb.thumbHit.setPosition(sb.x, thumbY + sb.thumbH / 2);
  }

  _destroyScrollbar() {
    const sb = this._scrollbar;
    if (!sb) return;
    if (sb.moveHandler) this.input.off('pointermove', sb.moveHandler);
    if (sb.upHandler)   this.input.off('pointerup',   sb.upHandler);
    try { sb.track.destroy();    } catch (e) {}
    try { sb.trackHit.destroy(); } catch (e) {}
    try { sb.thumb.destroy();    } catch (e) {}
    try { sb.thumbHit.destroy(); } catch (e) {}
    this._scrollbar = null;
    this._scrollbarDragOffset = null;
  }

  _loadMore() {
    // Tracks user intent — always bumps the page so newly-synced levels
    // show up on the next filter recompute even if the current filtered
    // set is already fully visible.
    this._page += 1;
    const prevOffset = this._scrollOffset || 0;
    this._renderList();
    // Preserve scroll position across a load-more so the user doesn't
    // jump back to the top; clamp to the new content's bounds.
    this._setScrollOffset(prevOffset);
  }

  _wireScrollInput(cardW, viewportTop, viewportBottom) {
    const inBand = (p) => p.y >= viewportTop && p.y <= viewportBottom;
    // Wheel (desktop / trackpad) — scales its raw deltaY down a bit so
    // a single flick doesn't blow past the whole list.
    const wheelHandler = (_pointer, _over, _dx, dy) => {
      if (!this._scrollContainer) return;
      this._setScrollOffset(this._scrollOffset - dy * 0.5);
    };
    this.input.on('wheel', wheelHandler);
    this._scrollWheelHandler = wheelHandler;

    // Touch / mouse drag on the catcher. Only starts a drag once the
    // pointer moves past a small threshold, so a tap on empty card gap
    // still gets clean pointer-up timing for nested buttons.
    let dragStartY = null;
    let dragging = false;
    const DRAG_THRESHOLD = 6;
    this._scrollCatch.on('pointerdown', (p) => {
      dragStartY = p.y;
      dragging = false;
    });
    const moveHandler = (p) => {
      if (dragStartY == null) return;
      const dy = p.y - dragStartY;
      if (!dragging && Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!dragging) dragging = true;
      dragStartY = p.y;
      this._setScrollOffset(this._scrollOffset + dy);
    };
    const upHandler = () => { dragStartY = null; dragging = false; };
    this.input.on('pointermove', moveHandler);
    this.input.on('pointerup',   upHandler);
    this._scrollMoveHandler = moveHandler;
    this._scrollUpHandler   = upHandler;
  }

  _setScrollOffset(next) {
    if (!this._scrollContainer) return;
    const max = 0;
    const min = this._scrollMin || 0;
    const clamped = Math.max(min, Math.min(max, next));
    if (clamped !== this._scrollOffset) this._closeMoreMenu();
    this._scrollOffset = clamped;
    this._scrollContainer.y = this._scrollOffset;
    this._paintScrollThumb();
  }

  // ---------- cleanup ----------

  _destroyChrome() {
    for (const g of this._gfx)   g.destroy();
    for (const h of this._hits)  h.destroy();
    for (const t of this._texts) t.destroy();
    this._gfx = []; this._hits = []; this._texts = [];
    this.searchPlaceholder = null;
  }

  _destroyButton(btn) {
    if (!btn) return;
    try { btn.gfx && btn.gfx.destroy(); } catch (e) {}
    try { btn.t   && btn.t.destroy();   } catch (e) {}
    try { btn.hit && btn.hit.destroy(); } catch (e) {}
  }

  _teardown() {
    if (this._searchInput) { this._searchInput.destroy(); this._searchInput = null; }
    if (this._importModal) { this._importModal.destroy(); this._importModal = null; }
    this._closeFilterMenu();
    this._destroyChrome();
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._loadMoreBtn) { this._destroyButton(this._loadMoreBtn); this._loadMoreBtn = null; }
    if (this._emptyText)   { this._emptyText.destroy(); this._emptyText = null; }
    if (this._offlineBanner) { this._offlineBanner.destroy(); this._offlineBanner = null; }
    if (this._toastText)   { this._toastText.destroy(); this._toastText = null; }
    // Scroll plumbing — drop the container + mask and detach the global
    // wheel / pointermove / pointerup listeners.
    if (this._scrollContainer) {
      try { this._scrollContainer.clearMask(true); } catch (e) {}
      this._scrollContainer.destroy(true);
      this._scrollContainer = null;
    }
    if (this._scrollCatch)   { this._scrollCatch.destroy(); this._scrollCatch = null; }
    if (this._scrollMaskGfx) { this._scrollMaskGfx.destroy(); this._scrollMaskGfx = null; }
    this._destroyScrollbar();
    if (this._scrollWheelHandler) { this.input.off('wheel',        this._scrollWheelHandler); this._scrollWheelHandler = null; }
    if (this._scrollMoveHandler)  { this.input.off('pointermove',  this._scrollMoveHandler);  this._scrollMoveHandler  = null; }
    if (this._scrollUpHandler)    { this.input.off('pointerup',    this._scrollUpHandler);    this._scrollUpHandler    = null; }
  }
}
