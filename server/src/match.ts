/**
 * One live match: wraps the shared RoundEngine on a fixed 30 Hz tick and
 * broadcasts 20 Hz snapshots. The server owns EVERYTHING that matters:
 * collisions, knockback, dashes, eliminations, timers, modifiers, winner.
 * Clients only send inputs and render snapshots.
 *
 * Inputs are "latest wins" per player (mirrors the local playerInput bridge):
 * move vector clamped to unit length, dash bit consumed on the tick that
 * receives it. Inputs are only applied while the engine is in 'playing'
 * (a deliberate, safer divergence from the client, which lets a dash pressed
 * during countdown auto-fire at GO).
 */

import {
  RoundEngine,
  type RosterEntry,
} from '../../shared/src/sim/RoundEngine';
import type { Snapshot } from '../../shared/src/net/protocol';
import { ROSTER_COLORS, ROSTER_RADII } from '../../shared/src/net/protocol';
import type { Room } from './rooms';
import { LOBBY_RETURN_MS } from './rooms';

const TICK_HZ = 30;
const SNAP_HZ = 20;

export class Match {
  readonly engine: RoundEngine;
  readonly seed: number;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private tickN = 0;
  private endedAt: number | null = null;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest input per player id; dash bit is consumed once per tick. */
  private inputs = new Map<number, { mx: number; my: number; dash: boolean }>();

  constructor(
    private room: Room,
    seed?: number,
  ) {
    this.seed = seed ?? Math.floor(Math.random() * 0x7fffffff);
    const roster: RosterEntry[] = room.players.map((p) => ({
      name: p.name,
      css: ROSTER_COLORS[(p.id - 1) % ROSTER_COLORS.length],
      radius: ROSTER_RADII[(p.id - 1) % ROSTER_RADII.length],
    }));
    this.engine = new RoundEngine(roster, this.seed);
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
    this.snapTimer = setInterval(() => this.snap(), 1000 / SNAP_HZ);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.tickTimer = this.snapTimer = this.lobbyTimer = null;
  }

  applyInput(id: number, mx: number, my: number, dash: boolean): void {
    this.inputs.set(id, { mx, my, dash });
  }

  private tick(): void {
    this.tickN++;
    const engine = this.engine;
    const playing = engine.phase === 'playing';

    for (const f of engine.fighters) {
      if (!playing) {
        f.input.moveX = 0;
        f.input.moveY = 0;
        continue;
      }
      // Absent players hold the stick neutral: no ghost steering.
      const inp = this.room.isPresent(f.id) ? this.inputs.get(f.id) : undefined;
      if (inp) {
        let { mx, my } = inp;
        const mag = Math.hypot(mx, my);
        if (mag > 1) {
          mx /= mag;
          my /= mag;
        }
        f.input.moveX = mx;
        f.input.moveY = my;
        if (inp.dash) f.dashQueued = true;
        inp.dash = false;
      } else {
        f.input.moveX = 0;
        f.input.moveY = 0;
      }
    }

    engine.update(1 / TICK_HZ);

    if (engine.isOver && this.endedAt === null) this.endedAt = Date.now();
    if (this.endedAt !== null && Date.now() - this.endedAt >= LOBBY_RETURN_MS) {
      this.stop();
      this.room.backToLobby();
    }
  }

  private snap(): void {
    if (this.room.presentCount() === 0) return;
    const e = this.engine;
    const snapshot: Snapshot = {
      tick: this.tickN,
      roundTime: r1(e.roundTime),
      radius: r1(e.phys.arenaRadius),
      slippery: e.slipperyState === 'slippery',
      mod: e.modView,
      players: e.fighters.map((f) => ({
        id: f.id,
        x: r1(f.pos.x),
        y: r1(f.pos.y),
        vx: r1(f.vel.x),
        vy: r1(f.vel.y),
        state: f.state,
        dashT: Math.round(f.dashTimer * 100) / 100,
        dashCd: Math.round(f.dashCooldown * 100) / 100,
      })),
      events: e.drainEvents(),
    };
    this.room.broadcast({ t: 'snap', s: snapshot });
  }
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
