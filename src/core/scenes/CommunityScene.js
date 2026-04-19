import Phaser from 'phaser';
import { listAll, applyFilter, getLikes, toggleLike } from '../community.js';
import { LevelCard } from '../ui/LevelCard.js';
import { TextInputOverlay } from '../ui/TextInputOverlay.js';
import { ImportModal } from '../ui/ImportModal.js';
import { platform } from '../../platform/index.js';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import { enableMenuBg } from '../ui/MenuBackground.js';

// Community hub. Top: header + LEVEL DESIGNER. Middle: search input +
// filter button + paginated list of LevelCards. Bottom: IMPORT LEVEL +
// Discord. Discord button is hidden when the platform adapter doesn't
// support opening external URLs (e.g., YouTube Playables).

const PAGE_SIZE = 5;
const DISCORD_URL = 'https://discord.gg/TODO';   // TODO: swap for the real invite once it exists

const CARD_H   = 88;
const CARD_GAP = 10;

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

    const { width, height } = this.scale;

    // Header.
    this.add.rectangle(width / 2, 36, width, 72, 0x1a2332, 1).setOrigin(0.5);
    this.add.text(width / 2, 36, 'COMMUNITY', {
      fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0.5);
    const back = this.add.rectangle(60, 36, 88, 44, 0x223047, 1)
      .setStrokeStyle(1, 0x3a5a88, 1)
      .setInteractive({ useHandCursor: true });
    this.add.text(60, 36, 'BACK', {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#e6edf5',
    }).setOrigin(0.5);
    back.on('pointerup', () => fadeTo(this, 'Home'));

    // LEVEL DESIGNER button.
    this._designerButton(width / 2, 110, 'LEVEL DESIGNER', () => {
      fadeTo(this, 'Editor', { designerMode: true });
    });

    // Search row.
    this._buildSearchRow(width, 180);

    // List anchor.
    this._listOriginY = 240;
    this._listMaxRows = 6;            // shown per page render
    this._page = 0;
    this._cards = [];
    this._levels = [];
    this._likes = new Set();
    this._query = '';
    this._filter = 'all';
    this._sort = 'recent';

    // Footer (IMPORT + Discord).
    this._buildFooter(width, height);

    await this._refreshLevels();

    this.events.on('shutdown', () => this._teardown());
  }

  _designerButton(cx, cy, label, onTap) {
    const w = 320, h = 56;
    const rect = this.add.rectangle(cx, cy, w, h, 0x3b66b8, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    this.add.text(cx, cy, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#ffffff', letterSpacing: 2,
    }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(0x4a76c8, 1));
    rect.on('pointerout',  () => rect.setFillStyle(0x3b66b8, 1));
    rect.on('pointerup', onTap);
  }

  _buildSearchRow(sceneW, y) {
    const inputW = 360, inputH = 40;
    const inputCX = sceneW / 2 - 60;
    // The text input itself is an HTML overlay — we draw a placeholder rect
    // here so users see where to tap.
    this.searchRect = this.add.rectangle(inputCX, y, inputW, inputH, 0xffffff, 1)
      .setStrokeStyle(2, 0x1a2332, 1)
      .setInteractive({ useHandCursor: true });
    this.searchPlaceholder = this.add.text(inputCX - inputW / 2 + 12, y,
      this._query || 'search by name…', {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px',
      color: this._query ? '#1a2332' : '#9aa6b2',
    }).setOrigin(0, 0.5);
    this.searchRect.on('pointerup', () => this._openSearchInput(inputCX, y, inputW, inputH));

    // Filter button.
    const filterW = 96;
    const filterCX = inputCX + inputW / 2 + 14 + filterW / 2;
    this.filterRect = this.add.rectangle(filterCX, y, filterW, inputH, 0x2a3b55, 1)
      .setStrokeStyle(2, 0x3a5a88, 1)
      .setInteractive({ useHandCursor: true });
    this.filterText = this.add.text(filterCX, y, 'FILTER', {
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
      color: '#e6edf5',
    }).setOrigin(0.5);
    this.filterRect.on('pointerup', () => this._toggleFilterMenu(filterCX, y + inputH));
  }

  _openSearchInput(cx, cy, w, h) {
    if (this._searchInput) { this._searchInput.destroy(); this._searchInput = null; }
    this._searchInput = new TextInputOverlay(this, {
      x: cx, y: cy, width: w, height: h,
      value: this._query || '',
      placeholder: 'search by name…',
      maxLength: 40,
      onCommit: (v) => {
        this._query = (v || '').trim();
        this.searchPlaceholder
          .setText(this._query || 'search by name…')
          .setColor(this._query ? '#1a2332' : '#9aa6b2');
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
      const text = this.add.text(px + w / 2, cy, (isActive ? '✓ ' : '') + o.label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold',
        color: '#1a2332',
      }).setOrigin(0.5).setDepth(8001);
      rect.on('pointerover', () => rect.setFillStyle(0xeef3fb, 1));
      rect.on('pointerout',  () => rect.setFillStyle(0xffffff, 1));
      rect.on('pointerup', () => {
        // 'all' / 'liked' set the filter; 'likesAsc/Desc' set the sort.
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

  _buildFooter(width, height) {
    const importY = height - 110;
    this._designerButton(width / 2, importY, 'IMPORT LEVEL', () => this._openImportPicker());

    if (platform.canOpenExternal) {
      const discordY = height - 50;
      const discord = this.add.rectangle(width / 2, discordY, 220, 40, 0x5865F2, 1)
        .setStrokeStyle(2, 0x1a2332, 1)
        .setInteractive({ useHandCursor: true });
      this.add.text(width / 2, discordY, 'JOIN DISCORD', {
        fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5);
      discord.on('pointerup', () => platform.openExternal(DISCORD_URL));
    }
  }

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
    this._toastText = this.add.text(this.scale.width / 2, this.scale.height - 160, message, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#e6edf5',
      backgroundColor: '#1a2332', padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(9500);
    this.tweens.add({
      targets: this._toastText, alpha: 0, duration: 1600, delay: 1200,
      onComplete: () => { if (this._toastText) { this._toastText.destroy(); this._toastText = null; } },
    });
  }

  async _refreshLevels() {
    this._levels = await listAll();
    this._likes = await getLikes();
    this._renderList();
  }

  _renderList() {
    for (const card of this._cards) card.destroy();
    this._cards = [];
    if (this._showMoreRect)  { this._showMoreRect.destroy();  this._showMoreRect = null; }
    if (this._showMoreText)  { this._showMoreText.destroy();  this._showMoreText = null; }
    if (this._emptyText)     { this._emptyText.destroy();     this._emptyText = null; }

    const filtered = applyFilter(this._levels, {
      query: this._query, filter: this._filter, sort: this._sort, likes: this._likes,
    });
    const startIdx = 0;                                   // pagination = "show more": grow window
    const endIdx = (this._page + 1) * PAGE_SIZE;
    const page = filtered.slice(startIdx, endIdx);

    if (page.length === 0) {
      this._emptyText = this.add.text(this.scale.width / 2, this._listOriginY + 40,
        'No community levels yet — design one or import a JSON.', {
        fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#9aa6b2',
      }).setOrigin(0.5);
      return;
    }

    const cardW = Math.min(560, this.scale.width - 60);
    const cardX = this.scale.width / 2;
    page.forEach((level, i) => {
      const cy = this._listOriginY + CARD_H / 2 + i * (CARD_H + CARD_GAP);
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
      this._cards.push(card);
    });

    if (filtered.length > endIdx) {
      const cy = this._listOriginY + CARD_H / 2 + page.length * (CARD_H + CARD_GAP);
      this._showMoreRect = this.add.rectangle(cardX, cy, 200, 36, 0x223047, 1)
        .setStrokeStyle(1, 0x3a5a88, 1).setInteractive({ useHandCursor: true });
      this._showMoreText = this.add.text(cardX, cy, 'SHOW MORE', {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#e6edf5',
      }).setOrigin(0.5);
      this._showMoreRect.on('pointerup', () => { this._page += 1; this._renderList(); });
    }
  }


  _teardown() {
    if (this._searchInput) { this._searchInput.destroy(); this._searchInput = null; }
    if (this._importModal) { this._importModal.destroy(); this._importModal = null; }
    this._closeFilterMenu();
    for (const card of this._cards) card.destroy();
    this._cards = [];
  }
}
