// Computes the content box inside the Phaser canvas. The box is a portrait
// column: width never exceeds the canvas aspect (2:3), but also never
// exceeds the device viewport's own aspect — so on a typical phone the
// content fills edge-to-edge (no thick brown margin inside the canvas),
// while wider desktops get the natural 2:3 letterbox so the layout stays
// a readable column.
//
// Returns integers in logical canvas px: `{ boxX, boxY, boxW, boxH }`.

// Canvas aspect = logical 720 × 1080 (see config.js). The box should never
// be wider than this — anything past 2:3 wouldn't fit the canvas anyway.
const CANVAS_ASPECT = 2 / 3;

export function compute920Box(scene) {
  const logicalW = scene.scale.width;
  const logicalH = scene.scale.height;
  // Size the box against the actual device viewport — not the Phaser
  // canvas's displaySize, which is already letterboxed. Fallback to the
  // logical canvas when window globals are unavailable (e.g. headless).
  const vw = (typeof window !== 'undefined' && window.innerWidth)  || logicalW;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || logicalH;

  // Target aspect: device aspect up to CANVAS_ASPECT. A 9:16 phone gets a
  // 9:16 box (fills phone width); a 16:9 desktop gets the full 2:3 box.
  const deviceAspect = vw / vh;
  const targetAspect = Math.min(deviceAspect, CANVAS_ASPECT);

  let boxW_dev, boxH_dev;
  if (deviceAspect > targetAspect) {
    boxH_dev = vh;
    boxW_dev = vh * targetAspect;
  } else {
    boxW_dev = vw;
    boxH_dev = vw / targetAspect;
  }

  // Project device CSS px → logical canvas px. Phaser FIT preserves aspect,
  // so the uniform conversion factor is (logical / displayed-canvas). Pull
  // it from displayScale, which Phaser defines as logical÷display.
  const logicalPerDev = (scene.scale.displayScale && scene.scale.displayScale.x) || (logicalW / vw);
  let boxW = boxW_dev * logicalPerDev;
  let boxH = boxH_dev * logicalPerDev;

  // Clamp to canvas — the box can exceed the canvas when the viewport is
  // narrower/taller than the 720×1080 aspect (2:3); in that case the box
  // collapses to the whole canvas, which is the right degenerate behavior.
  boxW = Math.min(boxW, logicalW);
  boxH = Math.min(boxH, logicalH);

  return {
    boxX: Math.round((logicalW - boxW) / 2),
    boxY: Math.round((logicalH - boxH) / 2),
    boxW: Math.round(boxW),
    boxH: Math.round(boxH),
  };
}
