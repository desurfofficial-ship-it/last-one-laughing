/**
 * RoundEngine: the authoritative round state machine, shared by the stage-2
 * server. It reproduces GameScene's solo lifecycle with view code removed:
 *
 *   countdown (clamp physics, inputs ignored) -> playing (open physics,
 *   inputs + dashes + modifiers + sudden death) -> over (clamp physics).
 *
 * Parity notes (vs client/src/game/scenes/GameScene.ts at 9262a2f):
 * - applied radius = max(ARENA_MIN_RADIUS, baseRadius - director.shrinkOffset())
 * - sudden death at ROUND.suddenDeathAfter erodes baseRadius at 14 px/s
 * - eliminations: physics `open` boundary + FALL_MARGIN; KO credit to
 *   lastHitById (set on every hit with an attacker, exactly like the client's
 *   onHit handler); fighters turn 'out' after FALL_ANIM_MS
 * - win condition: <= 1 'active' fighter -> winner (or DRAW at 0)
 * - bumper spawns use the seeded RNG (the client's Math.random is the one
 *   piece of sim randomness that could NOT be shared; see docs/stage-2-plan §3)
 * - hit events are emitted with the same visibility gate the client uses
 *   (big OR deltaV >= COMBAT.hitFxMinDeltaV); per-victim FX throttling stays
 *   a client concern.
 *
 * Pure TypeScript: no Phaser, no Node, no DOM. Deterministic for a given
 * (roster, seed, input sequence).
 */

import {
  ARENA_CENTER,
  ARENA_MIN_RADIUS,
  ARENA_RADIUS,
  COMBAT,
  FALL_ANIM_MS,
  MODS,
  ROUND,
} from '../constants';
import { ArenaPhysics } from '../physics/ArenaPhysics';
import { SlipperyFloor, type SlipperyState } from '../modifiers/SlipperyFloor';
import { ModifierDirector, type ModKind } from '../modifiers/ModifierDirector';
import { mulberry32 } from '../util/rng';
import { tryDash, updateFacing } from './Dash';
import type { FighterState, InputState, Obstacle } from '../types';
import type { MatchEvent } from '../net/protocol';

export interface RosterEntry {
  /** Stable net identity. When omitted, defaults to 1-based roster index. */
  id?: number;
  name: string;
  css: string;
  radius: number;
}

/** Server-side fighter state: satisfies the Body contract plus net identity. */
export interface SimFighter {
  id: number;
  name: string;
  css: string;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  input: InputState;
  state: FighterState;
  dashTimer: number;
  dashCooldown: number;
  dashQueued: boolean;
  eliminated: boolean;
  kos: number;
  lastHitById: number | null;
  facing: { x: number; y: number };
  radius: number;
  mass: number;
  invMass: number;
}

export class RoundEngine {
  readonly fighters: SimFighter[] = [];
  readonly phys: ArenaPhysics<SimFighter>;

  phase: 'countdown' | 'playing' | 'over' = 'countdown';
  countdownT = ROUND.countdown;
  roundTime = 0;
  suddenDeath = false;
  /** Set when the round ends: winner id, or null for a draw. */
  winnerId: number | null | undefined = undefined;

  private baseRadius = ARENA_RADIUS;
  private slippery: SlipperyFloor;
  private director: ModifierDirector;
  private rng: () => number;
  private events: MatchEvent[] = [];
  private lastCount = -1;
  /** Engine clock (advances in every phase); drives the fall->out flip. */
  private clock = 0;
  private fellAt = new Map<SimFighter, number>();

  constructor(roster: RosterEntry[], seed: number) {
    if (roster.length < 2) throw new Error('RoundEngine needs at least 2 fighters');
    this.rng = mulberry32(seed);

    // Generalized spawn ring: n evenly spaced angles starting at 135 deg.
    // For n = 4 this reproduces the solo game's SPAWN_ANGLES_DEG exactly.
    // Fighter ids prefer an explicit RosterEntry.id (the server's stable pid)
    // so lobby leave/rejoin gaps never desync inputs, schema writes, or
    // forceOut. When omitted (unit tests), fall back to 1-based index.
    const n = roster.length;
    const spawnR = ARENA_RADIUS * 0.42;
    const usedIds = new Set<number>();
    roster.forEach((entry, i) => {
      const id = entry.id ?? i + 1;
      if (usedIds.has(id)) {
        throw new Error(`RoundEngine: duplicate fighter id ${id}`);
      }
      usedIds.add(id);
      const a = ((135 + (360 / n) * i) * Math.PI) / 180;
      const x = ARENA_CENTER.x + Math.cos(a) * spawnR;
      const y = ARENA_CENTER.y + Math.sin(a) * spawnR;
      const mass = (entry.radius * entry.radius) / 1600;
      const fl = Math.hypot(ARENA_CENTER.x - x, ARENA_CENTER.y - y) || 1;
      this.fighters.push({
        id,
        name: entry.name,
        css: entry.css,
        pos: { x, y },
        vel: { x: 0, y: 0 },
        input: { moveX: 0, moveY: 0 },
        state: 'active',
        dashTimer: 0,
        dashCooldown: 0,
        dashQueued: false,
        eliminated: false,
        kos: 0,
        lastHitById: null,
        facing: { x: (ARENA_CENTER.x - x) / fl, y: (ARENA_CENTER.y - y) / fl },
        radius: entry.radius,
        mass,
        invMass: 1 / mass,
      });
    });

    // Copy the center so callers mutating their constant cannot touch the sim.
    this.phys = new ArenaPhysics<SimFighter>({ ...ARENA_CENTER }, this.fighters);
    this.phys.onHit = (e) => this.handleHit(e);
    this.phys.onFallStart = (f) => this.handleFallStart(f);

    this.slippery = new SlipperyFloor({
      onWarning: () => this.events.push({ t: 'slippery', stage: 'warn' }),
      onSlippery: () => this.events.push({ t: 'slippery', stage: 'on' }),
      onNormal: () => this.events.push({ t: 'slippery', stage: 'off' }),
    });

    this.director = new ModifierDirector({
      onWarn: (kind) => this.events.push({ t: 'mod', kind, stage: 'warn' }),
      onActivate: (kind) => {
        if (kind === 'bumpers') this.spawnBumpers();
        this.events.push({ t: 'mod', kind, stage: 'active' });
      },
      onEnd: (kind) => {
        if (kind === 'bumpers') this.despawnBumpers();
        this.events.push({ t: 'mod', kind, stage: 'end' });
      },
    });

    this.events.push({ t: 'phase', p: 'countdown' });
  }

  get isOver(): boolean {
    return this.phase === 'over';
  }

  get slipperyState(): SlipperyState {
    return this.slippery.state;
  }

  /** Current modifier window for snapshots (warn/active), or null. */
  get modView(): { kind: ModKind; stage: 'warn' | 'active' } | null {
    if (this.director.isWarning || this.director.isActive) {
      const kind = this.director.kind;
      return kind ? { kind, stage: this.director.isWarning ? 'warn' : 'active' } : null;
    }
    return null;
  }

  /** Live bumper balls (for client rendering; empty outside the window). */
  get obstacles(): readonly Obstacle[] {
    return this.phys.obstacles;
  }

  drainEvents(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /**
   * Server authority: remove a fighter whose seat was released mid-match
   * (voluntary leave or reconnection-grace expiry). Goes through the normal
   * fall path so eliminations, KO attribution (none here - leaving is not a
   * kill) and the end-of-round check stay consistent. Works in countdown too:
   * a released seat must never linger as an invisible collider (its schema
   * row is already gone, so clients cannot even render it) - if the fall
   * leaves fewer than two active fighters the round resolves on the spot as
   * a forfeit instead of running with a ghost. `forfeit` marks the round end
   * so clients can show "Opponent left" instead of a normal KO win.
   * No-op once the round is over.
   */
  forceOut(id: number, forfeit = true): void {
    if (this.phase === 'over') return;
    const f = this.fighters.find((x) => x.id === id);
    if (!f || f.state !== 'active') return;
    f.state = 'falling';
    f.lastHitById = null;
    this.handleFallStart(f);
    const alive = this.fighters.filter((x) => x.state === 'active');
    if (alive.length <= 1) this.endRound(alive[0]?.id ?? null, forfeit ? 'forfeit' : 'normal');
  }

  update(dt: number): void {
    this.clock += dt;
    // Falling fighters finish their fall animation in ANY phase (the client's
    // fx tween does the same), then leave the sim entirely.
    for (const f of this.fighters) {
      if (f.state === 'falling') {
        const at = this.fellAt.get(f);
        if (at !== undefined && this.clock - at >= FALL_ANIM_MS / 1000) {
          f.state = 'out';
        }
      }
    }

    switch (this.phase) {
      case 'countdown': {
        this.countdownT -= dt;
        const n = Math.ceil(this.countdownT);
        if (n !== this.lastCount && n > 0) {
          this.lastCount = n;
          this.events.push({ t: 'countdown', n });
        }
        if (this.countdownT <= 0) {
          this.phase = 'playing';
          this.events.push({ t: 'phase', p: 'playing' }, { t: 'countdown', n: 0 });
        }
        this.phys.step(dt, false, 'clamp');
        break;
      }
      case 'playing': {
        this.roundTime += dt;
        this.slippery.update(dt);
        this.director.update(dt);

        if (!this.suddenDeath && this.roundTime > ROUND.suddenDeathAfter) {
          this.beginSuddenDeath();
        }
        if (this.suddenDeath) {
          this.baseRadius = Math.max(
            ARENA_MIN_RADIUS,
            this.baseRadius - ROUND.suddenDeathShrink * dt,
          );
        }
        this.phys.arenaRadius = Math.max(
          ARENA_MIN_RADIUS,
          this.baseRadius - this.director.shrinkOffset(),
        );

        for (const f of this.fighters) updateFacing(f, dt);
        for (const f of this.fighters) {
          if (tryDash(f)) this.events.push({ t: 'dash', id: f.id });
        }

        this.phys.step(dt, this.slippery.isSlippery(), 'open');

        const alive = this.fighters.filter((f) => f.state === 'active');
        if (alive.length <= 1) this.endRound(alive[0]?.id ?? null);
        break;
      }
      case 'over':
        this.phys.step(dt, false, 'clamp');
        break;
    }
  }

  // ------------------------------------------------------------ game events

  private handleHit(e: {
    x: number;
    y: number;
    deltaV: number;
    big: boolean;
    victim: SimFighter;
    attacker: SimFighter | null;
    dirX: number;
    dirY: number;
  }): void {
    // KO attribution happens on EVERY hit with an attacker (same as client).
    if (e.attacker) e.victim.lastHitById = e.attacker.id;
    // FX events use the same visibility gate the client applies before fx.
    if (!e.big && e.deltaV < COMBAT.hitFxMinDeltaV) return;
    this.events.push({
      t: 'hit',
      x: e.x,
      y: e.y,
      deltaV: e.deltaV,
      big: e.big,
      victimId: e.victim.id,
      attackerId: e.attacker?.id ?? null,
      dirX: e.dirX,
      dirY: e.dirY,
    });
  }

  private handleFallStart(f: SimFighter): void {
    f.eliminated = true;
    const byId = f.lastHitById !== null && f.lastHitById !== f.id ? f.lastHitById : null;
    if (byId !== null) {
      const killer = this.fighters.find((k) => k.id === byId);
      if (killer) killer.kos++;
    }
    this.fellAt.set(f, this.clock);
    this.events.push({ t: 'fall', id: f.id, byId });
  }

  private endRound(winnerId: number | null, reason: 'forfeit' | 'normal' = 'normal'): void {
    // 'over' (not 'playing') so a countdown forfeit resolves immediately
    // instead of waiting for GO with one fighter standing alone.
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.winnerId = winnerId;
    this.slippery.silence();
    this.director.cancel();
    this.despawnBumpers();
    // Victory-lap radius (resetWorld does the full restore next round).
    this.phys.arenaRadius = Math.max(ARENA_MIN_RADIUS, this.baseRadius);
    this.events.push({ t: 'phase', p: 'over' }, { t: 'end', winnerId, reason });
  }

  private beginSuddenDeath(): void {
    this.suddenDeath = true;
    this.director.cancel();
    this.events.push({ t: 'sudden' });
  }

  // -------------------------------------------------------------- modifiers

  /** Same spawn math as GameScene.spawnBumpers, with the seeded RNG. */
  private spawnBumpers(): void {
    this.despawnBumpers();
    const R = this.phys.arenaRadius;
    const startDeg = this.rng() * 360;
    for (let i = 0; i < MODS.bumperCount; i++) {
      const a = ((startDeg + i * (360 / MODS.bumperCount)) * Math.PI) / 180;
      const spawnR = Math.max(120, R - 90);
      const ox = ARENA_CENTER.x + Math.cos(a) * spawnR;
      const oy = ARENA_CENTER.y + Math.sin(a) * spawnR;
      const dir = a + Math.PI + (this.rng() - 0.5) * 1.2;
      this.phys.obstacles.push({
        pos: { x: ox, y: oy },
        vel: { x: Math.cos(dir) * MODS.bumperSpeed, y: Math.sin(dir) * MODS.bumperSpeed },
        radius: MODS.bumperRadius,
      });
    }
  }

  private despawnBumpers(): void {
    this.phys.obstacles = [];
  }
}
