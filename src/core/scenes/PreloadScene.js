import Phaser from 'phaser';

// Nothing to preload yet (the whole game is rendered via Graphics). Exists
// for interface parity so the gameReady() signal has a clear home — after
// this scene completes, the first interactive scene (Home) starts.

export default class PreloadScene extends Phaser.Scene {
  constructor() { super({ key: 'Preload' }); }

  preload() {
    // Placeholder — asset loader is a no-op for now.
  }

  create() {
    const platform = this.registry.get('platform');
    try { platform && platform.gameReady(); } catch (e) { console.warn(e); }
    this.scene.start('Home');
  }
}
