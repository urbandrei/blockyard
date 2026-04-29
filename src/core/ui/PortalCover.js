// Full-viewport DOM canvas that runs the vibej.am portal "swirl cover"
// animation. Lives on document.body (not inside Phaser) so it can run
// before Phaser has even booted (entry-portal use case) and over the
// letterbox bars Phaser's FIT mode leaves around the canvas.
//
// Two phases on a single instance:
//   start()              — animates IN, fills the screen with a rotating
//                          radial swirl over ~COVER_MS. When it reaches
//                          full coverage, fires opts.onCoverPeak (e.g.
//                          "scene.start('Player', …)" or "window.location.href = …").
//   triggerExit(onDone)  — animates OUT, swirl shrinks + fades over
//                          ~REVEAL_MS, then removes the canvas + calls
//                          onDone. Used when arriving via ?portal=true:
//                          the entry-side cover stays on top while
//                          PlayerScene's first frame paints, then we
//                          reveal.
//
// Procedural drawing only (no preloaded assets) so the entry-portal flow
// can run instantly the moment the bundle's JS executes.

const COVER_MS    = 600;     // swirl-in
const REVEAL_MS   = 400;     // swirl-out
const HOLD_MS     = 80;      // brief peak hold before onCoverPeak fires
const RAY_COUNT   = 12;      // spokes inside the swirl
const ROT_SPEED   = 1.4;     // radians/sec

const BASE_HEX    = '#412722';   // matches body bg in index.html
const ACCENT_HEX  = '#ff8a3a';   // brand accent, also used by buffer funnels

export class PortalCover {
  constructor(opts = {}) {
    this._onCoverPeak = opts.onCoverPeak || null;
    this._onComplete  = opts.onComplete  || null;
    this._canvas    = null;
    this._ctx       = null;
    this._dpr       = 1;
    this._raf       = null;
    this._phase     = 'idle';   // 'cover' | 'hold' | 'reveal' | 'done'
    this._phaseStart = 0;
    this._coverPeakFired = false;
    this._exitCb    = null;
    this._onResize  = null;
    this._startMs   = 0;
  }

  start() {
    if (this._canvas) return;
    const c = document.createElement('canvas');
    c.id = 'blockyard-portal-cover';
    c.style.position      = 'fixed';
    c.style.left          = '0';
    c.style.top           = '0';
    c.style.zIndex        = '10001';   // sits above any in-page DOM overlays
    c.style.pointerEvents = 'none';
    c.style.background    = 'transparent';
    document.body.appendChild(c);
    this._canvas = c;
    this._ctx = c.getContext('2d');

    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    this._phase = 'cover';
    this._startMs = performance.now();
    this._phaseStart = this._startMs;
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  // Begin the reveal phase. Safe to call before the cover peak — it'll
  // wait for the cover to finish filling first, then immediately reveal.
  triggerExit(onDone) {
    this._exitCb = onDone || null;
    // Defer the actual phase flip until cover has peaked, so we never
    // reveal a half-drawn swirl. _tick handles the pending flag.
    this._exitPending = true;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._raf = null;
    this._canvas = null;
    this._ctx = null;
    this._phase = 'done';
  }

  _resize() {
    const c = this._canvas;
    if (!c) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this._dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    c.width  = Math.floor(w * this._dpr);
    c.height = Math.floor(h * this._dpr);
    c.style.width  = `${w}px`;
    c.style.height = `${h}px`;
    if (this._ctx) this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  _tick(now) {
    if (!this._canvas) return;
    const elapsed = now - this._phaseStart;
    const ctx = this._ctx;
    const w = this._canvas.width  / this._dpr;
    const h = this._canvas.height / this._dpr;

    // The swirl's outer radius — zero before cover starts, grows to
    // hypot(w/2,h/2) at peak so it covers any viewport corner-to-center.
    const maxR = Math.hypot(w, h) * 0.55;
    let coverage = 0;   // 0 = nothing covered, 1 = full screen

    if (this._phase === 'cover') {
      coverage = clamp01(elapsed / COVER_MS);
      // Ease-out so the swirl fills decisively then settles.
      coverage = 1 - (1 - coverage) * (1 - coverage);
      if (elapsed >= COVER_MS) {
        coverage = 1;
        this._phase = 'hold';
        this._phaseStart = now;
      }
    } else if (this._phase === 'hold') {
      coverage = 1;
      if (!this._coverPeakFired) {
        this._coverPeakFired = true;
        if (this._onCoverPeak) {
          try { this._onCoverPeak(); } catch (e) { /* swallow */ }
        }
      }
      if (elapsed >= HOLD_MS && this._exitPending) {
        this._phase = 'reveal';
        this._phaseStart = now;
      }
    } else if (this._phase === 'reveal') {
      coverage = 1 - clamp01(elapsed / REVEAL_MS);
      // Ease-in for the reveal so the swirl pulls back like a curtain.
      coverage = coverage * coverage;
      if (elapsed >= REVEAL_MS) {
        coverage = 0;
        this._phase = 'done';
        const cb = this._exitCb;
        this._exitCb = null;
        this.destroy();
        if (cb) { try { cb(); } catch (e) {} }
        if (this._onComplete) { try { this._onComplete(); } catch (e) {} }
        return;
      }
    } else {
      // 'idle' or 'done' — paint nothing, wait.
    }

    // Draw the swirl. Background: solid base color across the whole
    // canvas, alpha = coverage so the layer fades cleanly. On top:
    // rotating accent rays radiating from the center, masked by a
    // disc of radius `coverage * maxR` so the swirl visually grows.
    const cx = w / 2, cy = h / 2;
    const totalT = (now - this._startMs) / 1000;

    ctx.clearRect(0, 0, w, h);

    // Base fill — fades in/out with coverage. Slight darken near edges
    // via a radial gradient gives the layer depth.
    if (coverage > 0) {
      ctx.globalAlpha = coverage;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(maxR, 1));
      grad.addColorStop(0, BASE_HEX);
      grad.addColorStop(1, '#1d100e');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Spinning ray pattern, clipped to the disc so it grows out
      // from the center as coverage increases.
      const r = coverage * maxR * 1.2;   // slightly bigger than maxR so edges stay flooded
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(totalT * ROT_SPEED);
      ctx.fillStyle = ACCENT_HEX;
      ctx.globalAlpha = coverage * 0.55;
      const spokeAngle = (Math.PI * 2) / RAY_COUNT;
      const spokeWidth = spokeAngle * 0.45;
      for (let i = 0; i < RAY_COUNT; i++) {
        const a = i * spokeAngle;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r * 1.4, a - spokeWidth / 2, a + spokeWidth / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    this._raf = requestAnimationFrame((t) => this._tick(t));
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
