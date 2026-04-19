import { createBaseAdapter } from './base.js';

// YouTube Playables adapter.
//
// Expects the ytgame SDK script tag to be present in index.html BEFORE the
// bundle script. The vite config injects that tag only for the youtube build.
// See: https://developers.google.com/youtube/gaming/playables

const SDK_TIMEOUT_MS = 5000;
const SDK_POLL_MS = 50;

function waitForSdk() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (typeof window !== 'undefined' && window.ytgame) return resolve(window.ytgame);
      if (Date.now() - start > SDK_TIMEOUT_MS) return reject(new Error('ytgame SDK did not load'));
      setTimeout(poll, SDK_POLL_MS);
    })();
  });
}

export default (function createYouTubeAdapter() {
  const base = createBaseAdapter('youtube');
  let ytgame = null;

  return Object.assign(base, {
    async init() {
      ytgame = await waitForSdk();
      // Wire SDK events to our registry; bindGame forwards to Phaser.
      if (ytgame.system && typeof ytgame.system.onPause === 'function') {
        ytgame.system.onPause(() => base._firePause());
      }
      if (ytgame.system && typeof ytgame.system.onResume === 'function') {
        ytgame.system.onResume(() => base._fireResume());
      }
      if (ytgame.system && typeof ytgame.system.onAudioEnabledChange === 'function') {
        ytgame.system.onAudioEnabledChange((enabled) => base._fireAudio(enabled));
      }
    },

    firstFrameReady() {
      if (ytgame && ytgame.game && typeof ytgame.game.firstFrameReady === 'function') {
        ytgame.game.firstFrameReady();
      }
    },
    gameReady() {
      if (ytgame && ytgame.game && typeof ytgame.game.gameReady === 'function') {
        ytgame.game.gameReady();
      }
    },

    async saveData(key, value) {
      if (!ytgame || !ytgame.game || typeof ytgame.game.saveData !== 'function') return;
      // ytgame.game.saveData accepts a single JSON blob; we wrap keyed values.
      const blob = await base.loadData('__blob__').then(x => x || {});
      blob[key] = value;
      await ytgame.game.saveData(JSON.stringify(blob));
    },
    async loadData(key) {
      if (!ytgame || !ytgame.game || typeof ytgame.game.loadData !== 'function') return null;
      if (key === '__blob__') {
        try {
          const raw = await ytgame.game.loadData();
          return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
      }
      const blob = await this.loadData('__blob__');
      return blob ? (blob[key] ?? null) : null;
    },

    async submitScore(leaderboardId, score) {
      if (!ytgame || !ytgame.engagement || typeof ytgame.engagement.sendScore !== 'function') return;
      try { await ytgame.engagement.sendScore({ value: score }); }
      catch (e) { console.warn('[youtube] sendScore failed', e); }
    },

    isAudioEnabled() {
      if (ytgame && ytgame.system && typeof ytgame.system.isAudioEnabled === 'function') {
        try { return !!ytgame.system.isAudioEnabled(); } catch { return true; }
      }
      return true;
    },

    // Ads: public-preview API, no guarantee of fill. We call it but don't block.
    async showInterstitialAd() {
      if (ytgame && ytgame.ads && typeof ytgame.ads.requestInterstitialAd === 'function') {
        try { await ytgame.ads.requestInterstitialAd(); } catch (e) { /* ignore */ }
      }
    },
  });
})();
