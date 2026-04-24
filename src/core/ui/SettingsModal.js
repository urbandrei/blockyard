// Settings modal — one panel, two horizontal volume sliders (music +
// SFX). Shares the visual vocabulary of ConfirmModal (shield + rounded
// panel + 1a2332 stroke). Values read + write through `audio/settings.js`
// so changes are live AND persisted.
//
//   new SettingsModal(scene, { onClose });

import {
  getMusicVolume, getSfxVolume, setMusicVolume, setSfxVolume,
} from '../audio/settings.js';
import { addDomDim } from './DomDim.js';

const SHIELD_DEPTH = 9000;
const PANEL_DEPTH  = 9001;
const SHIELD_COLOR = 0x000000;
const PANEL_FILL   = 0xffffff;
const PANEL_STROKE = 0x1a2332;
const TITLE_COLOR  = '#1a2332';
const LABEL_COLOR  = '#485566';
const TRACK_FILL   = 0xd6dde3;
const TRACK_STROKE = 0x1a2332;
const FILL_COLOR   = 0x3fa65a;
const KNOB_FILL    = 0xffffff;

const SLIDER_W = 280;
const SLIDER_H = 10;
const KNOB_R   = 14;

export class SettingsModal {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._closed = false;
    this._onClose = opts.onClose || null;

    const { width, height } = scene.scale;
    const panelW = Math.min(460, width - 60);
    const panelH = 300;
    const px = width / 2 - panelW / 2;
    const py = height / 2 - panelH / 2;

    // Dim the HTML letterbox so the dim looks continuous across the
    // whole viewport. The Phaser shield below dims the canvas itself.
    this._domDim = addDomDim({ alpha: 0.55 });
    this.shield = scene.add.rectangle(width / 2, height / 2, width, height, SHIELD_COLOR, 0.55)
      .setDepth(SHIELD_DEPTH).setInteractive();
    this.shield.on('pointerup', () => this._finish());

    this.panel = scene.add.graphics().setDepth(PANEL_DEPTH);
    this.panel.fillStyle(PANEL_FILL, 1);
    this.panel.lineStyle(3, PANEL_STROKE, 1);
    this.panel.fillRoundedRect(px, py, panelW, panelH, 18);
    this.panel.strokeRoundedRect(px, py, panelW, panelH, 18);

    this.title = scene.add.text(width / 2, py + 40, 'SETTINGS', {
      fontFamily: 'system-ui, sans-serif', fontSize: '22px', fontStyle: 'bold',
      color: TITLE_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    this.sliders = [];
    this.sliders.push(this._slider(width / 2, py + 110, 'Music', getMusicVolume(), setMusicVolume));
    this.sliders.push(this._slider(width / 2, py + 185, 'SFX',   getSfxVolume(),   setSfxVolume));

    // Close button.
    const buttonY = py + panelH - 44;
    this.closeBtn = this._button(width / 2, buttonY, 150, 46, 'CLOSE', () => this._finish());
  }

  _slider(cx, cy, label, initialValue, setter) {
    const scene = this.scene;
    const x0 = cx - SLIDER_W / 2;
    const y0 = cy;

    // Label above the track.
    const labelText = scene.add.text(cx, cy - 24, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontStyle: 'bold',
      color: LABEL_COLOR,
    }).setOrigin(0.5).setDepth(PANEL_DEPTH);

    // Track + fill + knob live in one container so a drag moves both.
    const track = scene.add.graphics().setDepth(PANEL_DEPTH);
    const fill  = scene.add.graphics().setDepth(PANEL_DEPTH);
    const knob  = scene.add.graphics().setDepth(PANEL_DEPTH + 1);

    // Hit zone a little taller than the track for easier grabbing.
    const hit = scene.add.rectangle(cx, y0, SLIDER_W + KNOB_R * 2, SLIDER_H + KNOB_R * 2, 0xffffff, 0.001)
      .setDepth(PANEL_DEPTH + 2).setInteractive({ useHandCursor: true });

    const percentText = scene.add.text(cx + SLIDER_W / 2 + 28, cy, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px',
      color: LABEL_COLOR,
    }).setOrigin(0, 0.5).setDepth(PANEL_DEPTH);

    const paint = (value) => {
      const v = Math.max(0, Math.min(1, value));
      track.clear();
      track.fillStyle(TRACK_FILL, 1);
      track.lineStyle(2, TRACK_STROKE, 1);
      track.fillRoundedRect(x0, y0 - SLIDER_H / 2, SLIDER_W, SLIDER_H, SLIDER_H / 2);
      track.strokeRoundedRect(x0, y0 - SLIDER_H / 2, SLIDER_W, SLIDER_H, SLIDER_H / 2);
      fill.clear();
      fill.fillStyle(FILL_COLOR, 1);
      const fw = Math.max(0, SLIDER_W * v);
      if (fw > 0) {
        fill.fillRoundedRect(x0, y0 - SLIDER_H / 2, fw, SLIDER_H, SLIDER_H / 2);
      }
      const kx = x0 + SLIDER_W * v;
      knob.clear();
      knob.fillStyle(KNOB_FILL, 1);
      knob.lineStyle(2, TRACK_STROKE, 1);
      knob.fillCircle(kx, y0, KNOB_R);
      knob.strokeCircle(kx, y0, KNOB_R);
      percentText.setText(`${Math.round(v * 100)}`);
    };

    const setFromPointer = (pointer) => {
      const t = Math.max(0, Math.min(1, (pointer.x - x0) / SLIDER_W));
      setter(t);
      paint(t);
    };

    let dragging = false;
    hit.on('pointerdown', (pointer) => { dragging = true; setFromPointer(pointer); });
    hit.on('pointermove', (pointer) => { if (dragging) setFromPointer(pointer); });
    hit.on('pointerup',   () => { dragging = false; });
    hit.on('pointerout',  () => { dragging = false; });

    paint(initialValue);
    return { labelText, track, fill, knob, hit, percentText };
  }

  _button(cx, cy, w, h, label, onTap) {
    const scene = this.scene;
    const container = scene.add.container(cx, cy).setDepth(PANEL_DEPTH);
    const bg = scene.add.graphics();
    const drawBg = (bgFill) => {
      bg.clear();
      bg.fillStyle(bgFill, 1);
      bg.lineStyle(2, PANEL_STROKE, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
    };
    drawBg(0x9aa6b2);
    container.add(bg);
    const text = scene.add.text(0, 0, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5);
    container.add(text);
    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    container.add(hit);
    hit.on('pointerover', () => drawBg(0xacb7c2));
    hit.on('pointerout',  () => drawBg(0x9aa6b2));
    hit.on('pointerup', (p, lx, ly, e) => {
      if (e) e.stopPropagation();
      onTap();
    });
    return { container, bg, text, hit };
  }

  _finish() {
    if (this._closed) return;
    this._closed = true;
    this.destroy();
    if (this._onClose) this._onClose();
  }

  destroy() {
    if (this._domDim) { try { this._domDim(); } catch (e) {} this._domDim = null; }
    if (this.shield) { try { this.shield.destroy(); } catch (e) {} this.shield = null; }
    if (this.panel)  { try { this.panel.destroy();  } catch (e) {} this.panel  = null; }
    if (this.title)  { try { this.title.destroy();  } catch (e) {} this.title  = null; }
    for (const s of (this.sliders || [])) {
      try { s.labelText.destroy(); } catch (e) {}
      try { s.track.destroy(); } catch (e) {}
      try { s.fill.destroy(); } catch (e) {}
      try { s.knob.destroy(); } catch (e) {}
      try { s.hit.destroy(); } catch (e) {}
      try { s.percentText.destroy(); } catch (e) {}
    }
    this.sliders = null;
    if (this.closeBtn) {
      try { this.closeBtn.container.destroy(true); } catch (e) {}
      this.closeBtn = null;
    }
  }
}
