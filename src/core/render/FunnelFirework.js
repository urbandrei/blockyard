// Small radial burst effect: scatters ~12 tiny Form×Color shapes outward
// from an (x, y) origin, tweening scale + alpha + rotation to zero over
// ~600ms. Modeled on ShapeRenderer._spawnDebris but uses the full 9-combo
// shape palette for a celebratory feel instead of single-color debris.
//
// Usage:
//   spawnFunnelFirework(scene, container, { x, y, radius })
//   // fire-and-forget; the tween destroys each particle on complete.

import { COLOR_HEX, COLORS, FORMS } from '../model/shape.js';

const DEFAULT_COUNT = 12;
const PARTICLE_STROKE = 0x1a2332;

export function spawnFunnelFirework(scene, container, { x, y, radius, count = DEFAULT_COUNT, particleR: particleROverride, strokeW: strokeWOverride }) {
  const r = Math.max(10, radius || 24);
  const particleR = particleROverride != null ? particleROverride : Math.max(3, Math.round(r * 0.28));
  const strokeW = strokeWOverride != null ? strokeWOverride : Math.max(1, Math.round(r * 0.06));
  for (let i = 0; i < count; i++) {
    const form  = FORMS[(Math.random() * FORMS.length)  | 0];
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const fill  = COLOR_HEX[color] || 0xffffff;

    const g = scene.make.graphics({ add: false });
    g.fillStyle(fill, 1);
    g.lineStyle(strokeW, PARTICLE_STROKE, 1);
    drawTinyShape(g, particleR, form);
    g.x = x + (Math.random() - 0.5) * r * 0.25;
    g.y = y + (Math.random() - 0.5) * r * 0.25;
    g.rotation = Math.random() * Math.PI * 2;
    g.setScale(0.8 + Math.random() * 0.5);
    container.add(g);

    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.7;
    const dist  = r * (1.6 + Math.random() * 1.4);
    const tx = g.x + Math.cos(angle) * dist;
    const ty = g.y + Math.sin(angle) * dist;
    scene.tweens.add({
      targets: g,
      x: tx,
      y: ty,
      scale: 0.05,
      alpha: 0,
      rotation: g.rotation + (Math.random() - 0.5) * Math.PI * 2,
      duration: 520 + Math.random() * 260,
      ease: 'Sine.easeOut',
      onComplete: () => g.destroy(),
    });
  }
}

function drawTinyShape(g, r, form) {
  switch (form) {
    case 'square': {
      const s = r * 1.7;
      g.fillRect(-s / 2, -s / 2, s, s);
      g.strokeRect(-s / 2, -s / 2, s, s);
      return;
    }
    case 'triangle': {
      const halfBase = r * 1.05;
      g.beginPath();
      g.moveTo(0,             -r * 1.2);
      g.lineTo(-halfBase,      r * 0.8);
      g.lineTo( halfBase,      r * 0.8);
      g.closePath();
      g.fillPath();
      g.strokePath();
      return;
    }
    case 'circle':
    default:
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
  }
}
