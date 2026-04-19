import { createBaseAdapter } from './base.js';

// Web / itch.io adapter. localStorage-backed saves with a single key prefix.
// Scores / ads / purchases are no-ops (inherited from base); audio is always
// enabled — Phaser's own mute is the source of truth.

const KEY_PREFIX = 'blockyard.';
const LEGACY_LEVEL_KEY = 'blockyard.level'; // v1's exact key — we read it for migration

function storageKey(key) {
  return key.startsWith(KEY_PREFIX) ? key : KEY_PREFIX + key;
}

export default (function createWebAdapter() {
  const base = createBaseAdapter('web');

  return Object.assign(base, {
    async init() {
      // Nothing to wait for. Present for interface parity.
    },

    async saveData(key, value) {
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(value));
      } catch (e) {
        // Quota / private browsing: log and move on. Saves are best-effort on web.
        console.warn('[web] saveData failed', e);
      }
    },

    async loadData(key) {
      try {
        const k = storageKey(key);
        let raw = localStorage.getItem(k);
        // Fallback for the v1 key name so existing saves round-trip.
        if (raw == null && k === LEGACY_LEVEL_KEY) {
          raw = localStorage.getItem(LEGACY_LEVEL_KEY);
        }
        return raw == null ? null : JSON.parse(raw);
      } catch (e) {
        console.warn('[web] loadData failed', e);
        return null;
      }
    },

    // Community publish stub: until the real backend (Milestone H) lands
    // we just record local intent — `community.js#setStatus` flips the
    // saved level's status to 'pending'. The actual upload + admin review
    // happens later. Returning true here lets the UI show "submitted".
    async publishLevel(_level) { return true; },

    canOpenExternal: true,
    openExternal(url) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); return true; }
      catch (e) { console.warn('[web] openExternal failed', e); return false; }
    },
  });
})();
