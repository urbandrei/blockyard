import Phaser from 'phaser';
import { fadeIn, fadeTo } from '../ui/SceneFader.js';
import {
  fadeInAllLayers, fadeOutToLayerOne,
  fadeInCelebrationLayers, fadeOutCelebrationLayers,
} from '../audio/MusicEngine.js';
import { spawnFunnelFirework } from '../render/FunnelFirework.js';
import { drawShapeForm } from '../render/ShapeRenderer.js';
import { COLOR_HEX, FORMS, COLORS } from '../model/shape.js';
import { wireUiClicks, playSfxSound } from '../audio/sfx.js';
import { disableMenuBg } from '../ui/MenuBackground.js';
import {
  BOARD_GAP, SHAPE_SCALE,
  BUFFER_FILL, BUFFER_FILL_ALT,
  LASER_BRIGHT, LASER_GLOW,
} from '../constants.js';
import { renderInteriorFloor, renderFrameOutline, renderFrameShadow } from '../render/PlayAreaFrame.js';
import { renderBorder } from '../render/BorderRenderer.js';
import { renderFactoryBody } from '../render/FactoryBodyRenderer.js';
import { renderFunnels } from '../render/FunnelRenderer.js';
import { renderAcidPits } from '../render/AcidPitRenderer.js';
import { disposeBakedGeometryCache } from '../render/textures/atlas.js';

// End-game credits. Plays after the player beats level 40. Black
// backdrop, white scrolling credit lines, bursts of fireworks at random
// spots on screen, and the music engine fading in every layer for the
// celebratory full mix. Tap anywhere to return to Home.
//
// "Light" tone: warm shape art interspersed between text rows so the
// scroll reads as a fond send-off rather than a sober end-card.

const SCROLL_MS    = 38000;   // total time for the scroll to complete
const PAUSE_AFTER  = 4000;    // hold past the scroll end before auto-dismiss
const FIREWORK_MS  = 700;     // spawn cadence
const ART_SHAPES_PER_ROW = 5;
const ART_ROW_GAP        = 80;
const LINE_GAP           = 48;
const SECTION_TOP_PAD    = 30;

export default class CreditsScene extends Phaser.Scene {
  constructor() { super({ key: 'Credits' }); }

  create() {
    wireUiClicks(this);
    fadeIn(this);

    const { width, height } = this.scale;

    // Match the body / letterbox bg to the in-canvas color so the
    // dark backdrop reads as one continuous void out to the device
    // viewport edges.
    disableMenuBg();
    if (typeof document !== 'undefined') {
      const s = document.body.style;
      s.backgroundImage = '';
      s.backgroundSize = '';
      s.backgroundPosition = '';
      s.backgroundRepeat = '';
      s.backgroundAttachment = '';
      s.animation = '';
      s.backgroundColor = '#0a0a0e';
    }

    // Solid near-black backdrop covering the canvas.
    this.bg = this.add.rectangle(0, 0, width, height, 0x0a0a0e, 1)
      .setOrigin(0).setDepth(0);


    // Scrolling content lives in this container — starts off-screen below
    // and tweens upward over SCROLL_MS.
    this.scrollContainer = this.add.container(width / 2, height + 40).setDepth(10);

    let cy = 0;

    const addText = (txt, fontSize, isBold, color = '#ffffff') => {
      const t = this.add.text(0, cy, txt, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: `${fontSize}px`,
        fontStyle: isBold ? 'bold' : 'normal',
        color,
        align: 'center',
      }).setOrigin(0.5);
      this.scrollContainer.add(t);
      cy += LINE_GAP;
    };

    const addGap = (px) => { cy += px; };

    // ----- diorama row builders — each row is a real mini-level
    // rendered with the SAME functions PlayerScene + HomeScene use:
    // renderInteriorFloor + renderBorder + renderFactoryBody +
    // renderFunnels + renderFrameShadow + renderFrameOutline +
    // renderAcidPits. Buffer-ring cells are painted manually because
    // renderExteriorCheckers tiles to the entire scene; everything
    // else comes straight from the in-game renderers so the credits
    // are pixel-equivalent to what the player saw on the playfield.

    const addMiniLevelDiorama = (level, opts = {}) => {
      const pxCell = opts.pxCell || 28;
      const step = pxCell + BOARD_GAP;
      const w = level.board.cols * step - BOARD_GAP;
      const h = level.board.rows * step - BOARD_GAP;

      // wrap = the whole mini level container, positioned so its top-
      // left corner lines up with (-w/2, cy) in scrollContainer-local
      // coords — i.e. centered horizontally + sitting at the current
      // scroll Y. Children render in container-local cell coords.
      const wrap = this.add.container(-w / 2, cy);
      this.scrollContainer.add(wrap);

      // 1) Buffer-ring cells (perimeter brown checker). Done manually
      //    because the engine's renderExteriorCheckers fills the whole
      //    scene, which would obliterate the rest of the credits.
      const buf = this.add.graphics();
      for (let r = 0; r < level.board.rows; r++) {
        for (let c = 0; c < level.board.cols; c++) {
          const isBuffer = r === 0 || r === level.board.rows - 1
                        || c === 0 || c === level.board.cols - 1;
          if (!isBuffer) continue;
          const parity = (r + c) & 1;
          buf.fillStyle(parity ? BUFFER_FILL_ALT : BUFFER_FILL, 1);
          buf.fillRect(c * step, r * step, step, step);
        }
      }
      wrap.add(buf);

      // 2) Interior floor (peach checker) — straight from PlayAreaFrame.
      renderInteriorFloor(this, wrap, { board: level.board, pxCell });

      // 3) Acid pits (if any) — uses the same wobble helper as the player.
      if (level.acidPits && level.acidPits.length > 0) {
        renderAcidPits(this, wrap, level, { pxCell, pxGap: BOARD_GAP });
      }

      // 4) Border funnels (input/output triangles in the buffer).
      renderBorder(this, wrap, wrap, level, { pxCell, pxGap: BOARD_GAP });

      // 5) Factories — body + funnels via real renderers. Cells are
      //    in absolute board grid coords (anchor + local cell).
      for (const fac of level.factories) {
        const absCells = fac.cells.map((cc) => ({
          ...cc, r: fac.anchor.row + cc.r, c: fac.anchor.col + cc.c,
        }));
        const absFunnels = (fac.funnels || []).map((f) => ({
          ...f, r: fac.anchor.row + f.r, c: fac.anchor.col + f.c,
        }));
        renderFactoryBody(this, wrap, {
          cells: absCells, pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
          fill: fac.fill, stroke: fac.stroke,
        });
        if (absFunnels.length) {
          renderFunnels(this, wrap, absFunnels, {
            pxCell, pxGap: BOARD_GAP, scale: SHAPE_SCALE,
          });
        }
      }

      // 6) Frame shadow + outline (inner vignette + black border).
      renderFrameShadow(this, wrap, { board: level.board, pxCell });
      renderFrameOutline(this, wrap, { board: level.board, pxCell });

      // 7) Optional static laser beam — two collinear strokes (glow +
      //    bright core) between two cells, matching LaserRenderer's
      //    palette. Subtle alpha pulse so it reads as "actively firing"
      //    instead of a flat decoration.
      const beam = opts.laser;
      if (beam) {
        const fromX = beam.fromC * step + pxCell / 2;
        const fromY = beam.fromR * step + pxCell / 2;
        const toX   = beam.toC   * step + pxCell / 2;
        const toY   = beam.toR   * step + pxCell / 2;
        const bg = this.add.graphics();
        bg.lineStyle(Math.max(4, Math.floor(pxCell * 0.22)), LASER_GLOW, 0.45);
        bg.lineBetween(fromX, fromY, toX, toY);
        bg.lineStyle(Math.max(2, Math.floor(pxCell * 0.09)), LASER_BRIGHT, 1);
        bg.lineBetween(fromX, fromY, toX, toY);
        wrap.add(bg);
        this.tweens.add({
          targets: bg, alpha: { from: 0.78, to: 1 },
          duration: 580, ease: 'Sine.InOut', yoyo: true, repeat: -1,
        });
      }

      // 8) Optional flowing shape — animates a shape graphic from one
      //    border funnel to another, looping. Pure cosmetic tween, no
      //    real Simulation involved.
      const flow = opts.flow;
      if (flow && level.border && level.border.funnels) {
        const fromF = level.border.funnels[flow.fromIdx];
        const toF   = level.border.funnels[flow.toIdx];
        if (fromF && toF) {
          const sx = fromF.c * step + pxCell / 2;
          const sy = fromF.r * step + pxCell / 2;
          const ex = toF.c   * step + pxCell / 2;
          const ey = toF.r   * step + pxCell / 2;
          const sh = this.add.graphics();
          sh.fillStyle(COLOR_HEX[flow.color] || COLOR_HEX.blue, 1);
          sh.lineStyle(Math.max(2, Math.floor(pxCell * 0.10)), 0x000000, 1);
          drawShapeForm(sh, Math.round(pxCell * 0.30), flow.form || 'circle');
          sh.x = sx; sh.y = sy;
          wrap.add(sh);
          this.tweens.add({
            targets: sh,
            x: ex, y: ey,
            duration: flow.duration || 2400,
            ease: 'Sine.InOut',
            repeat: -1,
            yoyo: false,
            onRepeat: () => { sh.x = sx; sh.y = sy; },
          });
        }
      }

      cy += h + 30;
    };

    // ----- the actual mini-levels rendered between credit text rows.

    // A simple 1-cell factory passing a blue circle top → bottom.
    const buildPassThroughLevel = (fill = 0x5a5f66, stroke = 0x14161a) => ({
      board: { cols: 5, rows: 5 },
      factories: [{
        id: 'pass', anchor: { row: 2, col: 2 },
        cells: [{ r: 0, c: 0 }],
        funnels: [
          { r: 0, c: 0, side: 'top',    role: 'input'  },
          { r: 0, c: 0, side: 'bottom', role: 'output' },
        ],
        fill, stroke,
      }],
      border: { funnels: [
        { r: 0, c: 2, side: 'bottom', role: 'input'  },
        { r: 4, c: 2, side: 'top',    role: 'output' },
      ]},
      inputs:  [{ r: 0, c: 2, side: 'bottom', type: { form: 'circle', color: 'blue' } }],
      outputs: [{ r: 4, c: 2, side: 'top',    type: { form: 'circle', color: 'blue' } }],
      acidPits: [],
    });

    // Two-factory level with the right-side emitter firing into the
    // left-side collector — stand-in for the in-game laser ladder.
    const buildLaserLevel = () => ({
      board: { cols: 7, rows: 3 },
      factories: [
        { id: 'la', anchor: { row: 1, col: 2 }, cells: [{ r: 0, c: 0 }],
          funnels: [
            { r: 0, c: 0, side: 'left',  role: 'emitter' },
            { r: 0, c: 0, side: 'right', role: 'emitter' },
          ] },
        { id: 'lb', anchor: { row: 1, col: 4 }, cells: [{ r: 0, c: 0 }],
          funnels: [
            { r: 0, c: 0, side: 'left',  role: 'emitter' },
            { r: 0, c: 0, side: 'right', role: 'emitter' },
          ] },
      ],
      border: { funnels: [
        { r: 1, c: 6, side: 'left',  role: 'emitter'   },
        { r: 1, c: 0, side: 'right', role: 'collector' },
      ]},
      inputs: [], outputs: [], acidPits: [],
    });

    // Acid swamp mini level — interior pit changes a shape's color.
    const buildAcidLevel = () => ({
      board: { cols: 5, rows: 5 },
      factories: [],
      border: { funnels: [
        { r: 0, c: 2, side: 'bottom', role: 'input'  },
        { r: 4, c: 2, side: 'top',    role: 'output' },
      ]},
      inputs:  [{ r: 0, c: 2, side: 'bottom', type: { form: 'circle', color: 'blue' } }],
      outputs: [{ r: 4, c: 2, side: 'top',    type: { form: 'circle', color: 'green' } }],
      acidPits: [{ r: 2, c: 2, label: { color: 'green' } }],
    });

    // Calm "shape trio" rest beat — three colored shapes with a small
    // bob. Useful between the heavier mini-levels so the eye gets a break.
    const addShapeTrioRow = () => {
      const spacing = 70;
      const trio = [
        { form: 'circle',   color: 'red'   },
        { form: 'square',   color: 'blue'  },
        { form: 'triangle', color: 'green' },
      ];
      const startX = -((trio.length - 1) * spacing) / 2;
      for (let i = 0; i < trio.length; i++) {
        const { form, color } = trio[i];
        const fill = COLOR_HEX[color] || 0xffffff;
        const g = this.add.graphics();
        g.fillStyle(fill, 1);
        g.lineStyle(3, 0x000000, 1);
        drawShapeForm(g, 18, form);
        g.x = startX + i * spacing;
        g.y = cy;
        this.scrollContainer.add(g);
        this.tweens.add({
          targets: g, scale: { from: 1, to: 1.12 },
          duration: 800 + i * 120, ease: 'Sine.InOut',
          yoyo: true, repeat: -1,
        });
      }
      cy += ART_ROW_GAP;
    };

    // Convenience aliases for the credit content sequence below.
    const addFactoryFlowRow = (fill, stroke) => addMiniLevelDiorama(
      buildPassThroughLevel(fill, stroke),
      { flow: { fromIdx: 0, toIdx: 1, form: 'circle', color: 'blue', duration: 2400 } },
    );
    const addLaserRow   = () => addMiniLevelDiorama(buildLaserLevel(), {
      // Static beam from right-edge emitter through the two factories
      // to the left-edge collector — same row as the factories (r=1).
      laser: { fromR: 1, fromC: 6, toR: 1, toC: 0 },
    });
    const addAcidPitRow = () => addMiniLevelDiorama(
      buildAcidLevel(),
      { flow: { fromIdx: 0, toIdx: 1, form: 'circle', color: 'blue', duration: 3000 } },
    );

    // ----- credits content -----
    addGap(80);
    addText('THANK YOU', 60, true);
    addText('for playing', 26, false, '#cfd8dc');
    addGap(20);
    addShapeTrioRow();

    addText('A game by', 22, false, '#9aa6b2');
    addText('urbandrei', 38, true);
    addGap(20);
    addFactoryFlowRow(0x4caf50, 0x2e7a36);

    addGap(SECTION_TOP_PAD);
    addText('Guest designers', 22, false, '#9aa6b2');
    addText('p4songer', 28, true);
    addText('JayTeaGibs', 28, true);
    addGap(20);
    addLaserRow();

    addText('Sound design', 22, false, '#9aa6b2');
    addText('JayTeaGibs', 28, true);
    addGap(20);
    addAcidPitRow();

    addText('QA testing', 22, false, '#9aa6b2');
    addText('p4songer', 28, true);
    addText('JayTeaGibs', 28, true);
    addGap(20);
    addFactoryFlowRow(0xd94c4c, 0x7a1f1f);

    addGap(SECTION_TOP_PAD);
    addText('Made with Phaser', 22, false, '#cfd8dc');
    addText('Hosted on Wavedash', 22, false, '#cfd8dc');
    addGap(20);
    addShapeTrioRow();

    addText('Big thanks to everyone', 22, false, '#cfd8dc');
    addText('who played early builds', 22, false, '#cfd8dc');
    addGap(20);
    addLaserRow();

    addGap(40);
    addText('See you out there', 30, true);
    addGap(60);
    addText('Tap anywhere to return home', 18, false, '#9aa6b2');
    addGap(120);

    // Tween the whole stack upward at constant speed.
    this.tweens.add({
      targets: this.scrollContainer,
      y: -cy,
      duration: SCROLL_MS,
      ease: 'Linear',
    });

    // Fireworks layer — random spots, periodic spawns.
    this.fxContainer = this.add.container(0, 0).setDepth(20);
    this.fwTimer = this.time.addEvent({
      delay: FIREWORK_MS, loop: true,
      callback: () => {
        const x = 60 + Math.random() * (width - 120);
        const y = 100 + Math.random() * (height - 200);
        spawnFunnelFirework(this, this.fxContainer, { x, y, radius: 28 });
        playSfxSound(this.game, 'firework', { volume: 0.35 });
      },
    });
    // Kick off one immediate burst at the center.
    spawnFunnelFirework(this, this.fxContainer, { x: width / 2, y: height / 2, radius: 36 });
    playSfxSound(this.game, 'firework', { volume: 0.5 });

    // Full mix: every layer of the regular bed (1, 2, 3) audible AND
    // the celebration layers (5 + 6) gently fading in over a few
    // seconds. Layers 5 + 6 have been looping silently since boot, so
    // they're perfectly phase-locked with 1..3 the moment they swell.
    try { fadeInAllLayers(); } catch (e) {}
    // MUCH slower swell for credits — layers 5 + 6 don't reach full
    // volume until the player is well into the scroll, so the credits
    // anthem feels like it's gradually building rather than slamming in.
    try { fadeInCelebrationLayers(15000); } catch (e) {}

    // Tap-to-dismiss. Also auto-dismiss after the scroll plus a pause.
    this.input.on('pointerdown', () => this._dismiss());
    this.time.delayedCall(SCROLL_MS + PAUSE_AFTER, () => this._dismiss());

    this.events.once('shutdown', () => {
      try { disposeBakedGeometryCache(this); } catch (e) { /* ignore */ }
      if (this.fwTimer) try { this.fwTimer.remove(false); } catch (e) {}
    });
  }

  _dismiss() {
    if (this._dismissing) return;
    this._dismissing = true;
    // Fade the celebration cues out gently and the bed back to layer 1
    // only — Home arrives with the standard resting mix instead of the
    // full swell from the credits.
    try { fadeOutCelebrationLayers(); } catch (e) {}
    try { fadeOutToLayerOne(); } catch (e) {}
    fadeTo(this, 'Home');
  }
}
