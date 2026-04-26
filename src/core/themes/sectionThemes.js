// Section-themed palettes for the playable area + exterior buffer + page
// background. Each entry is the pair of colors the PlayAreaFrame interior
// + exterior renderers (and the LetterboxChecker body painter) need.
//
// Indexing matches `SECTIONS` in src/core/catalog/index.js: 0=Block Yard,
// 1=Paint Spill, 2=Acid Swamp, 3=Laser Field, 4=Wild West (any section
// beyond MAIN_SECTION_COUNT).

import { SECTIONS } from '../catalog/index.js';

// First section index treated as Wild West. Sections 0..3 are the main
// campaign; anything from 4 onward inherits the Wild West palette.
export const MAIN_SECTION_COUNT = 4;

export const SECTION_THEMES = [
  // Block Yard — current default. Peach floor + dark brown buffer.
  { id: 'block-yard',  interior: 0xDFA06E, interiorAlt: 0xC48652, buffer: 0x412722, bufferAlt: 0x552E26 },
  // Paint Spill — off-white floor, muted purple+green buffer that reads as
  // a colorful spill without overpowering the white interior.
  { id: 'paint-spill', interior: 0xF5F5F5, interiorAlt: 0xE2E2E6, buffer: 0xB8AEC4, bufferAlt: 0xAEC0AE },
  // Acid Swamp — sickly acid-green floor over a dark swamp-green buffer.
  { id: 'acid-swamp',  interior: 0xC4D67E, interiorAlt: 0x9FB85E, buffer: 0x2A4030, bufferAlt: 0x3C5C46 },
  // Laser Field — PCB-green floor (the "circuit board") under deep red
  // ambient (the "laser field") buffer.
  { id: 'laser-field', interior: 0x0E5A2A, interiorAlt: 0x0A4A22, buffer: 0x701818, bufferAlt: 0x8A2222 },
  // Wild West — sandy desert floor under a sunset-orange buffer.
  { id: 'wild-west',   interior: 0xD4A574, interiorAlt: 0xB88858, buffer: 0x6B2818, bufferAlt: 0x8B3820 },
];

const DEFAULT_THEME = SECTION_THEMES[0];

export function themeForSectionIdx(idx) {
  if (idx == null || idx < 0) return DEFAULT_THEME;
  if (idx < MAIN_SECTION_COUNT) return SECTION_THEMES[idx] || DEFAULT_THEME;
  // Wild West covers every section past the main campaign.
  return SECTION_THEMES[MAIN_SECTION_COUNT] || DEFAULT_THEME;
}

// Walks SECTIONS to find which section owns a given level id (regular or
// boss). Returns the Block Yard theme for unknown ids — sandbox + community
// levels keep the current peach/brown look.
export function themeForLevelId(levelId) {
  if (!levelId) return DEFAULT_THEME;
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i];
    if (s.levels && s.levels.some((l) => l.id === levelId)) return themeForSectionIdx(i);
    if (s.boss && s.boss.id === levelId) return themeForSectionIdx(i);
  }
  return DEFAULT_THEME;
}
