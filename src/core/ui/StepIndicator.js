// Three-box progress widget used in the editor title bar. Replaces the
// static level-name display with a visible place in the flow:
//
//   [ BLOCKS ] [ BLUEPRINT ] [ EXPORT ]
//
// State per step is a `{ reachable, current, isNew }` tuple:
//   • reachable  — user can tap this step to jump there.
//   • current    — the step the user is actively on (only one step at a time).
//   • isNew      — transient highlight; the pill gets a green outer ring until
//                  the user taps it or the step regresses back to unreachable.
//
// Visual mapping:
//   unreachable         → grey, alpha 0.35, not interactive
//   reachable + !current → grey, alpha 1.0
//   reachable + current  → green, alpha 1.0
//   + isNew (any reachable state) → extra green outer ring

const STEPS = [
  { key: 'blocks',    label: 'BLOCKS'    },
  { key: 'blueprint', label: 'BLUEPRINT' },
  { key: 'export',    label: 'EXPORT'    },
];

const FILL_CURRENT    = 0x4caf50;   // green — "you are here"
const FILL_AVAILABLE  = 0x9aa6b2;   // grey
const STROKE_BASE     = 0x1a2332;
const RING_COLOR      = 0x4caf50;   // "new, tap me" ring
const RING_WIDTH      = 4;
const BOX_STROKE_W    = 4;
const BOX_CORNER_R    = 12;
const MAX_BOX_H       = 64;

function normalizeState(state) {
  if (!state || typeof state !== 'object') return { reachable: false, current: false, isNew: false };
  return {
    reachable: !!state.reachable,
    current:   !!state.current,
    isNew:     !!state.isNew,
  };
}

export class StepIndicator {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {number}  opts.x         center x
   * @param {number}  opts.y         center y
   * @param {number}  opts.width     total width
   * @param {number}  opts.height    total height
   * @param {number}  [opts.depth]   z-depth for every child
   * @param {(key:string)=>void} [opts.onStep]
   * @param {Array<{reachable:boolean,current:boolean,isNew:boolean}>} [opts.states]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this.depth = opts.depth != null ? opts.depth : 100;
    this.states = (opts.states && opts.states.map(normalizeState))
      || [{ reachable: true, current: true, isNew: false }, { reachable: false, current: false, isNew: false }, { reachable: false, current: false, isNew: false }];
    this._build();
  }

  _build() {
    const { x, y, width, height } = this.opts;
    const gap = 8;
    const boxW = (width - gap * (STEPS.length - 1)) / STEPS.length;
    const boxH = Math.min(height, MAX_BOX_H);
    const leftX = x - width / 2;
    const cy = y;
    this._boxes = STEPS.map((step, i) => {
      const cx = leftX + boxW / 2 + i * (boxW + gap);
      // Paint the pill with graphics so we can round the corners. A
      // transparent hit-rect on top owns the pointer events so we don't
      // have to keep the graphics body interactive.
      const rect = this.scene.add.graphics().setDepth(this.depth);
      const text = this.scene.add.text(cx, cy, step.label, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: boxW >= 110 ? '18px' : '16px',
        fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5).setDepth(this.depth + 1);
      // Separate graphics for the "new" outer ring so it can be toggled
      // without rebuilding the rect or interfering with its fill.
      const ring = this.scene.add.graphics().setDepth(this.depth + 2);
      ring.setVisible(false);
      const hit = this.scene.add.rectangle(cx, cy, boxW, boxH, 0xffffff, 0).setDepth(this.depth + 3);
      hit.on('pointerup', () => {
        if (!this._isInteractive(i)) return;
        if (this.opts.onStep) this.opts.onStep(step.key);
      });
      return { rect, text, ring, hit, step, cx, cy, boxW, boxH };
    });
    this._applyStates();
  }

  _applyStates() {
    for (let i = 0; i < STEPS.length; i++) {
      const entry = this._boxes[i];
      const s = this.states[i];
      const interactive = s.reachable;
      const fill  = s.current ? FILL_CURRENT : FILL_AVAILABLE;
      const alpha = s.reachable ? 1.0 : 0.35;
      // Repaint the rounded pill from scratch — Phaser Graphics can't
      // mutate existing paths, so clear + redraw each state change.
      const half = entry.boxH / 2;
      const x0 = entry.cx - entry.boxW / 2;
      const y0 = entry.cy - half;
      entry.rect.clear();
      entry.rect.fillStyle(fill, alpha);
      entry.rect.lineStyle(BOX_STROKE_W, STROKE_BASE, alpha);
      entry.rect.fillRoundedRect(x0, y0, entry.boxW, entry.boxH, BOX_CORNER_R);
      entry.rect.strokeRoundedRect(x0, y0, entry.boxW, entry.boxH, BOX_CORNER_R);
      entry.text.setColor('#ffffff');
      entry.text.setAlpha(alpha);
      if (interactive) entry.hit.setInteractive({ useHandCursor: true });
      else             entry.hit.disableInteractive();
      // Green "look here" ring — only when isNew AND reachable (ringing an
      // unreachable pill would be misleading).
      if (s.isNew && s.reachable) {
        entry.ring.clear();
        entry.ring.lineStyle(RING_WIDTH, RING_COLOR, 1);
        entry.ring.strokeRoundedRect(
          x0 - RING_WIDTH,
          y0 - RING_WIDTH,
          entry.boxW + RING_WIDTH * 2,
          entry.boxH + RING_WIDTH * 2,
          BOX_CORNER_R + RING_WIDTH,
        );
        entry.ring.setVisible(true);
      } else {
        entry.ring.clear();
        entry.ring.setVisible(false);
      }
    }
  }

  _isInteractive(i) {
    const s = this.states[i];
    return !!(s && s.reachable);
  }

  setStates(states) {
    if (!Array.isArray(states) || states.length !== STEPS.length) return;
    this.states = states.map(normalizeState);
    this._applyStates();
  }

  destroy() {
    if (!this._boxes) return;
    for (const b of this._boxes) {
      b.rect.destroy(); b.text.destroy(); b.ring.destroy();
      if (b.hit) b.hit.destroy();
    }
    this._boxes = null;
  }
}

export const STEP_KEYS = STEPS.map((s) => s.key);
