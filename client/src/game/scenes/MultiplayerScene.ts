/**
 * MultiplayerScene: renders the server-authoritative match. Everything the
 * player sees mirrors the schema state (interpolated ~1-2 patches behind);
 * one-shot effects (hits, falls, countdown pops, banners) come from 'ev'
 * MatchEvents. NO local physics runs here — the shared RoundEngine on the
 * server owns positions, collisions, knockback, eliminations and the timer.
 *
 * Solo gameplay lives in GameScene, untouched.
 */

import Phaser from 'phaser';
import {
  ARENA_CENTER,
  ARENA_RADIUS,
  COMBAT,
  DASH,
  PALETTE,
} from '../constants';
import { gameBus } from '../EventBus';
import { sfx } from '../sfx';
import { prefersReducedMotion } from '../motion';
import { SCENE_MP } from './SceneKeys';
import { Fighter } from '../entities/Fighter';
import { mpSession } from '../../multiplayer/NetClient';
import { ROSTER_RADII } from '../../../../shared/src/net/protocol';
import type { GameStateT, PlayerStateT } from '../../../../shared/src/state/schema';
import type { MatchEvent } from '../../../../shared/src/net/protocol';
import type { Obstacle } from '../types';
import {
  confetti,
  cssToColor,
  fmtTime,
  impactBurst,
  impactFlash,
  koText,
  lerpColor,
  splash,
  vibrate,
} from '../fx';

interface ArenaRefs {
  fill: Phaser.GameObjects.Arc;
  tint: Phaser.GameObjects.Arc;
  ring: Phaser.GameObjects.Arc;
  inner1: Phaser.GameObjects.Arc;
  inner2: Phaser.GameObjects.Arc;
}

interface HudRefs {
  timer: Phaser.GameObjects.Text;
  banner: Phaser.GameObjects.Text;
  modBanner: Phaser.GameObjects.Text;
  countdown: Phaser.GameObjects.Text;
  bigText: Phaser.GameObjects.Text;
  winnerSub: Phaser.GameObjects.Text;
  dots: Phaser.GameObjects.Arc[];
}

const SEND_HZ = 30;

export class MultiplayerScene extends Phaser.Scene {
  /** pid -> fighter view. */
  private fighters = new Map<number, Fighter>();
  /** pid -> live schema row (auto-updated by the schema decoder). */
  private rows = new Map<number, PlayerStateT>();
  private bumperViews: { obs: Obstacle; container: Phaser.GameObjects.Container }[] = [];
  private emitters = new Set<Phaser.GameObjects.Particles.ParticleEmitter>();

  private arena!: ArenaRefs;
  private hud!: HudRefs;

  private phase = 'lobby';
  private endReason: 'forfeit' | 'normal' = 'normal';
  private sendTimer = 0;
  private pulseT = 0;
  private resultTimer?: Phaser.Time.TimerEvent;
  private lastFallBy: { pid: number; name: string } | null = null;
  private playerOut = false;
  /** Pids the HUD dots were last built from; dots rebuild when it changes. */
  private dotPids: number[] = [];
  private unsub: (() => void)[] = [];

  constructor() {
    super(SCENE_MP);
  }

  create(): void {
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0xffffff, 1);
    g.fillCircle(8, 8, 8);
    g.generateTexture('dot', 16, 16);
    g.destroy();

    this.buildArena();
    this.buildHud();

    this.unsub.push(
      mpSession.on('ev', (e: MatchEvent) => this.handleEvent(e)),
    );

    this.resetToLobbyView();
  }

  /** Scene teardown (main.ts stops this scene on leave/error). */
  shutdown(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.fighters.clear();
    this.rows.clear();
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
    this.arena = { fill, tint, ring, inner1, inner2 };
  }

  private buildHud(): void {
    const cx = ARENA_CENTER.x;
    const mk = (
      y: number,
      size: number,
      color: string,
      extra: Partial<Phaser.Types.GameObjects.Text.TextStyle> = {},
    ): Phaser.GameObjects.Text =>
      this.add
        .text(cx, y, '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: `${size}px`,
          fontStyle: 'bold',
          color,
          resolution: 2,
          ...extra,
        })
        .setOrigin(0.5, 0.5)
        .setDepth(40)
        .setVisible(false);

    const timer = mk(42, 46, PALETTE.text).setDepth(30).setVisible(true);
    timer.setText('0:00');
    const banner = mk(104, 34, '#ffd23f').setDepth(30);
    const modBanner = mk(152, 28, '#ff9f43').setDepth(30);
    const countdown = mk(ARENA_CENTER.y, 170, PALETTE.text);
    const bigText = mk(ARENA_CENTER.y, 96, PALETTE.text, {
      stroke: '#0e1120',
      strokeThickness: 10,
    });
    const winnerSub = mk(ARENA_CENTER.y + 92, 34, '#aab2d5', {
      stroke: '#0e1120',
      strokeThickness: 6,
    });

    this.hud = { timer, banner, modBanner, countdown, bigText, winnerSub, dots: [] };
  }

  // ------------------------------------------------------------- roster view

  /** Build/refresh the fighter views from the authoritative roster. */
  private ensureFighters(): void {
    const state = mpSession.state;
    if (!state) return;
    const pids = [...state.players.keys()]
      .map(Number)
      .sort((a, b) => a - b);

    // Drop views for players who left.
    for (const pid of [...this.fighters.keys()]) {
      if (!pids.includes(pid)) {
        this.fighters.get(pid)?.container.destroy();
        this.fighters.delete(pid);
      }
    }

    for (const pid of pids) {
      const row = state.players.get(String(pid));
      if (!row) continue;
      const existing = this.fighters.get(pid);
      if (existing) {
        // Color can arrive empty on the first patch; keep the view in sync.
        if (row.css) existing.applyRosterColor(row.css, cssToColor(row.css));
        continue;
      }
      const fighter = new Fighter(this, {
        name: row.name || `P${pid}`,
        color: cssToColor(row.css || '#ffffff'),
        css: row.css || '#ffffff',
        radius: ROSTER_RADII[(pid - 1) % ROSTER_RADII.length],
        isPlayer: pid === mpSession.myPid,
      });
      fighter.pos.x = row.x || ARENA_CENTER.x;
      fighter.pos.y = row.y || ARENA_CENTER.y;
      // Joining mid-match: fighters already eliminated have no fall event left
      // to replay - park their views out of sight instead of floating corpses.
      if (row.state === 'out') {
        fighter.eliminated = true;
        fighter.container.setVisible(false);
      }
      fighter.syncVisual(0);
      this.fighters.set(pid, fighter);
    }
    this.rows.clear();
    for (const pid of pids) {
      const row = state.players.get(String(pid));
      if (row) this.rows.set(pid, row);
    }

    // Mid-match joins/leaves change the roster: rebuild the alive-dots row
    // so indices never point at the wrong player (or a gone one). The lobby
    // needs no dots (the roster list is right there in the panel).
    const wantDots = this.phase !== 'lobby';
    if (wantDots && pids.join(',') !== this.dotPids.join(',')) {
      this.buildDots();
      this.dotPids = pids;
    }
  }

  /** Lobby backdrop: fighters parked on the spawn ring, HUD cleared. */
  private resetToLobbyView(): void {
    this.phase = 'lobby';
    this.endReason = 'normal';
    this.playerOut = false;
    this.lastFallBy = null;
    this.resultTimer?.remove(false);
    this.resultTimer = undefined;
    this.dotPids = [];
    for (const em of this.emitters) em.destroy();
    this.emitters.clear();
    this.despawnBumpers(true);
    this.hud.dots.forEach((d) => d.destroy());
    this.hud.dots = [];
    this.hud.timer.setText('0:00');
    for (const el of [
      this.hud.banner,
      this.hud.modBanner,
      this.hud.countdown,
      this.hud.bigText,
      this.hud.winnerSub,
    ]) {
      this.tweens.killTweensOf(el);
      el.setVisible(false).setAlpha(1).setScale(1).setText('');
    }
    this.arena.fill.setRadius(ARENA_RADIUS);
    this.arena.tint.setRadius(ARENA_RADIUS).setAlpha(0);
    this.arena.ring.setRadius(ARENA_RADIUS).setStrokeStyle(6, PALETTE.arenaRing, 1).setAlpha(1);
    this.arena.inner1.setRadius(ARENA_RADIUS * 0.66);
    this.arena.inner2.setRadius(ARENA_RADIUS * 0.33);

    this.ensureFighters();
    // Park fighters evenly on the spawn ring (visual only; the server
    // positions them for real when the match starts).
    const pids = [...this.fighters.keys()].sort((a, b) => a - b);
    pids.forEach((pid, i) => {
      const f = this.fighters.get(pid)!;
      f.reset();
      const a = ((135 + (360 / Math.max(pids.length, 2)) * i) * Math.PI) / 180;
      const spawnR = ARENA_RADIUS * 0.42;
      f.pos.x = ARENA_CENTER.x + Math.cos(a) * spawnR;
      f.pos.y = ARENA_CENTER.y + Math.sin(a) * spawnR;
      const fl = Math.hypot(ARENA_CENTER.x - f.pos.x, ARENA_CENTER.y - f.pos.y) || 1;
      f.facing.x = (ARENA_CENTER.x - f.pos.x) / fl;
      f.facing.y = (ARENA_CENTER.y - f.pos.y) / fl;
      f.syncVisual(0);
    });
  }

  // ------------------------------------------------------------------ update

  override update(_time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.pulseT += dt;
    const state = mpSession.state;
    if (!state) return;

    // Phase transitions are driven by the authoritative phase field.
    if (state.phase !== this.phase) {
      const prev = this.phase;
      this.phase = state.phase;
      this.onPhaseChange(prev, state.phase);
    }

    this.ensureFighters();

    switch (this.phase) {
      case 'lobby':
        this.fighters.forEach((f) => f.syncVisual(dt));
        break;
      case 'countdown':
        this.syncFromState(dt, false);
        break;
      case 'playing':
        this.syncFromState(dt, true);
        this.sendInput(dt);
        break;
      case 'over':
        this.syncFromState(dt, false);
        break;
    }
  }

  private onPhaseChange(prev: string, next: string): void {
    // Keep body.dataset.phase in sync so CSS (touch controls, menu visibility)
    // and MpUI both see the same phase the scene is rendering.
    document.body.dataset.phase = next === 'lobby' ? 'idle' : next;
    if (next === 'lobby' && prev !== 'lobby') {
      // Victory lap finished: everything resets, the DOM lobby reopens.
      this.resetToLobbyView();
      gameBus.emit('phase', { phase: 'idle' });
    }
    if (next === 'countdown') {
      this.ensureFighters();
      gameBus.emit('phase', { phase: 'countdown' });
    }
    if (next === 'playing') {
      gameBus.emit('phase', { phase: 'playing' });
    }
  }

  /** Mirror authoritative state into the views (interpolated positions). */
  private syncFromState(dt: number, playing: boolean): void {
    const state = mpSession.state!;
    const k = 1 - Math.exp(-dt / 0.09); // ~90 ms smoothing

    for (const [pid, f] of this.fighters) {
      const row = this.rows.get(pid);
      if (!row) continue;
      const dx = row.x - f.pos.x;
      const dy = row.y - f.pos.y;
      if (Math.hypot(dx, dy) > 260) {
        f.pos.x = row.x;
        f.pos.y = row.y;
      } else {
        f.pos.x += dx * k;
        f.pos.y += dy * k;
      }
      // Facing comes straight from the server (Dash.updateFacing runs there).
      if (row.state === 'active') {
        const a = row.facing;
        f.facing.x = Math.cos(a);
        f.facing.y = Math.sin(a);
      }
      f.dashTimer = row.dashT;
      f.dashCooldown = row.dashCd;
      f.kos = row.kos;
      if (row.state === 'falling' && f.state === 'active' && !f.eliminated) {
        // Missed the event (rejoin mid-fall): run the fall FX now.
        this.playFallFx(pid, row);
      }
      f.syncVisual(dt);
    }

    // HUD + arena visuals.
    if (playing || this.phase === 'over') this.hud.timer.setText(fmtTime(state.roundTime));
    this.applyArenaShapes(state.radius);
    this.updateArenaVisuals(state);
    this.syncBumpers(dt);

    // Dash cooldown indicator for the local player.
    const me = mpSession.myPid ? this.rows.get(mpSession.myPid) : undefined;
    if (me) gameBus.emit('dash-cd', { frac: me.dashCd / DASH.cooldown });
  }

  private applyArenaShapes(r: number): void {
    this.arena.fill.setRadius(r);
    this.arena.tint.setRadius(r);
    this.arena.ring.setRadius(r);
    this.arena.inner1.setRadius(r * 0.66);
    this.arena.inner2.setRadius(r * 0.33);
  }

  /** Ring color language + icy tint, driven by state flags. */
  private updateArenaVisuals(state: GameStateT): void {
    const targetTint = state.slippery ? 0.18 : 0;
    this.arena.tint.setAlpha(Phaser.Math.Linear(this.arena.tint.alpha, targetTint, 0.08));

    if (state.sudden) {
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 8);
      this.arena.ring
        .setStrokeStyle(6, lerpColor(PALETTE.danger, 0xffffff, pulse * 0.35), 1)
        .setAlpha(0.75 + 0.25 * pulse);
      return;
    }
    if (state.modStage === 'warn' || state.modStage === 'active') {
      const base = state.modKind === 'bumpers' ? PALETTE.bumper : PALETTE.danger;
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 8);
      this.arena.ring
        .setStrokeStyle(6, lerpColor(base, 0xffffff, pulse * 0.3), 1)
        .setAlpha(0.85 + 0.15 * pulse);
      return;
    }
    const slippery = state.slippery;
    if (this.phase === 'playing' && slippery) {
      this.arena.ring.setStrokeStyle(6, PALETTE.icy, 1).setAlpha(1);
    } else {
      this.arena.ring.setStrokeStyle(6, PALETTE.arenaRing, 1).setAlpha(1);
    }
  }

  // -------------------------------------------------------------- bumpers

  private syncBumpers(dt: number): void {
    const state = mpSession.state!;
    const obs = state.obstacles;
    if (obs.length !== this.bumperViews.length) {
      // Rebuild views when the set changes (spawn/despawn windows).
      this.despawnBumpers(true);
      for (const o of obs) {
        const container = this.add.container(o.x, o.y).setDepth(8);
        const ring = this.add.circle(0, 0, o.radius).setStrokeStyle(6, PALETTE.bumper, 1);
        const core = this.add.circle(0, 0, o.radius - 10, PALETTE.bumperCore, 1);
        const mark = this.add.circle(o.radius * 0.45, 0, 5, PALETTE.bumper, 0.9);
        container.add([core, ring, mark]);
        container.setScale(0.1);
        this.tweens.add({ targets: container, scale: 1, duration: 260, ease: 'Back.easeOut' });
        this.bumperViews.push({
          obs: { pos: { x: o.x, y: o.y }, vel: { x: o.vx, y: o.vy }, radius: o.radius },
          container,
        });
      }
      if (obs.length > 0) sfx.thud();
    }
    for (let i = 0; i < this.bumperViews.length && i < obs.length; i++) {
      const b = this.bumperViews[i];
      const o = obs[i];
      b.obs.pos.x = o.x;
      b.obs.pos.y = o.y;
      b.container.setPosition(o.x, o.y);
      b.container.rotation += dt * 1.8;
    }
  }

  private despawnBumpers(immediate: boolean): void {
    for (const b of this.bumperViews) {
      this.tweens.killTweensOf(b.container);
      if (immediate) {
        b.container.destroy();
      } else {
        this.tweens.add({
          targets: b.container,
          scale: 0.05,
          alpha: 0,
          duration: 220,
          ease: 'Quad.easeIn',
          onComplete: () => b.container.destroy(),
        });
      }
    }
    this.bumperViews = [];
  }

  // ---------------------------------------------------------------- input

  private sendInput(dt: number): void {
    const me = this.rows.get(mpSession.myPid);
    if (!me || me.state !== 'active') {
      // Out of the round: stop steering, drain any queued dash.
      playerInputDrain();
      return;
    }
    this.sendTimer -= dt;
    const { mx, my } = playerInputMove();
    const dash = playerInputConsumeDash();
    // STRICT 30 Hz (+ dash taps): the server disconnects clients above
    // maxMessagesPerSecond (60), and an analog joystick changes value every
    // frame - "send when moved" flooded it at RAF rate and got players
    // dropped mid-match. 30 Hz input latency is imperceptible.
    if (this.sendTimer <= 0 || dash) {
      mpSession.sendInput(mx, my, dash);
      this.sendTimer = 1 / SEND_HZ;
    }
  }

  // ---------------------------------------------------------------- events

  private handleEvent(e: MatchEvent): void {
    switch (e.t) {
      case 'countdown': {
        if (e.n > 0) {
          this.hud.countdown.setVisible(true).setText(String(e.n));
          this.tweens.add({
            targets: this.hud.countdown,
            scale: { from: 1.5, to: 1 },
            alpha: { from: 0.35, to: 1 },
            duration: 280,
            ease: 'Quad.easeOut',
          });
          sfx.tick();
        } else {
          this.hud.countdown.setText('GO!');
          sfx.go();
          this.tweens.add({
            targets: this.hud.countdown,
            alpha: 0,
            scale: 1.6,
            duration: 450,
            onComplete: () => this.hud.countdown.setVisible(false).setAlpha(1).setScale(1),
          });
        }
        break;
      }
      case 'dash': {
        if (e.id === mpSession.myPid) {
          sfx.dash();
          vibrate(10);
        }
        break;
      }
      case 'hit': {
        this.playHitFx(e);
        break;
      }
      case 'fall': {
        const victim = this.fighters.get(e.id);
        const row = this.rows.get(e.id);
        if (victim && row) this.playFallFx(e.id, row, e.byId);
        else if (victim) {
          victim.startFallFx(() => {
            victim.state = 'out';
          });
        }
        const dot = this.hud.dots[this.dotIndex(e.id)];
        if (dot) dot.setAlpha(0.18).setScale(0.7);
        break;
      }
      case 'mod': {
        if (e.stage === 'warn') {
          if (e.kind === 'bumpers') {
            this.hud.modBanner.setText('Bumper balls incoming!').setColor('#ff9f43');
            sfx.thud();
          } else {
            this.hud.modBanner.setText('Arena shrinking!').setColor('#ff5d5d');
            sfx.shrinkWarn();
          }
          this.hud.modBanner.setVisible(true).setAlpha(1);
        } else if (e.stage === 'active') {
          this.hud.modBanner.setAlpha(0.75);
        } else {
          this.hud.modBanner.setVisible(false).setAlpha(1);
        }
        break;
      }
      case 'slippery': {
        if (e.stage === 'warn') {
          this.hud.banner.setText('Slippery floor incoming!').setColor('#ffd23f').setVisible(true).setAlpha(1);
          sfx.warn();
        } else if (e.stage === 'on') {
          this.hud.banner.setText('Slippery floor!').setColor('#7fd8ff').setVisible(true).setAlpha(1);
          sfx.slip();
        } else {
          this.hud.banner.setVisible(false).setAlpha(1);
        }
        break;
      }
      case 'sudden': {
        this.hud.banner
          .setText('Sudden death - arena shrinking!')
          .setColor('#ff5d5d')
          .setVisible(true)
          .setAlpha(1);
        sfx.warn();
        break;
      }
      case 'end': {
        this.endReason = e.reason === 'forfeit' ? 'forfeit' : 'normal';
        this.playEndFx(e.winnerId);
        break;
      }
      case 'phase': {
        if (e.p === 'over') {
          for (const el of [this.hud.banner, this.hud.modBanner]) {
            el.setVisible(false);
          }
        }
        break;
      }
    }
  }

  private playHitFx(e: Extract<MatchEvent, { t: 'hit' }>): void {
    const victim = this.fighters.get(e.victimId);
    const attacker = e.attackerId !== null ? this.fighters.get(e.attackerId) : null;
    if (!victim) return;
    const rm = prefersReducedMotion();
    const fx = rm ? 0.5 : 1;
    const dirDeg = (Math.atan2(e.dirY, e.dirX) * 180) / Math.PI;

    if (e.big) {
      victim.flashWhite();
      victim.squash();
      victim.knock(e.dirX, e.dirY, rm ? 0.5 : 1);
      attacker?.squash();
      attacker?.knock(-e.dirX, -e.dirY, 0.35);
      if (!rm) {
        const k = Phaser.Math.Clamp((e.deltaV - COMBAT.dashBigDeltaV) / 700, 0.35, 1);
        this.cameras.main.shake(COMBAT.shakeMs * k, COMBAT.shakeIntensity * k);
      }
      impactFlash(this, e.x, e.y);
      impactBurst(this, this.emitters, e.x, e.y, victim.def.color, dirDeg, 26, Math.round(12 * fx), 380);
      if (attacker) {
        impactBurst(this, this.emitters, e.x, e.y, attacker.def.color, dirDeg + 180, 34, Math.round(4 * fx), 300);
        sfx.hit(1);
      } else {
        sfx.bump(1);
      }
      vibrate(25);
    } else if (e.deltaV > 380) {
      victim.squash();
      victim.knock(e.dirX, e.dirY, 0.65 * fx + 0.35);
      impactBurst(this, this.emitters, e.x, e.y, victim.def.color, dirDeg, 30, Math.round(6 * fx), 300);
      if (attacker) sfx.hit(0.5);
      else sfx.bump(0.4);
    } else {
      victim.knock(e.dirX, e.dirY, 0.35);
      impactBurst(this, this.emitters, e.x, e.y, victim.def.color, dirDeg, 30, Math.round(3 * fx), 230);
    }
  }

  private playFallFx(pid: number, row: PlayerStateT, byId?: number | null): void {
    const f = this.fighters.get(pid);
    if (!f || f.eliminated) return;
    f.eliminated = true;

    const killerId = byId ?? null;
    if (pid === mpSession.myPid) {
      this.playerOut = true;
      const killer = killerId !== null ? this.rows.get(killerId) : undefined;
      this.lastFallBy = killer ? { pid: killerId!, name: killer.name } : null;
    }

    const dx = f.pos.x - ARENA_CENTER.x;
    const dy = f.pos.y - ARENA_CENTER.y;
    const d = Math.hypot(dx, dy) || 1;
    const rimX = ARENA_CENTER.x + (dx / d) * (mpSession.state?.radius ?? ARENA_RADIUS - 10);
    const rimY = ARENA_CENTER.y + (dy / d) * (mpSession.state?.radius ?? ARENA_RADIUS - 10);
    splash(this, rimX, rimY, f.def.color);
    const inX = ARENA_CENTER.x + (dx / d) * ((mpSession.state?.radius ?? ARENA_RADIUS) - 70);
    const inY = ARENA_CENTER.y + (dy / d) * ((mpSession.state?.radius ?? ARENA_RADIUS) - 70);

    this.time.delayedCall(120, () => {
      const outBy = killerId !== null ? this.rows.get(killerId) : undefined;
      if (pid === mpSession.myPid) {
        koText(
          this,
          inX,
          inY,
          "YOU'RE OUT!",
          '#ff5d5d',
          outBy ? `Knocked out by ${outBy.name}` : null,
        );
        gameBus.emit('player-out', {});
      } else if (killerId === mpSession.myPid) {
        koText(this, inX, inY, `YOU GOT ${row.name.toUpperCase()}!`, '#ffd23f', null);
      } else {
        koText(this, inX, inY, `${row.name} is out!`, '#ffffff', null);
      }
    });
    sfx.fall();
    if (pid === mpSession.myPid) vibrate(45);

    f.startFallFx(() => {
      f.state = 'out';
    });
  }

  private playEndFx(winnerId: number | null): void {
    const winner = winnerId !== null ? this.fighters.get(winnerId) : null;
    const winnerRow = winnerId !== null ? this.rows.get(winnerId) : undefined;
    const isDraw = winnerId === null;
    const iWon = winnerId === mpSession.myPid;

    const forfeit = this.endReason === 'forfeit';
    const text = this.hud.bigText;
    text
      .setVisible(true)
      .setAlpha(0)
      .setScale(0.6)
      .setText(
        forfeit
          ? iWon
            ? 'OPPONENT LEFT'
            : 'YOU LEFT'
          : isDraw
            ? 'DRAW!'
            : iWon
              ? 'YOU WIN!'
              : `${(winnerRow?.name ?? '').toUpperCase()} WINS!`,
      )
      .setColor(isDraw && !forfeit ? PALETTE.text : (winnerRow?.css ?? PALETTE.text));
    this.tweens.add({
      targets: text,
      alpha: { from: 0, to: 1 },
      scale: { from: 0.6, to: 1 },
      duration: 320,
      ease: 'Back.easeOut',
    });

    // Sub-line is cut (the big text says it all); kept only for reset paths.
    this.hud.winnerSub.setVisible(false).setText('');

    if (winner && winnerRow) {
      winner.victory();
      confetti(this, winner.pos.x, winner.pos.y, cssToColor(winnerRow.css), 0);
      confetti(this, winner.pos.x, winner.pos.y, 0xffffff, 160);
      if (iWon) sfx.win();
      else sfx.lose();
    }

    this.resultTimer?.remove(false);
    this.resultTimer = this.time.delayedCall(1400, () => {
      const me = this.rows.get(mpSession.myPid);
      gameBus.emit('result', {
        playerWon: iWon,
        winnerName: isDraw ? 'Nobody' : (winnerRow?.name ?? 'Nobody'),
        winnerCss: isDraw ? PALETTE.text : (winnerRow?.css ?? PALETTE.text),
        roundTime: mpSession.state?.roundTime ?? 0,
        playerKos: me?.kos ?? 0,
        playerOut: this.playerOut,
        outBy: this.lastFallBy?.name ?? null,
        reason: this.endReason,
      });
    });
  }

  // ------------------------------------------------------------------ dots

  private buildDots(): void {
    this.hud.dots.forEach((d) => d.destroy());
    this.hud.dots = [];
    const state = mpSession.state;
    if (!state) return;
    const pids = [...state.players.keys()].map(Number).sort((a, b) => a - b);
    pids.forEach((pid, i) => {
      const row = state.players.get(String(pid));
      const dot = this.add
        .circle(34 + i * 40, 46, 11, cssToColor(row?.css ?? '#ffffff'), 0.95)
        .setDepth(30)
        .setStrokeStyle(2, 0xffffff, 0.25);
      this.hud.dots.push(dot);
    });
  }

  private dotIndex(pid: number): number {
    const state = mpSession.state;
    if (!state) return -1;
    const pids = [...state.players.keys()].map(Number).sort((a, b) => a - b);
    return pids.indexOf(pid);
  }
}

// --- playerInput bridge (kept as functions so the import stays tree-shakeable) ---

import { playerInput } from '../../input/playerInput';

function playerInputMove(): { mx: number; my: number } {
  return { mx: playerInput.moveX, my: playerInput.moveY };
}

function playerInputConsumeDash(): boolean {
  return playerInput.consumeDash();
}

function playerInputDrain(): void {
  playerInput.consumeDash();
}
