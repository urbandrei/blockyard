// Pointer-gesture controller for the editor's draw grid. Handles three
// distinct gestures:
//
//   • Tap on an empty draw-grid cell   → toggle cell (add if 4-adjacent).
//   • Tap on a filled cell w/o motion  → toggle cell off (contiguity-checked).
//   • Press-drag from a filled cell    → drag the whole shape to the board.
//   • Tap on a perimeter edge strip    → cycle funnel role.
//
// Callers wire callbacks for each resolved gesture. The controller does not
// know about the data model; it's purely a pointer state machine.

import { playOnce } from '../audio/sfx.js';

const DRAG_THRESHOLD = 6;

export class DragController {
  constructor(scene, {
    isOverCell,           // (x, y) => { r, c } | null
    isOverEdge,           // (x, y) => { r, c, side } | null
    isOverBoardCell,      // (x, y) => { r, c } | null
    onToggleCell,         // ({ r, c }) => void
    onToggleFunnel,       // ({ r, c, side }) => void
    onDragStart,          // ({ grabR, grabC }) => void
    onDragMove,           // (x, y) => void (over board / else)
    onDragEnd,            // ({ boardRC | null }) => void
    canDrag,              // ({ r, c }) => boolean (grab must be on a filled cell)
    isPlaying,            // () => boolean (short-circuits everything in play mode)
  }) {
    this.scene = scene;
    this.cbs = {
      isOverCell, isOverEdge, isOverBoardCell,
      onToggleCell, onToggleFunnel,
      onDragStart, onDragMove, onDragEnd,
      canDrag, isPlaying,
    };
    this.pending = null;
    this._bind();
  }

  destroy() {
    const input = this.scene.input;
    input.off('pointerdown', this._down, this);
    input.off('pointermove', this._move, this);
    input.off('pointerup', this._up, this);
    input.off('pointerupoutside', this._up, this);
  }

  _bind() {
    const input = this.scene.input;
    input.on('pointerdown', this._down, this);
    input.on('pointermove', this._move, this);
    input.on('pointerup', this._up, this);
    input.on('pointerupoutside', this._up, this);
  }

  _down(pointer) {
    if (this.cbs.isPlaying && this.cbs.isPlaying()) return;
    const edge = this.cbs.isOverEdge ? this.cbs.isOverEdge(pointer.x, pointer.y) : null;
    if (edge) {
      this.pending = { kind: 'edge', edge, startX: pointer.x, startY: pointer.y };
      playOnce(this.scene.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
      return;
    }
    const cell = this.cbs.isOverCell ? this.cbs.isOverCell(pointer.x, pointer.y) : null;
    if (cell) {
      this.pending = { kind: 'cell', cell, startX: pointer.x, startY: pointer.y, dragStarted: false };
      playOnce(this.scene.game, 'ui_click', { throttleMs: 100, volume: 0.5 });
    } else {
      this.pending = null;
    }
  }

  _move(pointer) {
    if (!this.pending) return;
    if (this.pending.kind !== 'cell') return;
    const dx = pointer.x - this.pending.startX;
    const dy = pointer.y - this.pending.startY;
    const canDrag = this.cbs.canDrag && this.cbs.canDrag(this.pending.cell);
    if (!this.pending.dragStarted && canDrag && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      this.pending.dragStarted = true;
      this.cbs.onDragStart && this.cbs.onDragStart({
        grabR: this.pending.cell.r,
        grabC: this.pending.cell.c,
        kind:  this.pending.cell.kind,
      });
    }
    if (this.pending.dragStarted) {
      this.cbs.onDragMove && this.cbs.onDragMove(pointer.x, pointer.y);
    }
  }

  _up(pointer) {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    if (this.cbs.isPlaying && this.cbs.isPlaying()) return;
    if (p.kind === 'edge' && !p.dragStarted) {
      this.cbs.onToggleFunnel && this.cbs.onToggleFunnel(p.edge);
      return;
    }
    if (p.kind === 'cell') {
      if (p.dragStarted) {
        const boardRC = this.cbs.isOverBoardCell ? this.cbs.isOverBoardCell(pointer.x, pointer.y) : null;
        // Scene decides the drop SFX (ui_click vs. rustle for a
        // delete-island drop) in onDragEnd — DragController stays
        // mute here so the two don't stack.
        this.cbs.onDragEnd && this.cbs.onDragEnd({ boardRC, pointer });
        return;
      }
      this.cbs.onToggleCell && this.cbs.onToggleCell(p.cell, pointer);
    }
  }
}
