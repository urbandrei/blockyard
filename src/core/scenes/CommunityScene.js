import Phaser from 'phaser';
import { listAll, applyFilter, getLikes, toggleLike } from '../community.js';
import { LevelCard } from '../ui/LevelCard.js';
import { TextInputOverlay } from '../ui/TextInputOverlay.js';
import { ImportModal } from '../ui/ImportModal.js';
import { platform } from '../../platform/index.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { enableMenuBg } from '../ui/MenuBackground.js';
import { compute920Box } from '../ui/ContentBox.js';
import { BOARD_GAP, BLUEPRINT_BG, BLUEPRINT_STROKE, BLUEPRINT_DOT } from '../constants.js';
import { drawHome } from '../ui/Icons.js';
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

const DISCORD_URL = 'https://discord.gg/TODO';   // TODO: swap for the real invite once it exists

const FILTER_OPTIONS = [
  { key: 'all',       label: 'All'              },
  { key: 'liked',     label: 'Liked only'       },
  { key: 'likesDesc', label: 'Sort: most liked' },
  { key: 'likesAsc',  label: 'Sort: least liked'},
];

export default class CommunityScene extends Phaser.Scene {
  constructor() { super({ key: 'Community' }); }

  async create() {
    enableMenuBg();
    fadeIn(this);

    this._levels = [];
    this._likes = new Set();
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

    this._onResize = () => this._relayout();
    this.scale.on('resize', this._onResize);
    this.events.on('shutdown', () => {
      if (this._onResize) this.scale.off('resize', this._onResize);
      this._teardown();
    });
  }

  _relayout() {
    this._destroyChrome();
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._showMoreBtn) { this._destroyButton(this._showMoreBtn); this._showMoreBtn = null; }
    if (this._emptyText)   { this._emptyText.destroy(); this._emptyText = null; }
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
      () => fadeTo(this, 'Editor', { designerMode: true }));
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

  _toggleFilterMenu(anchorX, anchorY) {
    if (this._filterMenu) { this._closeFilterMenu(); return; }
    const w = 200, rowH = 36, pad = 6;
    const h = pad * 2 + rowH * FILTER_OPTIONS.length;
    const px = Math.max(8, Math.min(this.scale.width - w - 8, anchorX - w / 2));
    const py = Math.max(8, Math.min(this.scale.height - h - 8, anchorY + 6));
    const shield = this.add.rectangle(this.scale.width / 2, this.scale.height / 2,
      this.scale.width, this.scale.height, 0x000000, 0).setDepth(8000).setInteractive();
    const panel = this.add.graphics().setDepth(8001);
    panel.fillStyle(0xffffff, 1);
    panel.lineStyle(2, 0x1a2332, 1);
    panel.fillRoundedRect(px, py, w, h, 10);
    panel.strokeRoundedRect(px, py, w, h, 10);
    const items = FILTER_OPTIONS.map((o, i) => {
      const cy = py + pad + rowH / 2 + i * rowH;
      const rect = this.add.rectangle(px + w / 2, cy, w - pad * 2, rowH - 2, 0xffffff, 1)
        .setStrokeStyle(1, 0x1a2332, 0.4)
        .setInteractive({ useHandCursor: true })
        .setDepth(8001);
      const isActive = (o.key === this._filter) || (o.key === this._sort);
      const text = this.add.text(px + w / 2, cy, (isActive ? '\u2713 ' : '') + o.label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold',
        color: '#1a2332',
      }).setOrigin(0.5).setDepth(8001);
      rect.on('pointerover', () => rect.setFillStyle(0xeef3fb, 1));
      rect.on('pointerout',  () => rect.setFillStyle(0xffffff, 1));
      rect.on('pointerup', () => {
        if (o.key === 'all' || o.key === 'liked') this._filter = o.key;
        else this._sort = o.key;
        this._page = 0;
        this._closeFilterMenu();
        this._renderList();
      });
      return { rect, text };
    });
    shield.on('pointerdown', () => this._closeFilterMenu());
    this._filterMenu = { shield, panel, items };
  }

  _closeFilterMenu() {
    if (!this._filterMenu) return;
    this._filterMenu.shield.destroy();
    this._filterMenu.panel.destroy();
    for (const { rect, text } of this._filterMenu.items) { rect.destroy(); text.destroy(); }
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
    this._levels = await listAll();
    this._likes = await getLikes();
    this._renderList();
  }

  _renderList() {
    // Tear down anything from the previous render — cards, the scroll
    // container + its mask, the load-more button, and the empty-state
    // placeholder.
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._loadMoreBtn) { this._destroyButton(this._loadMoreBtn); this._loadMoreBtn = null; }
    if (this._emptyText)   { this._emptyText.destroy(); this._emptyText = null; }
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
      query: this._query, filter: this._filter, sort: this._sort, likes: this._likes,
    });
    const endIdx = (this._page + 1) * PAGE_SIZE;
    const page = filtered.slice(0, endIdx);

    if (page.length === 0) {
      this._emptyText = this.add.text(this._centerX, this._listOriginY + 40,
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
      const card = new LevelCard(this, {
        x: cardX, y: cy, width: cardW, height: CARD_H,
        level,
        liked: this._likes.has(level.id),
        onPlay: () => fadeTo(this, 'Player', { levelData: level }),
        onToggleLike: async () => {
          const next = await toggleLike(level.id);
          if (next) this._likes.add(level.id); else this._likes.delete(level.id);
          return next;
        },
        onEdit: editable
          ? () => fadeTo(this, 'Editor', { designerMode: true, levelId: level.id })
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
    this._scrollOffset = Math.max(min, Math.min(max, next));
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
