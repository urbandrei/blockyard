import { createBaseAdapter } from './base.js';

// Web / itch.io adapter. localStorage-backed saves with a single key prefix.
// Scores / ads / purchases are no-ops (inherited from base); audio is always
// enabled — Phaser's own mute is the source of truth.
//
// Community backend (Milestone H): when VITE_BLOCKYARD_API is set, publish /
// search / like forward to the real server through `fetch`. When it's unset
// we fall back to the original no-server behavior so `npm run dev` still
// behaves sensibly before the tunnel is up.

const KEY_PREFIX = 'blockyard.';
const LEGACY_LEVEL_KEY = 'blockyard.level'; // v1's exact key — we read it for migration
const TOKEN_KEY = 'community.token';

function storageKey(key) {
  return key.startsWith(KEY_PREFIX) ? key : KEY_PREFIX + key;
}

// Read at import time so every method sees the same origin. Trailing slashes
// stripped so we can safely concatenate `${API}/levels`.
const API = (import.meta.env && import.meta.env.VITE_BLOCKYARD_API || '').replace(/\/+$/, '');

export default (function createWebAdapter() {
  const base = createBaseAdapter('web');

  // Lazy-issued anonymous token. First call hits /auth/token; result is cached
  // in localStorage so a returning player keeps the same identity for likes.
  let tokenPromise = null;
  async function getToken() {
    if (!API) return null;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      try {
        const cached = localStorage.getItem(storageKey(TOKEN_KEY));
        if (cached) return cached;
      } catch (e) {}
      const res = await fetch(`${API}/auth/token`, { method: 'POST' });
      if (!res.ok) throw new Error(`auth/token ${res.status}`);
      const { token } = await res.json();
      try { localStorage.setItem(storageKey(TOKEN_KEY), token); } catch (e) {}
      return token;
    })().catch((e) => {
      // Drop the cached promise so the next call can retry after the network
      // recovers — otherwise one failed probe would brick publish forever.
      tokenPromise = null;
      throw e;
    });
    return tokenPromise;
  }

  async function api(path, init = {}) {
    if (!API) throw new Error('api disabled');
    const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
    if (init.auth) {
      const token = await getToken();
      headers['x-blockyard-token'] = token;
    }
    const res = await fetch(`${API}${path}`, { ...init, headers });
    if (!res.ok) {
      const err = new Error(`${init.method || 'GET'} ${path} ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch (e) {}
      throw err;
    }
    return res.json();
  }

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

    // Submit a level to the real backend. Returns a `{ id, status }` object
    // on success (truthy — existing callers read it as "accepted"), or true
    // when no API is configured so dev builds still flip the local status to
    // 'pending'. Returns false on network / server error.
    async publishLevel(level) {
      if (!API) return true;
      try {
        const result = await api('/levels', {
          method: 'POST',
          auth: true,
          body: JSON.stringify(level),
        });
        return result;
      } catch (e) {
        console.warn('[web] publishLevel failed', e);
        return false;
      }
    },

    async searchLevels(opts = {}) {
      if (!API) return { levels: [], hasMore: false };
      const params = new URLSearchParams();
      if (opts.query) params.set('q', opts.query);
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.page != null) params.set('page', String(opts.page));
      if (opts.pageSize != null) params.set('pageSize', String(opts.pageSize));
      try {
        return await api(`/levels?${params.toString()}`);
      } catch (e) {
        console.warn('[web] searchLevels failed', e);
        return { levels: [], hasMore: false, offline: true };
      }
    },

    async likeLevel(id, liked) {
      if (!API) return false;
      try {
        return await api(`/levels/${encodeURIComponent(id)}/like`, {
          method: 'POST',
          auth: true,
          body: JSON.stringify({ liked: !!liked }),
        });
      } catch (e) {
        console.warn('[web] likeLevel failed', e);
        return false;
      }
    },

    // Fetch the full body of a public level by id. Used when the search
    // result is just a summary and the scene wants to actually play it.
    async fetchLevel(id) {
      if (!API) return null;
      try {
        return await api(`/levels/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e && e.status === 404) return null;
        console.warn('[web] fetchLevel failed', e);
        return null;
      }
    },

    canOpenExternal: true,
    openExternal(url) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); return true; }
      catch (e) { console.warn('[web] openExternal failed', e); return false; }
    },
  });
})();
