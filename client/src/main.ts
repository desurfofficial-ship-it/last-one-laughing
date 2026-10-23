import Phaser from 'phaser';
import './styles.css';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './game/constants';
import { gameBus } from './game/EventBus';
import { sfx } from './game/sfx';
import { GameScene } from './game/scenes/GameScene';
import { MultiplayerScene } from './game/scenes/MultiplayerScene';
import { SCENE_GAME, SCENE_MP } from './game/scenes/SceneKeys';
import { InputManager } from './input/InputManager';
import { MpUI } from './ui/MpUI';
import { UIManager } from './ui/UIManager';
import { mpSession } from './multiplayer/NetClient';
import type { UiCommand } from './game/types';

/**
 * Bootstrap: creates the Phaser game (fixed logical resolution, scaled to
 * fit any screen) and wires the DOM input/menu layers to it via gameBus.
 * Solo runs in GameScene; multiplayer swaps to MultiplayerScene.
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
  scene: [GameScene, MultiplayerScene],
});

const zone = document.getElementById('joystick-zone');
const dashBtn = document.getElementById('dash-button');
if (zone && dashBtn) new InputManager(zone, dashBtn);
new UIManager();
new MpUI();

// Multiplayer session lifecycle: swap scenes when the session becomes real.
let mpActive = false;
mpSession.on('entered', () => {
  document.body.dataset.mode = 'mp';
  if (mpActive) return;
  mpActive = true;
  game.scene.stop(SCENE_GAME);
  if (!game.scene.isActive(SCENE_MP)) game.scene.start(SCENE_MP);
});

mpSession.on('left', (p: { intentional: boolean }) => {
  if (p.intentional) {
    mpActive = false;
    game.scene.stop(SCENE_MP);
    game.scene.start(SCENE_GAME);
    document.body.dataset.mode = 'solo';
  }
  // Unexpected drops keep the MP scene alive; mpSession drives the
  // reconnecting banner and re-binds when the token rejoin lands.
});

mpSession.on('status', (status: string) => {
  const banner = document.getElementById('mp-reconnect');
  const text = document.getElementById('mp-reconnect-text');
  if (!banner || !text) return;
  if (status === 'reconnecting') {
    text.textContent = 'Connection lost - reconnecting to your seat…';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
});

// A terminal session failure (seat expired, room died while we were in it)
// must not leave the frozen multiplayer scene as the only screen: fall back
// to the solo menu. First-join failures arrive while mpActive is still
// false, so they are untouched - the lobby form already shows the reason.
mpSession.on('error', () => {
  if (!mpActive || mpSession.connected) return;
  mpActive = false;
  game.scene.stop(SCENE_MP);
  game.scene.start(SCENE_GAME);
  document.body.dataset.mode = 'solo';
});

gameBus.on('cmd', (payload: any) => {
  const action = payload?.action as UiCommand;
  switch (action) {
    case 'start':
      sfx.unlock();
      if (mpActive) return; // matches are started from the lobby UI only
      {
        const scene = game.scene.getScene(SCENE_GAME) as GameScene | null;
        scene?.startRound();
      }
      break;
    case 'restart':
      if (mpActive) return;
      game.scene.resume(SCENE_GAME);
      (game.scene.getScene(SCENE_GAME) as GameScene | null)?.startRound();
      break;
    case 'pause':
      if (mpActive) return;
      game.scene.pause(SCENE_GAME);
      break;
    case 'resume':
      sfx.unlock();
      if (mpActive) return;
      game.scene.resume(SCENE_GAME);
      break;
    case 'menu':
      if (mpActive) {
        mpSession.requestLeave(); // fires 'left' -> scene swap above
      } else {
        game.scene.resume(SCENE_GAME);
        (game.scene.getScene(SCENE_GAME) as GameScene | null)?.toIdle();
      }
      break;
  }
});

// Block browser gestures (scroll bounce, pull-to-refresh, pinch zoom) WITHOUT
// breaking menu button taps. A blanket preventDefault on every touchmove is
// known to suppress the synthetic click on some iOS Safari versions, which
// left the start screen looking completely static.
document.addEventListener(
  'touchmove',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, button, a, label, .overlay, .panel')) return;
    e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('contextmenu', (e) => e.preventDefault());
