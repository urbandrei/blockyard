// Platform adapter interface. See GAME_PROJECT_REFERENCE.md for the full
// contract. Every adapter returns an object that implements these methods;
// those it doesn't support should no-op or return sensible defaults rather
// than throwing so the core code can treat platforms uniformly.
//
// @typedef {Object} Entitlements
// @property {string[]} entitlements
//
// @typedef {Object} PlatformAdapter
// @property {string} name
// @property {() => Promise<void>} init
// @property {() => void} firstFrameReady
// @property {() => void} gameReady
// @property {(cb: () => void) => void} onPause
// @property {(cb: () => void) => void} onResume
// @property {(key: string, value: any) => Promise<void>} saveData
// @property {(key: string) => Promise<any>} loadData
// @property {(leaderboardId: string, score: number) => Promise<void>} submitScore
// @property {(id: string) => Promise<void>} unlockAchievement
// @property {() => Promise<boolean>} showRewardedAd
// @property {() => Promise<void>} showInterstitialAd
// @property {(id: string) => Promise<boolean>} purchaseItem
// @property {() => Promise<void>} restorePurchases
// @property {(id: string) => boolean} hasEntitlement
// @property {(code: string) => Promise<Entitlements>} redeemCode
// @property {() => boolean} isAudioEnabled
// @property {(cb: (enabled: boolean) => void) => void} onAudioEnabledChange
// @property {(phaserGame: any) => void} bindGame

export function createBaseAdapter(name = 'base') {
  // The base keeps pause/resume/audio callbacks in a local registry so
  // bindGame can wire them into Phaser uniformly. Real adapters override
  // onPause/onResume/onAudioEnabledChange to trigger these registry entries
  // from their own SDK events.
  const pauseCbs = [];
  const resumeCbs = [];
  const audioCbs = [];

  const adapter = {
    name,

    // Lifecycle
    async init() {},
    firstFrameReady() {},
    gameReady() {},
    onPause(cb)  { if (typeof cb === 'function') pauseCbs.push(cb); },
    onResume(cb) { if (typeof cb === 'function') resumeCbs.push(cb); },

    // Storage
    async saveData(_key, _value) {},
    async loadData(_key) { return null; },

    // Scores / achievements
    async submitScore(_leaderboardId, _score) {},
    async unlockAchievement(_id) {},

    // Monetization — no-op on web-free / mobile stubs; real on Steam/mobile
    async showRewardedAd()     { return false; },
    async showInterstitialAd() {},
    async purchaseItem(_id)    { return false; },
    async restorePurchases()   {},
    hasEntitlement(_id)        { return false; },
    async redeemCode(_code)    { return { entitlements: [] }; },

    // Audio
    isAudioEnabled() { return true; },
    onAudioEnabledChange(cb) { if (typeof cb === 'function') audioCbs.push(cb); },

    // Community (Milestone G — adapter stubs; real backend lands in H).
    // `publishLevel` returns whether the publish call was accepted; until the
    // backend exists, web flips status to 'pending' locally; sandboxed
    // platforms (YouTube Playables, mobile, etc.) just return false.
    async publishLevel(_level) { return false; },
    async searchLevels(_opts)  { return { levels: [], hasMore: false }; },
    async likeLevel(_id, _liked) { return false; },
    async fetchLevel(_id) { return null; },
    // Author-only remote delete. Returns true on success, false on any
    // failure (including ownership mismatch 403). Callers always run the
    // local community.deleteLevel() too, independent of the remote result.
    async deleteRemoteLevel(_id) { return false; },
    async rateLevel(_id, _stars) { return null; },

    // Daily-featured-level fetch. Adapters that talk to the backend
    // override these; sandboxed platforms keep the no-op stubs so the
    // home panel cleanly hides itself when the backend is unreachable.
    async fetchTodaysFeatured() { return null; },
    async fetchFeaturedHistory(_limit) { return { entries: [] }; },
    async fetchFeaturedByDate(_utcDate) { return null; },

    // Anonymous play telemetry. Web posts these to the community API; every
    // other adapter no-ops so PlayerScene can call uniformly without
    // platform-checking. `startPlay` returns a session id (or null when
    // disabled / failed) and `endPlay` is best-effort: a missing id or
    // network failure must NEVER throw into the scene shutdown path.
    async startPlay(_kind, _levelId) { return null; },
    async endPlay(_args) { return; },
    // URL shortener: takes a base64 share-string and returns `{code}` or
    // null if the backend is unreachable. Callers fall back to a direct
    // `?play=<base64>` URL when null.
    async shortenShareCode(_shareCode) { return null; },
    async resolveShortCode(_code) { return null; },

    // External-link primitive. Adapters that can pop a new tab override this
    // (web/itch/newgrounds). Sandboxed platforms (YouTube Playables) return
    // false so the UI can hide affordances like the Community Discord button.
    canOpenExternal: false,
    openExternal(_url) { return false; },

    // Ethereum / level-ownership (Milestone I — web-only). Sandboxed
    // platforms (YouTube Playables, Steam, mobile, Newgrounds) keep these
    // no-ops; the publish flow falls back to signature-free behavior.
    // `ethEnabled` is the single source of truth UI uses to show or hide
    // the wallet affordances.
    ethEnabled: false,
    async getConnectedWallet() { return null; },
    async connectWallet() { throw new Error('wallet not supported on this platform'); },
    async disconnectWallet() {},
    async signLevel(_level) { throw new Error('signLevel not supported on this platform'); },
    async mintLevel(_args) { throw new Error('mintLevel not supported on this platform'); },
    // Server-side companion to the on-chain mint. Records tokenId + txHash
    // back on the level record so the bot embed and the public listing can
    // show ownership info. No-op on sandboxed adapters.
    async recordMint(_id, _args) { return false; },

    // Phaser wiring. Subclasses call _firePause / _fireResume / _fireAudio
    // from their SDK hooks; bindGame subscribes to forward those to Phaser.
    bindGame(phaserGame) {
      if (!phaserGame) return;
      this.onPause(() => {
        const scene = phaserGame.scene.scenes.find(s => s.scene.isActive());
        if (scene) phaserGame.scene.pause(scene.scene.key);
        phaserGame.sound.pauseAll();
      });
      this.onResume(() => {
        const scene = phaserGame.scene.scenes.find(s => s.scene.isPaused());
        if (scene) phaserGame.scene.resume(scene.scene.key);
        phaserGame.sound.resumeAll();
      });
      this.onAudioEnabledChange((enabled) => {
        phaserGame.sound.mute = !enabled;
      });
    },

    // Internal fire helpers for adapters to invoke from SDK events.
    _firePause()  { for (const cb of pauseCbs)  { try { cb(); } catch (e) { console.error(e); } } },
    _fireResume() { for (const cb of resumeCbs) { try { cb(); } catch (e) { console.error(e); } } },
    _fireAudio(enabled) { for (const cb of audioCbs) { try { cb(enabled); } catch (e) { console.error(e); } } },
  };

  return adapter;
}
