/**
 * GameScene: owns the arena, round flow, in-canvas HUD and feedback.
 * Phases: idle (menu backdrop) -> countdown -> playing -> over.
 * Menus and touch controls live in the DOM layer (see ui/ and input/).
 */

import Phaser from 'phaser';
import {
  ARENA_CENTER,
  ARENA_MIN_RADIUS,
  ARENA_RADIUS,
  COMBAT,
  DASH,
  FIGHTER_DEFS,
  LOL_TEXTS,
  LOGICAL_HEIGHT,
  PALETTE,
  ROUND,
  SPAWN_ANGLES_DEG,
} from '../constants';
import { gameBus } from '../EventBus';
import { sfx } from '../sfx';
import { SCENE_GAME } from './SceneKeys';
import { ArenaPhysics } from '../physics/ArenaPhysics';
import { SlipperyFloor } from '../modifiers/SlipperyFloor';
import { Fighter } from '../entities/Fighter';
import { BotController } from '../entities/BotController';
import { playerInput } from '../../input/playerInput';
import type { FighterDef } from '../constants';
import type { HitEvent } from '../types';
import type { Phase } from '../types';

interface ArenaRefs {
  fill: Phaser.GameObjects.Arc;
  tint: Phaser.GameObjects.Arc;
  ring: Phaser.GameObjects.Arc;
  inner1: Phaser.GameObjects.Arc;
  inner2: Phaser.GameObjects.Arc;
  baseRingColor: number;
}

interface HudRefs {
  timer: Phaser.GameObjects.Text;
  banner: Phaser.GameObjects.Text;
  countdown: Phaser.GameObjects.Text;
  bigText: Phaser.GameObjects.Text;
  spectate: Phaser.GameObjects.Text;
  dots: Phaser.GameObjects.Arc[];
}

export class GameScene extends Phaser.Scene {
  private fighters: Fighter[] = [];
  private player!: Fighter;
  private bots: BotController[] = [];
  private phys!: ArenaPhysics<Fighter>;
  private slippery!: SlipperyFloor;

  private phase: Phase = 'idle';
  private countdownT = 0;
  private lastCount = -1;
  private roundTime = 0;
  private suddenDeath = false;
  private pulseT = 0;
  private resultTimer?: Phaser.Time.TimerEvent;

  private arena!: ArenaRefs;
  private hud!: HudRefs;

  constructor() {
    super(SCENE_GAME);
  }

  create(): void {
    // Shared 16px white dot texture for particles (no external assets).
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xffffff, 1);
    g.fillCircle(8, 8, 8);
    g.generateTexture('dot', 16, 16);
    g.destroy();

    this.buildArena();
    this.buildFighters();
    this.buildHud();

    this.phys = new ArenaPhysics<Fighter>(ARENA_CENTER, this.fighters);
    this.phys.onHit = (e) => this.handleHit(e);
    this.phys.onFallStart = (f) => this.handleFallStart(f);

    this.slippery = new SlipperyFloor({
      onWarning: () => {
        this.hud.banner.setText('Slippery floor incoming!').setColor('#ffd23f').setVisible(true);
        sfx.warn();
      },
      onSlippery: () => {
        this.hud.banner.setText('Slippery floor!').setColor('#7fd8ff').setVisible(true).setAlpha(1);
        sfx.slip();
      },
      onNormal: () => {
        this.hud.banner.setVisible(false).setAlpha(1);
      },
    });

    this.resetWorld();
    this.setPhase('idle');
  }

  // ---------------------------------------------------------------- builders

  private buildArena(): void {
    const cx = ARENA_CENTER.x;
    const cy = ARENA_CENTER.y;
    const fill = this.add.circle(cx, cy, ARENA_RADIUS, PALETTE.arenaFill).setDepth(0);
    const inner1 = this.add
      .circle(cx, cy, ARENA_RADIUS * 0.66)
      .setStrokeStyle(2, PALETTE.arenaInner, 0.6)
      .setDepth(1);
    const inner2 = this.add
      .circle(cx, cy, ARENA_RADIUS * 0.33)
      .setStrokeStyle(2, PALETTE.arenaInner, 0.6)
      .setDepth(1);
    this.add.circle(cx, cy, 8, PALETTE.arenaInner, 0.9).setDepth(1);
    const tint = this.add.circle(cx, cy, ARENA_RADIUS, PALETTE.icy, 0).setDepth(2);
    const ring = this.add
      .circle(cx, cy, ARENA_RADIUS)
      .setStrokeStyle(6, PALETTE.arenaRing, 1)
      .setDepth(3);
    this.arena = { fill, tint, ring, inner1, inner2, baseRingColor: PALETTE.arenaRing };
  }

  private buildFighters(): void {
    FIGHTER_DEFS.forEach((def: FighterDef) => {
      const fighter = new Fighter(this, def);
      this.fighters.push(fighter);
      if (def.isPlayer) this.player = fighter;
      else this.bots.push(new BotController(fighter, this.fighters));
    });
  }

  private buildHud(): void {
    const cx = ARENA_CENTER.x;
    const timer = this.add
      .text(cx, 42, '0:00', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '46px',
        fontStyle: 'bold',
        color: PALETTE.text,
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(30);

    const banner = this.add
      .text(cx, 104, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        fontStyle: 'bold',
        color: '#ffd23f',
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(30)
      .setVisible(false);

    const countdown = this.add
      .text(cx, ARENA_CENTER.y, '3', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '170px',
        fontStyle: 'bold',
        color: PALETTE.text,
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(40)
      .setVisible(false);

    const bigText = this.add
      .text(cx, ARENA_CENTER.y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '96px',
        fontStyle: 'bold',
        color: PALETTE.text,
        stroke: '#0e1120',
        strokeThickness: 10,
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(40)
      .setVisible(false);

    const spectate = this.add
      .text(cx, LOGICAL_HEIGHT - 150, "You're out - spectating", {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#8b93b8',
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(30)
      .setVisible(false);

    const dots = FIGHTER_DEFS.map((def, i) =>
      this.add
        .circle(34 + i * 40, 46, 11, def.color, 0.95)
        .setDepth(30)
        .setStrokeStyle(2, 0xffffff, 0.25),
    );

    this.hud = { timer, banner, countdown, bigText, spectate, dots };
  }

  // ------------------------------------------------------------ round flow

  private setPhase(phase: Phase): void {
    this.phase = phase;
    gameBus.emit('phase', { phase });
  }

  /** Start a fresh round (also used for restart). */
  startRound(): void {
    this.resultTimer?.remove(false);
    this.resetWorld();
    this.countdownT = ROUND.countdown;
    this.lastCount = -1;
    this.setPhase('countdown');
  }

  /** Return to the idle menu backdrop. */
  toIdle(): void {
    this.resultTimer?.remove(false);
    this.resetWorld();
    this.setPhase('idle');
  }

  private resetWorld(): void {
    this.phys.arenaRadius = ARENA_RADIUS;
    this.roundTime = 0;
    this.suddenDeath = false;
    this.pulseT = 0;
    this.slippery.silence();

    this.fighters.forEach((f, i) => {
      f.reset();
      const a = (SPAWN_ANGLES_DEG[i] * Math.PI) / 180;
      const spawnR = ARENA_RADIUS * 0.55;
      f.pos.x = ARENA_CENTER.x + Math.cos(a) * spawnR;
      f.pos.y = ARENA_CENTER.y + Math.sin(a) * spawnR;
      f.facing.x = ARENA_CENTER.x - f.pos.x;
      f.facing.y = ARENA_CENTER.y - f.pos.y;
      const fl = Math.hypot(f.facing.x, f.facing.y) || 1;
      f.facing.x /= fl;
      f.facing.y /= fl;
      f.syncVisual(0);
    });

    // Arena + HUD back to defaults.
    this.arena.fill.setRadius(ARENA_RADIUS);
    this.arena.tint.setRadius(ARENA_RADIUS).setAlpha(0);
    this.arena.ring.setRadius(ARENA_RADIUS).setStrokeStyle(6, PALETTE.arenaRing, 1).setAlpha(1);
    this.arena.inner1.setRadius(ARENA_RADIUS * 0.66);
    this.arena.inner2.setRadius(ARENA_RADIUS * 0.33);

    this.tweens.killTweensOf(this.hud.countdown);
    this.tweens.killTweensOf(this.hud.bigText);
    this.tweens.killTweensOf(this.hud.banner);
    this.hud.countdown.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.bigText.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.banner.setVisible(false).setAlpha(1);
    this.hud.spectate.setVisible(false);
    this.hud.timer.setVisible(true).setText('0:00');
    this.hud.dots.forEach((d) => d.setAlpha(0.95).setScale(1));
  }

  // ----------------------------------------------------------------- update

  override update(_time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.pulseT += dt;

    switch (this.phase) {
      case 'idle':
        this.updateIdle(dt);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'playing':
        this.updatePlaying(dt);
        break;
      case 'over':
        this.phys.step(dt, false, 'clamp');
        this.fighters.forEach((f) => f.syncVisual(dt));
        break;
    }
  }

  private updateIdle(dt: number): void {
    const ctx = {
      phase: 'idle' as Phase,
      center: ARENA_CENTER,
      radius: this.phys.arenaRadius,
      slippery: false,
    };
    for (const bot of this.bots) bot.update(dt, ctx);
    this.phys.step(dt, false, 'clamp');
    this.fighters.forEach((f) => f.syncVisual(dt));
  }

  private updateCountdown(dt: number): void {
    this.countdownT -= dt;
    const n = Math.ceil(this.countdownT);
    if (n !== this.lastCount && n > 0) {
      this.lastCount = n;
      this.hud.countdown.setVisible(true).setText(String(n));
      this.tweens.add({
        targets: this.hud.countdown,
        scale: { from: 1.5, to: 1 },
        alpha: { from: 0.35, to: 1 },
        duration: 280,
        ease: 'Quad.easeOut',
      });
      sfx.tick();
    }
    if (this.countdownT <= 0) {
      this.setPhase('playing');
      this.hud.countdown.setText('GO!');
      sfx.go();
      this.tweens.add({
        targets: this.hud.countdown,
        alpha: 0,
        scale: 1.6,
        duration: 450,
        onComplete: () => {
          this.hud.countdown.setVisible(false).setAlpha(1).setScale(1);
        },
      });
    }

    const ctx = {
      phase: 'countdown' as Phase,
      center: ARENA_CENTER,
      radius: this.phys.arenaRadius,
      slippery: false,
    };
    for (const bot of this.bots) bot.update(dt, ctx);
    this.phys.step(dt, false, 'clamp');
    this.fighters.forEach((f) => f.syncVisual(dt));
  }

  private updatePlaying(dt: number): void {
    this.roundTime += dt;
    this.hud.timer.setText(fmtTime(this.roundTime));

    this.slippery.update(dt);

    if (!this.suddenDeath && this.roundTime > ROUND.suddenDeathAfter) this.beginSuddenDeath();
    if (this.suddenDeath) this.shrinkArena(dt);

    // Player input (bridged from the DOM input layer).
    const player = this.player;
    if (player.state === 'active') {
      player.input.moveX = playerInput.moveX;
      player.input.moveY = playerInput.moveY;
      if (playerInput.consumeDash()) player.dashQueued = true;
    } else {
      playerInput.consumeDash();
    }

    const ctx = {
      phase: 'playing' as Phase,
      center: ARENA_CENTER,
      radius: this.phys.arenaRadius,
      slippery: this.slippery.isSlippery(),
    };
    for (const bot of this.bots) bot.update(dt, ctx);

    for (const f of this.fighters) {
      if (f.dashQueued && f.requestDash() && f === this.player) sfx.dash();
    }

    this.phys.step(dt, this.slippery.isSlippery(), 'open');
    this.updateArenaVisuals();
    this.fighters.forEach((f) => f.syncVisual(dt));
    gameBus.emit('dash-cd', { frac: player.dashCooldown / DASH.cooldown });

    const alive = this.fighters.filter((f) => f.state === 'active');
    if (alive.length <= 1) this.endRound(alive[0] ?? null);
  }

  // ------------------------------------------------------------ game events

  private handleHit(e: HitEvent<Fighter>): void {
    if (e.attacker) e.victim.lastHitBy = e.attacker;
    this.burst(e.x, e.y, e.victim.def.color, e.big ? 16 : 8);
    if (e.big) {
      e.victim.flashWhite();
      e.victim.squash();
      this.phys.freezeFor(COMBAT.freezeMs);
      this.cameras.main.shake(COMBAT.shakeMs, COMBAT.shakeIntensity);
      sfx.hit(1);
      vibrate(25);
    } else if (e.deltaV > 380) {
      e.victim.squash();
      sfx.hit(0.4);
    }
  }

  private handleFallStart(f: Fighter): void {
    f.eliminated = true;
    if (f.lastHitBy && f.lastHitBy !== f) f.lastHitBy.kos++;

    const dx = f.pos.x - ARENA_CENTER.x;
    const dy = f.pos.y - ARENA_CENTER.y;
    const d = Math.hypot(dx, dy) || 1;
    const rimX = ARENA_CENTER.x + (dx / d) * (this.phys.arenaRadius - 10);
    const rimY = ARENA_CENTER.y + (dy / d) * (this.phys.arenaRadius - 10);

    this.splash(rimX, rimY, f.def.color);
    const inX = ARENA_CENTER.x + (dx / d) * (this.phys.arenaRadius - 70);
    const inY = ARENA_CENTER.y + (dy / d) * (this.phys.arenaRadius - 70);
    this.time.delayedCall(120, () => this.lolText(inX, inY));
    sfx.fall();
    vibrate(45);

    f.startFallFx(() => {
      f.state = 'out';
    });

    const idx = this.fighters.indexOf(f);
    const dot = this.hud.dots[idx];
    if (dot) dot.setAlpha(0.18).setScale(0.7);

    if (f.isPlayer) this.hud.spectate.setVisible(true);
  }

  private endRound(winner: Fighter | null): void {
    if (this.phase !== 'playing') return;
    this.setPhase('over');
    this.slippery.silence();
    this.hud.spectate.setVisible(false);
    this.hud.banner.setVisible(false);

    const text = this.hud.bigText;
    text
      .setVisible(true)
      .setAlpha(0)
      .setScale(0.6)
      .setText(winner ? (winner.isPlayer ? 'YOU WIN!' : `${winner.def.name.toUpperCase()} WINS!`) : 'DRAW!')
      .setColor(winner ? winner.def.css : PALETTE.text);
    this.tweens.add({
      targets: text,
      alpha: { from: 0, to: 1 },
      scale: { from: 0.6, to: 1 },
      duration: 320,
      ease: 'Back.easeOut',
    });
    if (winner?.isPlayer) {
      winner.victory();
      sfx.win();
    }

    this.resultTimer = this.time.delayedCall(1400, () => {
      gameBus.emit('result', {
        playerWon: !!winner?.isPlayer,
        winnerName: winner ? winner.def.name : 'Nobody',
        winnerCss: winner ? winner.def.css : PALETTE.text,
        roundTime: this.roundTime,
        playerKos: this.player.kos,
        playerOut: this.player.eliminated,
        outBy: this.player.lastHitBy?.def.name ?? null,
      });
    });
  }

  private beginSuddenDeath(): void {
    this.suddenDeath = true;
    this.hud.banner.setText('Arena shrinking!').setColor('#ff5d5d').setVisible(true).setAlpha(1);
    sfx.warn();
  }

  private shrinkArena(dt: number): void {
    const r = Math.max(ARENA_MIN_RADIUS, this.phys.arenaRadius - ROUND.suddenDeathShrink * dt);
    this.phys.arenaRadius = r;
    this.arena.fill.setRadius(r);
    this.arena.tint.setRadius(r);
    this.arena.ring.setRadius(r);
    this.arena.inner1.setRadius(r * 0.66);
    this.arena.inner2.setRadius(r * 0.33);
  }

  /** Ring color / banner pulse / icy tint, driven per frame while playing. */
  private updateArenaVisuals(): void {
    const targetTint = this.slippery.isSlippery() ? 0.18 : 0;
    const tint = this.arena.tint;
    tint.setAlpha(Phaser.Math.Linear(tint.alpha, targetTint, 0.08));

    const state = this.slippery.state;
    if (this.suddenDeath) {
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 8);
      this.arena.ring
        .setStrokeStyle(6, lerpColor(PALETTE.danger, 0xffffff, pulse * 0.35), 1)
        .setAlpha(0.75 + 0.25 * pulse);
      return;
    }
    if (state === 'warning') {
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 9);
      this.arena.ring
        .setStrokeStyle(6, lerpColor(PALETTE.arenaRing, PALETTE.warning, pulse), 1)
        .setAlpha(1);
      this.hud.banner.setAlpha(0.6 + 0.4 * pulse);
    } else if (state === 'slippery') {
      this.arena.ring.setStrokeStyle(6, PALETTE.icy, 1).setAlpha(1);
    } else {
      this.arena.ring.setStrokeStyle(6, PALETTE.arenaRing, 1).setAlpha(1);
    }
  }

  // ------------------------------------------------------------- fx helpers

  private burst(x: number, y: number, tint: number, count: number): void {
    const emitter = this.add
      .particles(x, y, 'dot', {
        speed: { min: 140, max: 430 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 220, max: 430 },
        scale: { start: 0.9, end: 0 },
        blendMode: 'ADD',
        tint,
        emitting: false,
      })
      .setDepth(20);
    emitter.explode(count);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  private splash(x: number, y: number, color: number): void {
    const ring = this.add.circle(x, y, 26).setStrokeStyle(5, color, 0.9).setDepth(24);
    this.tweens.add({
      targets: ring,
      scale: { from: 0.4, to: 1.8 },
      alpha: { from: 0.9, to: 0 },
      duration: 380,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  private lolText(x: number, y: number): void {
    const text = LOL_TEXTS[Math.floor(Math.random() * LOL_TEXTS.length)];
    const label = this.add
      .text(x, y, text, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        fontStyle: 'bold',
        color: '#ffffff',
        stroke: '#0e1120',
        strokeThickness: 6,
        resolution: 2,
      })
      .setOrigin(0.5)
      .setDepth(25);
    this.tweens.add({
      targets: label,
      y: y - 70,
      alpha: { from: 0, to: 1 },
      duration: 150,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: label,
          alpha: 0,
          duration: 420,
          delay: 260,
          onComplete: () => label.destroy(),
        });
      },
    });
  }
}

// -------------------------------------------------------------------- utils

function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate(ms);
  } catch {
    /* unsupported (e.g. iOS Safari) */
  }
}
