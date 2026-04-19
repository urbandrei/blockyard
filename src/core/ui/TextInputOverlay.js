// DOM `<input>` overlay that floats over the Phaser canvas. Used for
// places where the player needs real text entry (Designer-mode level
// names, the author-handle prompt, the Community search box). Phaser's
// scene/camera coordinates are in logical-canvas space; we compute the
// CSS rect by reading the canvas' bounding client rect at open time.
//
// Lifecycle: `open()` mounts an absolutely-positioned `<input>` into
// document.body and focuses it; `commit` fires on Enter, `cancel` on Esc,
// and either fires on `blur`. The caller decides what to do with the value.
// `destroy()` (also auto-called after commit/cancel) removes the element.

const Z = 9050;

export class TextInputOverlay {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} opts
   * @param {string}  opts.value         initial text
   * @param {string}  opts.placeholder   placeholder when empty
   * @param {number}  opts.x             logical-canvas x (center)
   * @param {number}  opts.y             logical-canvas y (center)
   * @param {number}  opts.width         logical-canvas width
   * @param {number}  opts.height        logical-canvas height
   * @param {number}  [opts.maxLength=40]
   * @param {boolean} [opts.multiline=false]  render as <textarea>, commit on blur only (not Enter)
   * @param {boolean} [opts.commitOnBlur=true]
   * @param {(v:string)=>void} opts.onCommit
   * @param {()=>void} [opts.onCancel]
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts;
    this._destroyed = false;
    this._buildElement();
    this._reposition();
    // Reposition on viewport resize so the input tracks the canvas.
    this._onResize = () => this._reposition();
    window.addEventListener('resize', this._onResize);
    setTimeout(() => { try { this.input.focus(); this.input.select(); } catch (e) {} }, 0);
  }

  _buildElement() {
    const o = this.opts;
    const multiline = !!o.multiline;
    const commitOnBlur = o.commitOnBlur !== false;
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.value = o.value || '';
    input.placeholder = o.placeholder || '';
    if (!multiline) input.maxLength = o.maxLength || 40;
    Object.assign(input.style, {
      position: 'fixed',
      zIndex: String(Z),
      border: '2px solid #1a2332',
      borderRadius: '8px',
      padding: '6px 10px',
      background: '#ffffff',
      color: '#1a2332',
      font: (multiline ? '12px monospace' : 'bold 18px system-ui, sans-serif'),
      outline: 'none',
      boxSizing: 'border-box',
      resize: 'none',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._cancel(); return; }
      // Single-line: Enter commits. Multi-line: Ctrl/Cmd-Enter commits;
      // plain Enter inserts a newline as the user would expect.
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._commit();
      }
    });
    if (commitOnBlur) {
      input.addEventListener('blur', () => {
        setTimeout(() => { if (!this._destroyed) this._commit(); }, 0);
      });
    }
    document.body.appendChild(input);
    this.input = input;
  }

  _reposition() {
    if (!this.input) return;
    const canvas = this.scene.game.canvas;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const sx = r.width / this.scene.scale.width;
    const sy = r.height / this.scene.scale.height;
    const o = this.opts;
    const w = (o.width || 240) * sx;
    const h = (o.height || 36) * sy;
    const cx = r.left + (o.x ?? this.scene.scale.width / 2) * sx;
    const cy = r.top  + (o.y ?? this.scene.scale.height / 2) * sy;
    Object.assign(this.input.style, {
      left:   `${cx - w / 2}px`,
      top:    `${cy - h / 2}px`,
      width:  `${w}px`,
      height: `${h}px`,
      fontSize: `${Math.max(12, Math.round(18 * sy))}px`,
    });
  }

  _commit() {
    if (this._destroyed) return;
    const v = this.input.value;
    this.destroy();
    if (this.opts.onCommit) this.opts.onCommit(v);
  }

  _cancel() {
    if (this._destroyed) return;
    this.destroy();
    if (this.opts.onCancel) this.opts.onCancel();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this.input && this.input.parentNode) this.input.parentNode.removeChild(this.input);
    this.input = null;
  }
}
