import { createBaseAdapter } from '../base.js';

// Wavedash adapter — stub. Real implementation will use @wvdsh/sdk-js for
// leaderboards, P2P lobbies, achievements, cloud saves, content uploads.

export default (function createWavedashStub() {
  const base = createBaseAdapter('wavedash');
  return Object.assign(base, {
    async init() { console.log('[wavedash] stub adapter loaded'); },
  });
})();
