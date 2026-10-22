import Phaser from 'phaser';
import './styles.css';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './game/constants';
import { gameBus } from './game/EventBus';
import { sfx } from './game/sfx';
import { GameScene } from './game/scenes/GameScene';
import { SCENE_GAME } from './game/scenes/SceneKeys';
import { InputManager } from './input/InputManager';
import { UIManager } from './ui/UIManager';
import type { UiCommand } from './game/types';

/**
 * Bootstrap: creates the Phaser game (fixed logical resolution, scaled to
 * fit any screen) and wires the DOM input/menu layers to it via gameBus.
 */

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: LOGICAL_WIDTH,
  height: LOGICAL_HEIGHT,
  backgroundColor: '#0e1120',
  disableContextMenu: true,
  // SFX are synthesized with WebAudio directly; Phaser's sound manager is off.
  audio: { noAudio: true },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [GameScene],
});

const zone = document.getElementById('joystick-zone');
const dashBtn = document.getElementById('dash-button');
if (zone && dashBtn) new InputManager(zone, dashBtn);
new UIManager();

gameBus.on('cmd', (payload: any) => {
  const action = payload?.action as UiCommand;
  const scene = game.scene.getScene(SCENE_GAME) as GameScene | null;
  if (!scene) return;
  switch (action) {
    case 'start':
      sfx.unlock();
      scene.startRound();
      break;
    case 'restart':
      game.scene.resume(SCENE_GAME);
      scene.startRound();
      break;
    case 'pause':
      game.scene.pause(SCENE_GAME);
      break;
    case 'resume':
      sfx.unlock();
      game.scene.resume(SCENE_GAME);
      break;
    case 'menu':
      game.scene.resume(SCENE_GAME);
      scene.toIdle();
      break;
  }
});

// Block browser gestures (scroll bounce, pull-to-refresh, pinch zoom).
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
