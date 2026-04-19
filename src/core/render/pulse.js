// Squash-and-stretch pulse — the factory body gets taller+thinner on one
// plateau, shorter+wider on the other, following the classic animation
// principle. Funnels do the opposite so they "react against" the body as it
// deforms. Amplitude is kept subtle; volume (area) is roughly preserved since
// (1-A)(1+A) ≈ 1 for small A.
//
// (`shapeSquash` refers to the factory-body squash-and-stretch curve; it is
// not related to the `shape` flowing-unit type in the simulation.)

const AMP = 0.01;

function smoothstep(t) { return t * t * (3 - 2 * t); }

// Returns { body:{scaleX,scaleY}, funnels:{scaleX,scaleY} }. Scenes apply
// the two transforms to separate wrap containers positioned at the factory's
// center so the scale is centered (no drift).
//
// Phase thresholds match the reshuffled phaseDistance curve (two slow
// plateaus per cycle: one centered on the cell EDGE and one on the cell
// CENTER):
//   0.000 – 0.175 : plateau, body TALL   (edge slow, first half of wrap)
//   0.175 – 0.325 : smooth ease          (stretch → squash)
//   0.325 – 0.675 : plateau, body WIDE   (center slow — shape is over grid center)
//   0.675 – 0.825 : smooth ease          (squash → stretch)
//   0.825 – 1.000 : plateau, body TALL   (edge slow, second half of wrap)
export function shapeSquash(t) {
  t = t - Math.floor(t);
  let stretch; // +1 = body tall/thin, -1 = body wide/short
  if (t < 0.175)      stretch = 1;
  else if (t < 0.325) stretch = 1 - 2 * smoothstep((t - 0.175) / 0.15);
  else if (t < 0.675) stretch = -1;
  else if (t < 0.825) stretch = -1 + 2 * smoothstep((t - 0.675) / 0.15);
  else                stretch = 1;
  return {
    body:    { scaleX: 1 - stretch * AMP, scaleY: 1 + stretch * AMP },
    funnels: { scaleX: 1 + stretch * AMP, scaleY: 1 - stretch * AMP },
  };
}
