import { createBaseAdapter } from './base.js';

// Wavedash adapter. The host portal injects `window.Wavedash` at runtime
// (the @wvdsh/sdk-js package is dev-only — types and intellisense, not
// shipped in the bundle). Until we call `Wavedash.init()`, the host shows
// its own loading spinner and keeps the game hidden. We hook that into
// the existing platform contract:
//
//   gameReady       → Wavedash.init()           — dismisses the spinner
//   firstFrameReady → Wavedash.updateLoadProgressZeroToOne(1) (best-effort)
//
// We also pipe leaderboard / achievement / cloud-save calls through their
// SDK so future scene code can use the same `platform.submitScore` etc.
// surface that other adapters implement. Anything Wavedash doesn't expose
// (eth, IAP, ads) inherits the no-op base.

// Poll briefly for window.Wavedash — it's injected by the host page
// before our bundle runs, but we guard anyway in case timing varies.
function waitForWavedashSdk(timeoutMs = 5000, pollMs = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (typeof window !== 'undefined' && window.Wavedash) return resolve(window.Wavedash);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, pollMs);
    })();
  });
}

export default (function createWavedashAdapter() {
  const base = createBaseAdapter('wavedash');
  let sdk = null;

  return Object.assign(base, {
    async init() {
      sdk = await waitForWavedashSdk();
      if (!sdk) {
        console.warn('[wavedash] window.Wavedash not found after timeout; running without portal integration');
      } else {
        console.log('[wavedash] SDK detected, host integration ready');
      }
    },

    // Wavedash docs: "Calling Wavedash.init() is required. Your game stays
    // hidden behind the Wavedash loading screen until you do." Hooked into
    // the existing platform.gameReady() call from PreloadScene.create —
    // fires after audio is loaded + the first scene is up.
    gameReady() {
      if (!sdk || typeof sdk.init !== 'function') return;
      try { sdk.init(); }
      catch (e) { console.warn('[wavedash] init failed', e); }
    },

    firstFrameReady() {
      if (!sdk || typeof sdk.updateLoadProgressZeroToOne !== 'function') return;
      try { sdk.updateLoadProgressZeroToOne(1); }
      catch (e) { /* progress is best-effort */ }
    },

    async submitScore(leaderboardId, score) {
      if (!sdk || typeof sdk.uploadLeaderboardScore !== 'function') return;
      try { await sdk.uploadLeaderboardScore(leaderboardId, score, false); }
      catch (e) { console.warn('[wavedash] uploadLeaderboardScore failed', e); }
    },

    async unlockAchievement(id) {
      if (!sdk || typeof sdk.setAchievement !== 'function') return;
      try { await sdk.setAchievement(id); }
      catch (e) { console.warn('[wavedash] setAchievement failed', e); }
    },
  });
})();
