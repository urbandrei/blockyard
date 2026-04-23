// Emit the level's starting setup as a shareable PNG. Just the playable
// area + blueprint — no title bar, author line, or URL strip. The 720x1080
// offscreen render (LevelPreviewRenderer) is upscaled to 1080x1620 on a
// 2D canvas so the share output is crisp enough for social previews.

import { renderLevelPreview, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../render/LevelPreviewRenderer.js';

const OUTPUT_SCALE = 1.5;
const OUTPUT_W = Math.round(PREVIEW_WIDTH  * OUTPUT_SCALE);   // 1080
const OUTPUT_H = Math.round(PREVIEW_HEIGHT * OUTPUT_SCALE);   // 1620

export async function generateShareImage(scene, level /*, opts */) {
  let gameImage = null;
  try {
    gameImage = await renderLevelPreview(scene, level);
  } catch (e) {
    console.warn('[sharePreview] level render failed', e);
    return null;
  }
  if (!gameImage) return null;

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_W;
  canvas.height = OUTPUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Smooth the upscale so the output doesn't look blocky on big feeds.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(gameImage, 0, 0, OUTPUT_W, OUTPUT_H);

  return await canvasToBlob(canvas, 'image/png');
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => resolve(b), type);
    } else {
      try {
        const dataUrl = canvas.toDataURL(type);
        const binary = atob(dataUrl.split(',')[1]);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        resolve(new Blob([arr], { type }));
      } catch (e) { resolve(null); }
    }
  });
}
