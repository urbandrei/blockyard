// Four fixed-position strips that cover the HTML letterbox around the
// Phaser canvas — the area outside the 720×1580 logical canvas that
// Phaser's in-canvas shield rectangles can't reach. Used by modal
// dialogs so the WHOLE viewport reads as dimmed, not just the canvas.
//
// Each strip is pointer-events: none so the existing Phaser shield
// (inside the canvas) and the outside-canvas click handler (on body)
// still do their normal work. Returns a function that fades the
// strips out and removes them.
//
// Viewport resize while a modal is open is rare enough that we don't
// reflow; a stale strip layout just leaves a thin gap until the modal
// closes. The canvas itself carries the Phaser shield at alpha 0.55
// so the visual coverage remains continuous.

// Horizontal-band extender: mounts two fixed-position strips (left and
// right of the Phaser canvas) that fill the letterbox with the same
// color/alpha the Phaser banner uses inside the canvas. Used for the
// victory banner so the dark band reads as one continuous strip
// across the whole viewport, not just the logical canvas.
//
// `canvasTop`, `canvasHeight` are expressed in LOGICAL canvas pixels;
// they get multiplied by the canvas's live CSS scale to land at the
// right viewport row. Returns a function that removes both strips.

export function addDomBand({ canvasTop, canvasHeight, color = '#000000', alpha = 0.45, zIndex = 9400 } = {}) {
  const canvas = document.querySelector('canvas');
  if (!canvas) return () => {};
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width  / canvas.width  || 1;
  const scaleY = rect.height / canvas.height || 1;
  const vpTop    = rect.top + canvasTop * scaleY;
  const vpHeight = canvasHeight * scaleY;
  const vw = window.innerWidth;
  const strips = [];
  const mk = (left, width) => {
    if (width <= 0) return;
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.left = `${left}px`;
    el.style.top = `${vpTop}px`;
    el.style.width = `${width}px`;
    el.style.height = `${vpHeight}px`;
    el.style.background = color;
    el.style.opacity = String(alpha);
    el.style.zIndex = String(zIndex);
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    strips.push(el);
    void scaleX;  // silence unused — scaleX is for the symmetric API shape
  };
  mk(0, Math.max(0, rect.left));
  mk(rect.right, Math.max(0, vw - rect.right));
  return () => {
    for (const el of strips) { try { el.remove(); } catch (e) {} }
  };
}

export function addDomDim({ alpha = 0.55, zIndex = 9500 } = {}) {
  const canvas = document.querySelector('canvas');
  const rect = canvas
    ? canvas.getBoundingClientRect()
    : { left: 0, top: 0, right: 0, bottom: 0 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const strips = [];
  const mk = (left, top, width, height) => {
    if (width <= 0 || height <= 0) return;
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.background = `rgba(0, 0, 0, ${alpha})`;
    el.style.zIndex = String(zIndex);
    el.style.pointerEvents = 'none';
    el.style.transition = 'opacity 120ms ease-out';
    el.style.opacity = '0';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    strips.push(el);
  };
  // Top letterbox strip (above canvas).
  mk(0, 0, vw, Math.max(0, rect.top));
  // Bottom letterbox strip (below canvas).
  mk(0, rect.bottom, vw, Math.max(0, vh - rect.bottom));
  // Left letterbox strip.
  mk(0, rect.top, Math.max(0, rect.left), Math.max(0, rect.bottom - rect.top));
  // Right letterbox strip.
  mk(rect.right, rect.top, Math.max(0, vw - rect.right), Math.max(0, rect.bottom - rect.top));
  return () => {
    for (const el of strips) {
      el.style.opacity = '0';
      setTimeout(() => { try { el.remove(); } catch (e) {} }, 140);
    }
  };
}
