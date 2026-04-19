import webAdapter from './web.js';

// Newgrounds adapter — extends the web adapter (localStorage saves) and adds
// medal / scoreboard hooks through the ngio client if present. Gracefully
// degrades to the web adapter when ngio isn't available (e.g., local dev).

export default Object.assign(Object.create(webAdapter), {
  name: 'newgrounds',

  async init() {
    await webAdapter.init();
    // ngio integration is optional; initializing it requires an app ID +
    // encryption key which the shipping build injects. Left as a placeholder.
    if (typeof window !== 'undefined' && window.Newgrounds) {
      try {
        // Example: window.ngio = new Newgrounds.io.core({ app_id: '...', cipher_key: '...' });
        console.log('[newgrounds] ngio client stub — wire app_id/cipher_key when shipping');
      } catch (e) {
        console.warn('[newgrounds] ngio init failed', e);
      }
    }
  },

  async submitScore(leaderboardId, score) {
    if (typeof window !== 'undefined' && window.ngio) {
      try {
        window.ngio.callComponent('ScoreBoard.postScore', { id: leaderboardId, value: score });
      } catch (e) {
        console.warn('[newgrounds] postScore failed', e);
      }
    }
  },

  async unlockAchievement(id) {
    if (typeof window !== 'undefined' && window.ngio) {
      try {
        window.ngio.callComponent('Medal.unlock', { id });
      } catch (e) {
        console.warn('[newgrounds] Medal.unlock failed', e);
      }
    }
  },
});
