// Global audio settings — music + SFX volumes and independent mute
// toggles. playOnce() in sfx.js and MusicEngine's tick both read from
// here so the HomeScene toolbar + settings modal can adjust the mix
// live without touching sound instances directly.
//
// Values persist via the platform adapter (saveData / loadData under
// `blockyard.audio`). The in-memory cache is authoritative during a
// session; the adapter is just a pass-through for next boot.

import { platform } from '../../platform/index.js';

const STORAGE_KEY = 'blockyard.audio';

const state = {
  musicVolume: 1,
  sfxVolume: 1,
  musicMuted: false,
  sfxMuted: false,
};

const listeners = new Set();

function emit() { for (const fn of listeners) { try { fn(getAll()); } catch (e) {} } }

export function subscribeAudioSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAll() { return { ...state }; }

export function getMusicVolume() { return state.musicVolume; }
export function getSfxVolume()   { return state.sfxVolume; }
export function isMusicMuted()   { return state.musicMuted; }
export function isSfxMuted()     { return state.sfxMuted; }

// Effective multipliers (volume * !muted) — what playOnce / MusicEngine
// should multiply their native volumes by.
export function musicGain() { return state.musicMuted ? 0 : state.musicVolume; }
export function sfxGain()   { return state.sfxMuted   ? 0 : state.sfxVolume; }

export function setMusicVolume(v) {
  state.musicVolume = clamp01(v);
  persist(); emit();
}
export function setSfxVolume(v) {
  state.sfxVolume = clamp01(v);
  persist(); emit();
}
export function toggleMusicMuted() { state.musicMuted = !state.musicMuted; persist(); emit(); }
export function toggleSfxMuted()   { state.sfxMuted   = !state.sfxMuted;   persist(); emit(); }

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

async function persist() {
  try { await platform.saveData(STORAGE_KEY, { ...state }); } catch (e) {}
}

// Hydrate from the platform on boot. Safe to call once — any failure
// leaves the defaults in place. Fires a notification so early
// subscribers can react to the loaded values.
export async function loadAudioSettings() {
  try {
    const saved = await platform.loadData(STORAGE_KEY);
    if (saved && typeof saved === 'object') {
      if (typeof saved.musicVolume === 'number') state.musicVolume = clamp01(saved.musicVolume);
      if (typeof saved.sfxVolume   === 'number') state.sfxVolume   = clamp01(saved.sfxVolume);
      if (typeof saved.musicMuted  === 'boolean') state.musicMuted = saved.musicMuted;
      if (typeof saved.sfxMuted    === 'boolean') state.sfxMuted   = saved.sfxMuted;
      emit();
    }
  } catch (e) {}
}
