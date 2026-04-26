// Runtime opt-in flag for the Ethereum / level-ownership flow. Build-time
// gating still lives in platform.ethEnabled (set from VITE_BLOCKYARD_*),
// but the average player who never asked to interact with a wallet
// shouldn't get prompted on publish — so we add a per-device pref that
// defaults to OFF. The publish flow ANDs the two together: wallet UI
// only appears when the build supports eth AND the user has opted in.
//
// Persisted via the platform adapter under `blockyard.ethOptIn`. In-
// memory cache is authoritative during a session; the adapter is just a
// pass-through for next boot.

import { platform } from '../platform/index.js';

const STORAGE_KEY = 'blockyard.ethOptIn';

let optedIn = false;
const listeners = new Set();

export function getEthOptIn() { return optedIn; }

export function setEthOptIn(value) {
  const next = !!value;
  if (optedIn === next) return;
  optedIn = next;
  for (const fn of listeners) { try { fn(optedIn); } catch (e) {} }
  // Best-effort persist; we keep the in-memory cache regardless of a
  // platform-side write failure (e.g. quota exceeded).
  platform.saveData(STORAGE_KEY, optedIn).catch(() => {});
}

export function subscribeEthOptIn(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Hydrate from the platform on boot. Safe to call once — any failure
// leaves the default (false) in place.
export async function loadEthOptIn() {
  try {
    const saved = await platform.loadData(STORAGE_KEY);
    if (typeof saved === 'boolean') optedIn = saved;
  } catch (e) {}
}
