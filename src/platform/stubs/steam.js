import { createBaseAdapter } from '../base.js';

// Steam adapter — stub. Real implementation wraps the web bundle in Electron
// or Tauri and binds to Steamworks via greenworks/electron-steamworks for
// achievements + cloud saves.
// CRITICAL: Steam prohibits blockchain features — wallet/mint/NFT functions
// MUST remain no-ops (inherited from base) in this adapter.

export default (function createSteamStub() {
  const base = createBaseAdapter('steam');
  return Object.assign(base, {
    async init() { console.log('[steam] stub adapter loaded'); },
  });
})();
