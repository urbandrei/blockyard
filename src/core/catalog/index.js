// Catalog of authored levels. Regulars (`levels/level-N.json`) and bosses
// (`levels/boss-N.json`) are bundled at build time via Vite's
// `import.meta.glob` (eager: true). Bosses sit BETWEEN regulars in
// catalog order — each section is 10 regulars + 1 boss — so clearing
// level 10 routes the player to boss 1, then on to level 11. Bosses are
// not counted in the "LEVEL N" numbering the UI shows on tiles.
//
// To author or regenerate the catalog: edit `scripts/gen-levels.mjs` and
// run `node scripts/gen-levels.mjs` from the project root. This file
// picks up whatever JSON shows up in `/levels/` next time Vite recompiles.

const modules = import.meta.glob('../../../levels/*.json', { eager: true });

const REGULAR_RE = /level-(\d+)\.json$/;
const BOSS_RE    = /boss-(\d+)\.json$/;

// Bosses are stubbed out of the shipping campaign for now. Boss JSON lives
// under `levels/_bosses/` (outside this glob) and this flag is the explicit
// re-enable knob. Flip to `true` and move the JSON back into `levels/` to
// restore boss routing through `LEVELS` and `SECTIONS`.
const BOSSES_ENABLED = false;

function fileIdx(path, re) {
  const m = re.exec(path);
  return m ? parseInt(m[1], 10) : 1e9;
}

// Deep clone on import so scenes can mutate the returned object without
// poisoning Vite's cached module.
function cloneLevel(json) { return JSON.parse(JSON.stringify(json)); }

const regularKeys = Object.keys(modules).filter((k) => REGULAR_RE.test(k)).sort((a, b) => fileIdx(a, REGULAR_RE) - fileIdx(b, REGULAR_RE));
const bossKeys    = Object.keys(modules).filter((k) => BOSS_RE.test(k)).sort((a, b) => fileIdx(a, BOSS_RE) - fileIdx(b, BOSS_RE));

const REGULARS = regularKeys.map((k, idx) => {
  const json = (modules[k] && modules[k].default) || modules[k];
  const lvl = cloneLevel(json);
  // Stamp 1-based catalog index on regulars so the UI shows "LEVEL N"
  // without the level JSON author tracking numbers manually.
  lvl.number = idx + 1;
  return lvl;
});
const BOSSES = bossKeys.map((k, idx) => {
  const json = (modules[k] && modules[k].default) || modules[k];
  const lvl = cloneLevel(json);
  lvl.bossIndex = idx + 1;   // "BOSS 1", "BOSS 2", ... (labels only)
  lvl.number = null;         // explicit — UI code branches on this
  return lvl;
});

// Ordered full catalog: walk each section's regulars, then its boss, then
// the next section. HomeScene's "next unbeaten" + nextLevelAfter both
// traverse this list.
const SECTION_SIZE = 10;
function buildOrdered() {
  const out = [];
  let regIdx = 0;
  let bossIdx = 0;
  while (regIdx < REGULARS.length || bossIdx < BOSSES.length) {
    const slice = REGULARS.slice(regIdx, regIdx + SECTION_SIZE);
    for (const r of slice) out.push(r);
    regIdx += slice.length;
    if (BOSSES_ENABLED && bossIdx < BOSSES.length) {
      out.push(BOSSES[bossIdx]);
      bossIdx += 1;
    }
  }
  return out;
}
export const LEVELS = buildOrdered();

// Grouped for LevelSelect / section headers: each entry carries its 10
// regulars plus the boss that guards the section (or `null` if we've
// shipped more regulars than bosses).
function buildSections() {
  const out = [];
  for (let s = 0; s * SECTION_SIZE < REGULARS.length; s++) {
    const slice = REGULARS.slice(s * SECTION_SIZE, (s + 1) * SECTION_SIZE);
    const boss = BOSSES_ENABLED ? (BOSSES[s] || null) : null;
    out.push({ id: `s${s + 1}`, name: `Section ${s + 1}`, levels: slice, boss });
  }
  return out;
}
export const SECTIONS = buildSections();

export function getLevelById(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

// First level not yet beaten, or null if everything is beaten.
export function nextUnbeaten(beatenSet) {
  for (const l of LEVELS) if (!beatenSet.has(l.id)) return l;
  return null;
}

// The level immediately after `id` in the catalog, or null if it was the last.
export function nextLevelAfter(id) {
  const idx = LEVELS.findIndex((l) => l.id === id);
  if (idx < 0 || idx >= LEVELS.length - 1) return null;
  return LEVELS[idx + 1];
}
