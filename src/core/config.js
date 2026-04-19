import Phaser from 'phaser';
import BootScene from './scenes/BootScene.js';
import PreloadScene from './scenes/PreloadScene.js';
import HomeScene from './scenes/HomeScene.js';
import EditorScene from './scenes/EditorScene.js';
import PlayerScene from './scenes/PlayerScene.js';
import LevelSelectScene from './scenes/LevelSelectScene.js';
import CommunityScene from './scenes/CommunityScene.js';
import { BG_COLOR } from './constants.js';

// Responsive Scale.FIT + CENTER_BOTH supports every aspect ratio from 9:32
// through 32:9 without orientation lock — meets the YouTube Playables spec
// without extra per-platform glue.

export const gameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  // Transparent canvas so the HTML body's background (the CSS checker in
  // menu scenes, or the board-aligned checker LetterboxChecker paints in
  // editor/player) extends visually through the letterbox AND under any
  // gaps in the scene layout.
  transparent: true,
  backgroundColor: BG_COLOR,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 720,
    height: 1080,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  input: {
    activePointers: 2,
    touch: true,
  },
  scene: [BootScene, PreloadScene, HomeScene, EditorScene, PlayerScene, LevelSelectScene, CommunityScene],
};
