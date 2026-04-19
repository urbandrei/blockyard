import { createBaseAdapter } from '../base.js';

// CrazyGames adapter — stub. Real implementation will use the CrazyGames SDK
// for rewarded / midgame / interstitial ads, cloud saves, and Xsolla IAP.
// CRITICAL: ONLY ads served through their SDK are allowed on their platform.

export default (function createCrazyGamesStub() {
  const base = createBaseAdapter('crazygames');
  return Object.assign(base, {
    async init() { console.log('[crazygames] stub adapter loaded'); },
  });
})();
