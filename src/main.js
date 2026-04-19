// Entry point. Resolve the platform adapter BEFORE instantiating Phaser so
// platform SDKs (ytgame for YouTube Playables, etc.) have had a chance to
// attach before any scene runs.

import Phaser from 'phaser';
import { platform, platformName } from './platform/index.js';
import { gameConfig } from './core/config.js';

async function boot() {
  try {
    await platform.init();
  } catch (e) {
    console.error(`[main] platform(${platformName}) init failed — continuing anyway`, e);
  }
  const game = new Phaser.Game(gameConfig);
  platform.bindGame(game);
  // Make the adapter + platform name reachable to scenes without each scene
  // re-importing (handy for scene-specific platform branches).
  game.registry.set('platform', platform);
  game.registry.set('platformName', platformName);
}

boot();
