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
  winnerSub: Phaser.GameObjects.Text;
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

  /** Live impact-burst emitters (hard cap keeps pile-ups cheap on mobile). */
  private hitEmitters = new Set<Phaser.GameObjects.Particles.ParticleEmitter>();
  /** Victim -> time of last non-big feedback, to throttle grind re-contacts. */
  private lastFxAt = new Map<Fighter, number>();

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

    const winnerSub = this.add
      .text(cx, ARENA_CENTER.y + 92, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        fontStyle: 'bold',
        color: '#aab2d5',
        stroke: '#0e1120',
        strokeThickness: 6,
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(40)
      .setVisible(false);

    const dots = FIGHTER_DEFS.map((def, i) =>
      this.add
        .circle(34 + i * 40, 46, 11, def.color, 0.95)
        .setDepth(30)
        .setStrokeStyle(2, 0xffffff, 0.25),
    );

    this.hud = { timer, banner, countdown, bigText, winnerSub, spectate, dots };
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
    // Drop stale dash requests pressed during "over"/menus so a new round
    // never opens with an uncontrolled auto-dash at GO.
    playerInput.consumeDash();
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
    this.phys.clearFreeze();
    this.roundTime = 0;
    this.suddenDeath = false;
    this.pulseT = 0;
    this.slippery.silence();
    this.lastFxAt.clear();
    for (const em of this.hitEmitters) em.destroy();
    this.hitEmitters.clear();

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
    this.tweens.killTweensOf(this.hud.winnerSub);
    this.tweens.killTweensOf(this.hud.banner);
    this.hud.countdown.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.bigText.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.winnerSub.setVisible(false).setAlpha(1).setScale(1).setText('');
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

    const now = this.time.now;
    // Severity gating. Resting nudges produce nothing at all; non-big
    // feedback on the same victim is throttled so grinding contests in
    // pile-ups no longer machine-gun particles (seen on device footage).
    if (!e.big) {
      if (e.deltaV < COMBAT.hitFxMinDeltaV) return;
      if (now - (this.lastFxAt.get(e.victim) ?? -Infinity) < COMBAT.pairFxCooldownMs) return;
    }
    this.lastFxAt.set(e.victim, now);

    const dirDeg = (Math.atan2(e.dirY, e.dirX) * 180) / Math.PI;

    if (e.big) {
      e.victim.flashWhite();
      e.victim.squash();
      e.victim.knock(e.dirX, e.dirY, 1);
      e.attacker?.squash();
      e.attacker?.knock(-e.dirX, -e.dirY, 0.35); // view-only recoil
      this.phys.freezeFor(COMBAT.freezeMs);
      // Subtle shake, scaled by how hard the hit actually was.
      const k = Phaser.Math.Clamp((e.deltaV - COMBAT.dashBigDeltaV) / 700, 0.35, 1);
      this.cameras.main.shake(COMBAT.shakeMs * k, COMBAT.shakeIntensity * k);
      this.impactFlash(e.x, e.y);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 26, 12, 380);
      if (e.attacker) {
        // Small counter-spray back toward the attacker reads as impact debris.
        this.impactBurst(e.x, e.y, e.attacker.def.color, dirDeg + 180, 34, 4, 300);
      }
      sfx.hit(1);
      vibrate(25);
    } else if (e.deltaV > 380) {
      e.victim.squash();
      e.victim.knock(e.dirX, e.dirY, 0.65);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 30, 6, 300);
      sfx.hit(0.5);
    } else {
      // Light contact: minimal directional feedback, silent.
      e.victim.knock(e.dirX, e.dirY, 0.35);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 30, 3, 230);
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
    this.time.delayedCall(120, () => {
      const outBy = f.lastHitBy && f.lastHitBy !== f ? f.lastHitBy : null;
      if (f.isPlayer) {
        this.koText(inX, inY, "YOU'RE OUT!", '#ff5d5d', outBy ? `Knocked out by ${outBy.def.name}` : null);
      } else if (outBy?.isPlayer) {
        this.koText(inX, inY, `YOU GOT ${f.def.name.toUpperCase()}!`, '#ffd23f', `${f.def.name} is out!`);
      } else {
        const cheer = LOL_TEXTS[Math.floor(Math.random() * LOL_TEXTS.length)];
        this.koText(inX, inY, cheer, '#ffffff', `${f.def.name} is out!`);
      }
    });
    sfx.fall();
    vibrate(45);

    f.startFallFx(() => {
      f.state = 'out';
    });

    const idx = this.fighters.indexOf(f);
    const dot = this.hud.dots[idx];
    if (dot) dot.setAlpha(0.18).setScale(0.7);

    if (f.isPlayer) {
      this.hud.spectate.setVisible(true);
      gameBus.emit('player-out', {});
    }
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

    const sub = this.hud.winnerSub;
    sub
      .setVisible(true)
      .setAlpha(0)
      .setText(winner ? (winner.isPlayer ? 'Last one laughing.' : 'Better luck next round.') : "Nobody's laughing...");
    this.tweens.add({
      targets: sub,
      alpha: { from: 0, to: 1 },
      duration: 380,
      delay: 220,
      ease: 'Quad.easeOut',
    });

    if (winner) {
      // Every winner celebrates now (previously only the player did).
      winner.victory();
      this.confetti(winner.pos.x, winner.pos.y, winner.def.color, 0);
      this.confetti(winner.pos.x, winner.pos.y, 0xffffff, 160);
      if (winner.isPlayer) sfx.win();
      else sfx.lose();
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

  /** Directional impact burst. dirDeg is the shove direction; particles spray
   *  within ±spreadDeg of it. Capped concurrent emitters keep pile-ups cheap. */
  private impactBurst(
    x: number,
    y: number,
    tint: number,
    dirDeg: number,
    spreadDeg: number,
    count: number,
    speed: number,
  ): void {
    if (this.hitEmitters.size >= 6) {
      const oldest = this.hitEmitters.values().next().value;
      if (oldest) {
        this.hitEmitters.delete(oldest);
        oldest.destroy();
      }
    }
    const emitter = this.add
      .particles(x, y, 'dot', {
        speed,
        angle: { min: dirDeg - spreadDeg, max: dirDeg + spreadDeg },
        lifespan: { min: 180, max: 380 },
        scale: { start: 0.75, end: 0 },
        blendMode: 'ADD',
        tint,
        emitting: false,
      })
      .setDepth(20);
    this.hitEmitters.add(emitter);
    emitter.explode(count);
    this.time.delayedCall(430, () => {
      this.hitEmitters.delete(emitter);
      emitter.destroy();
    });
  }

  /** Short white flash ring at the contact point (big hits only). */
  private impactFlash(x: number, y: number): void {
    const ring = this.add
      .circle(x, y, 20)
      .setStrokeStyle(4, 0xffffff, 0.95)
      .setDepth(21)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: ring,
      scale: { from: 0.4, to: 1.7 },
      alpha: { from: 0.95, to: 0 },
      duration: 170,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  /** Winner-colored confetti pop with upward bias and gravity. */
  private confetti(x: number, y: number, tint: number, delayMs: number): void {
    this.time.delayedCall(delayMs, () => {
      if (this.phase !== 'over') return;
      const emitter = this.add
        .particles(x, y, 'dot', {
          speed: { min: 220, max: 520 },
          angle: { min: 200, max: 340 },
          lifespan: { min: 500, max: 800 },
          scale: { start: 0.9, end: 0 },
          gravityY: 900,
          blendMode: 'ADD',
          tint,
          emitting: false,
        })
        .setDepth(22);
      emitter.explode(12);
      this.time.delayedCall(900, () => emitter.destroy());
    });
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

  /** Floating knockout messaging: a bold main line plus a small info sub-line. */
  private koText(x: number, y: number, main: string, color: string, sub: string | null): void {
    const label = this.add
      .text(x, y, main, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        fontStyle: 'bold',
        color,
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

    if (!sub) return;
    const subLabel = this.add
      .text(x, y + 44, sub, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        fontStyle: 'bold',
        color: '#aab2d5',
        stroke: '#0e1120',
        strokeThickness: 4,
        resolution: 2,
      })
      .setOrigin(0.5)
      .setDepth(25);
    this.tweens.add({
      targets: subLabel,
      y: y + 44 - 70,
      alpha: { from: 0, to: 0.95 },
      duration: 150,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: subLabel,
          alpha: 0,
          duration: 420,
          delay: 340,
          onComplete: () => subLabel.destroy(),
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
