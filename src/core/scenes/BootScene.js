import Phaser from 'phaser';

// First scene. Its only responsibility is to signal the platform SDK that a
// frame has been drawn, so the platform knows the splash/loading UI is up.
// For YouTube Playables this is the firstFrameReady() call that MUST happen
// before gameReady() or certification fails.

export default class BootScene extends Phaser.Scene {
  constructor() { super({ key: 'Boot' }); }

  create() {
    const platform = this.registry.get('platform');
    // Draw something so the first frame isn't literally blank.
    const { width, height } = this.scale;
    this.add.text(width / 2, height / 2, 'Blockyard', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '32px',
      color: '#e6edf5',
    }).setOrigin(0.5);

    // Signal firstFrameReady on the NEXT frame, after Phaser has committed
    // this draw to the canvas.
    this.time.delayedCall(0, () => {
      try { platform && platform.firstFrameReady(); } catch (e) { console.warn(e); }
      this.scene.start('Preload');
    });
  }
}
