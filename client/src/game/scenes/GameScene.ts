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
  MODS,
  PALETTE,
  ROUND,
  SPAWN_ANGLES_DEG,
  TUTORIAL_KEY,
} from '../constants';
import { gameBus } from '../EventBus';
import { sfx } from '../sfx';
import { isTouchDevice, prefersReducedMotion } from '../motion';
import { SCENE_GAME } from './SceneKeys';
import { ArenaPhysics } from '../physics/ArenaPhysics';
import { SlipperyFloor } from '../modifiers/SlipperyFloor';
import { ModifierDirector } from '../modifiers/ModifierDirector';
import { Fighter } from '../entities/Fighter';
import { BotController } from '../entities/BotController';
import { playerInput } from '../../input/playerInput';
import type { FighterDef } from '../constants';
import type { HitEvent, Obstacle } from '../types';
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
  modBanner: Phaser.GameObjects.Text;
  hint: Phaser.GameObjects.Text;
  countdown: Phaser.GameObjects.Text;
  bigText: Phaser.GameObjects.Text;
  winnerSub: Phaser.GameObjects.Text;
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
  /** Radius the arena "wants" to be: ARENA_RADIUS, eroded by sudden death.
   *  The shrink modifier subtracts its own temporary offset from this. */
  private baseRadius = ARENA_RADIUS;
  private pulseT = 0;
  private resultTimer?: Phaser.Time.TimerEvent;

  private director!: ModifierDirector;
  /** Visual + sim handles for live bumper balls. */
  private bumperViews: { obs: Obstacle; container: Phaser.GameObjects.Container }[] = [];
  /** True until the first-round tutorial hints have played once ever. */
  private tutorialActive = false;

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

    // Bumpers + shrink are scheduled here; slippery keeps its own cycle.
    // Banners live in separate HUD slots so warnings never overwrite each
    // other, and the two systems compose (icy floor + bumpers = chaos, on
    // purpose).
    this.director = new ModifierDirector({
      onWarn: (kind) => {
        if (kind === 'bumpers') {
          this.hud.modBanner.setText('Bumper balls incoming!').setColor('#ff9f43');
          sfx.thud();
        } else {
          this.hud.modBanner.setText('Arena shrinking!').setColor('#ff5d5d');
          sfx.shrinkWarn();
        }
        this.hud.modBanner.setVisible(true).setAlpha(1);
      },
      onActivate: (kind) => {
        if (kind === 'bumpers') this.spawnBumpers();
        this.hud.modBanner.setAlpha(0.75);
      },
      onEnd: (kind) => {
        if (kind === 'bumpers') this.despawnBumpers();
        this.hud.modBanner.setVisible(false).setAlpha(1);
      },
    });

    try {
      this.tutorialActive = localStorage.getItem(TUTORIAL_KEY) !== '1';
    } catch {
      this.tutorialActive = true;
    }

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

    const modBanner = this.add
      .text(cx, 152, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '28px',
        fontStyle: 'bold',
        color: '#ff9f43',
        resolution: 2,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(30)
      .setVisible(false);

    const hint = this.add
      .text(cx, ARENA_CENTER.y + 235, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '27px',
        fontStyle: 'bold',
        color: '#aab2d5',
        stroke: '#0e1120',
        strokeThickness: 5,
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

    this.hud = { timer, banner, modBanner, hint, countdown, bigText, winnerSub, dots };
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
    this.phys.obstacles = [];
    this.roundTime = 0;
    this.suddenDeath = false;
    this.baseRadius = ARENA_RADIUS;
    this.pulseT = 0;
    this.slippery.silence();
    this.director?.reset();
    this.lastFxAt.clear();
    for (const em of this.hitEmitters) em.destroy();
    this.hitEmitters.clear();
    this.bumperViews.forEach((b) => b.container.destroy());
    this.bumperViews = [];

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
    this.tweens.killTweensOf(this.hud.modBanner);
    this.tweens.killTweensOf(this.hud.hint);
    this.hud.countdown.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.bigText.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.winnerSub.setVisible(false).setAlpha(1).setScale(1).setText('');
    this.hud.banner.setVisible(false).setAlpha(1);
    this.hud.modBanner.setVisible(false).setAlpha(1);
    this.hud.hint.setVisible(false).setAlpha(1);
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
      obstacles: this.phys.obstacles,
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
      // First tutorial hint rides along with the 3-2-1 (first round only).
      if (this.tutorialActive) {
        this.hud.hint
          .setText(isTouchDevice() ? 'Drag anywhere to move' : 'Move with WASD or arrows')
          .setVisible(true)
          .setAlpha(1);
      }
    }
    if (this.countdownT <= 0) {
      this.setPhase('playing');
      this.hud.countdown.setText('GO!');
      sfx.go();
      // Second tutorial hint lands right at GO, and fades on its own.
      if (this.tutorialActive) {
        this.hud.hint
          .setText(isTouchDevice() ? 'Tap DASH to slam them off!' : 'Press Space to dash!')
          .setVisible(true)
          .setAlpha(1);
        this.tweens.add({
          targets: this.hud.hint,
          alpha: 0,
          delay: 3400,
          duration: 400,
          onComplete: () => this.hud.hint.setVisible(false),
        });
      }
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
      obstacles: this.phys.obstacles,
    };
    for (const bot of this.bots) bot.update(dt, ctx);
    this.phys.step(dt, false, 'clamp');
    this.fighters.forEach((f) => f.syncVisual(dt));
  }

  private updatePlaying(dt: number): void {
    this.roundTime += dt;
    this.hud.timer.setText(fmtTime(this.roundTime));

    this.slippery.update(dt);
    this.director.update(dt);

    if (!this.suddenDeath && this.roundTime > ROUND.suddenDeathAfter) this.beginSuddenDeath();
    if (this.suddenDeath) {
      // Sudden death erodes the BASE radius; the shrink modifier subtracts
      // its own temporary offset further down.
      this.baseRadius = Math.max(ARENA_MIN_RADIUS, this.baseRadius - ROUND.suddenDeathShrink * dt);
    }
    this.phys.arenaRadius = Math.max(ARENA_MIN_RADIUS, this.baseRadius - this.director.shrinkOffset());

    // Tutorial fallback: stop hinting after the opening seconds even if the
    // player never dashed.
    if (this.tutorialActive && this.roundTime > 8) this.completeTutorial();

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
      obstacles: this.phys.obstacles,
    };
    for (const bot of this.bots) bot.update(dt, ctx);

    for (const f of this.fighters) {
      if (f.requestDash()) {
        if (f === this.player) {
          sfx.dash();
          vibrate(10);
          this.completeTutorial();
        }
      }
    }

    this.phys.step(dt, this.slippery.isSlippery(), 'open');
    this.updateArenaVisuals();
    this.syncBumpers(dt);
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
    // Reduced-motion users: keep the hitstop + flash (they communicate timing)
    // but skip camera shake, halve particles and halve the knock offset.
    const rm = prefersReducedMotion();
    const fx = rm ? 0.5 : 1;

    if (e.big) {
      e.victim.flashWhite();
      e.victim.squash();
      e.victim.knock(e.dirX, e.dirY, rm ? 0.5 : 1);
      e.attacker?.squash();
      e.attacker?.knock(-e.dirX, -e.dirY, 0.35); // view-only recoil
      this.phys.freezeFor(COMBAT.freezeMs);
      if (!rm) {
        // Subtle shake, scaled by how hard the hit actually was.
        const k = Phaser.Math.Clamp((e.deltaV - COMBAT.dashBigDeltaV) / 700, 0.35, 1);
        this.cameras.main.shake(COMBAT.shakeMs * k, COMBAT.shakeIntensity * k);
      }
      this.impactFlash(e.x, e.y);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 26, Math.round(12 * fx), 380);
      if (e.attacker) {
        // Small counter-spray back toward the attacker reads as impact debris.
        this.impactBurst(e.x, e.y, e.attacker.def.color, dirDeg + 180, 34, Math.round(4 * fx), 300);
      }
      if (e.attacker) sfx.hit(1);
      else sfx.bump(1);
      vibrate(25);
    } else if (e.deltaV > 380) {
      e.victim.squash();
      e.victim.knock(e.dirX, e.dirY, 0.65 * fx + 0.35);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 30, Math.round(6 * fx), 300);
      if (e.attacker) sfx.hit(0.5);
      else sfx.bump(0.4);
    } else {
      // Light contact: minimal directional feedback, silent.
      e.victim.knock(e.dirX, e.dirY, 0.35);
      this.impactBurst(e.x, e.y, e.victim.def.color, dirDeg, 30, Math.round(3 * fx), 230);
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
        this.koText(inX, inY, `YOU GOT ${f.def.name.toUpperCase()}!`, '#ffd23f', null);
      } else {
        this.koText(inX, inY, `${f.def.name} is out!`, '#ffffff', null);
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
      // The DOM out-card (UIManager) takes over from here: it tells the
      // player they're out and offers "watch who wins" vs "leave match".
      gameBus.emit('player-out', {});
    }
  }

  private endRound(winner: Fighter | null): void {
    if (this.phase !== 'playing') return;
    this.setPhase('over');
    this.slippery.silence();
    this.director.cancel();
    this.despawnBumpers();
    this.hud.modBanner.setVisible(false);
    this.hud.hint.setVisible(false);
    this.hud.banner.setVisible(false);
    // Snap the arena back to its base size for the victory lap; resetWorld
    // does the full restore on the next round.
    this.phys.arenaRadius = Math.max(ARENA_MIN_RADIUS, this.baseRadius);
    this.applyArenaShapes(this.phys.arenaRadius);

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

    // Sub-line is cut (the big text says it all); kept only for reset paths.
    this.hud.winnerSub.setVisible(false).setText('');

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
    // No further modifier windows once sudden death begins; an active window
    // (shrink) eases back out gracefully instead of fighting the erosion.
    this.director.cancel();
    this.hud.banner
      .setText('Sudden death - arena shrinking!')
      .setColor('#ff5d5d')
      .setVisible(true)
      .setAlpha(1);
    sfx.warn();
  }

  /** Ring color / radius / banner pulse / icy tint, driven per frame while
   *  playing. The radius is applied from phys.arenaRadius so sudden death and
   *  the shrink modifier share one source of truth. */
  private updateArenaVisuals(): void {
    this.applyArenaShapes(this.phys.arenaRadius);

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
    // Modifier ring language: orange pulse for bumpers, red pulse for the
    // shrinking arena (distinct from the icy/warn slippery colors).
    if (this.director.isWarning || this.director.isActive) {
      const kind = this.director.kind;
      const base = kind === 'bumpers' ? PALETTE.bumper : PALETTE.danger;
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 8);
      this.arena.ring
        .setStrokeStyle(6, lerpColor(base, 0xffffff, pulse * 0.3), 1)
        .setAlpha(0.85 + 0.15 * pulse);
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

  /** Mirror the physics radius into the arena shapes. */
  private applyArenaShapes(r: number): void {
    this.arena.fill.setRadius(r);
    this.arena.tint.setRadius(r);
    this.arena.ring.setRadius(r);
    this.arena.inner1.setRadius(r * 0.66);
    this.arena.inner2.setRadius(r * 0.33);
  }

  // ------------------------------------------------------------ modifiers

  /** Spawn the bumper-ball window: two balls enter from opposite edges and
   *  sweep across the arena, bouncing off the rim and each other. */
  private spawnBumpers(): void {
    this.despawnBumpers(); // safety: never double-spawn
    const R = this.phys.arenaRadius;
    const startDeg = Math.random() * 360;
    for (let i = 0; i < MODS.bumperCount; i++) {
      const a = ((startDeg + i * (360 / MODS.bumperCount)) * Math.PI) / 180;
      const spawnR = Math.max(120, R - 90);
      const ox = ARENA_CENTER.x + Math.cos(a) * spawnR;
      const oy = ARENA_CENTER.y + Math.sin(a) * spawnR;
      // Aim roughly across the center with some scatter so paths differ.
      const dir = a + Math.PI + (Math.random() - 0.5) * 1.2;
      const obs: Obstacle = {
        pos: { x: ox, y: oy },
        vel: { x: Math.cos(dir) * MODS.bumperSpeed, y: Math.sin(dir) * MODS.bumperSpeed },
        radius: MODS.bumperRadius,
      };
      this.phys.obstacles.push(obs);

      const container = this.add.container(ox, oy).setDepth(8);
      const ring = this.add.circle(0, 0, obs.radius).setStrokeStyle(6, PALETTE.bumper, 1);
      const core = this.add.circle(0, 0, obs.radius - 10, PALETTE.bumperCore, 1);
      const mark = this.add.circle(obs.radius * 0.45, 0, 5, PALETTE.bumper, 0.9);
      container.add([core, ring, mark]);
      container.setScale(0.1);
      this.tweens.add({ targets: container, scale: 1, duration: 260, ease: 'Back.easeOut' });
      this.bumperViews.push({ obs, container });
    }
  }

  private despawnBumpers(): void {
    if (this.bumperViews.length === 0) return;
    this.phys.obstacles = [];
    for (const b of this.bumperViews) {
      this.tweens.killTweensOf(b.container);
      this.tweens.add({
        targets: b.container,
        scale: 0.05,
        alpha: 0,
        duration: 220,
        ease: 'Quad.easeIn',
        onComplete: () => b.container.destroy(),
      });
    }
    this.bumperViews = [];
  }

  private syncBumpers(dt: number): void {
    for (const b of this.bumperViews) {
      b.container.setPosition(b.obs.pos.x, b.obs.pos.y);
      b.container.rotation += dt * 1.8;
    }
  }

  // -------------------------------------------------------------- tutorial

  /** Mark the first-round hints as done (persisted) and fade the hint out. */
  private completeTutorial(): void {
    if (!this.tutorialActive) return;
    this.tutorialActive = false;
    try {
      localStorage.setItem(TUTORIAL_KEY, '1');
    } catch {
      /* private mode: hints simply replay next session */
    }
    this.tweens.killTweensOf(this.hud.hint);
    this.tweens.add({
      targets: this.hud.hint,
      alpha: 0,
      duration: 300,
      onComplete: () => this.hud.hint.setVisible(false).setAlpha(1),
    });
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
