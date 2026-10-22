/**
 * RoundEngine unit tests: lifecycle, modifiers, elimination/attribution,
 * draw, and determinism. The engine is pure, so tests drive it with a fixed
 * 1/30 s step and a compressed clock (75 s of sudden death takes ms).
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_RADIUS,
  MODS,
  ROUND,
  SLIPPERY,
} from '../../shared/src/constants';
import { RoundEngine, type RosterEntry } from '../../shared/src/sim/RoundEngine';
import { mulberry32 } from '../../shared/src/util/rng';

const TICK = 1 / 30;
const CENTER = 540;

const ROSTER: RosterEntry[] = [
  { name: 'A', css: '#ffd23f', radius: 40 },
  { name: 'B', css: '#ff5d5d', radius: 40 },
];

function makeEngine(seed = 1): RoundEngine {
  return new RoundEngine(ROSTER, seed);
}

function run(e: RoundEngine, seconds: number): void {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps; i++) e.update(TICK);
}

function runUntil(e: RoundEngine, seconds: number, stop: () => boolean): void {
  const steps = Math.round(seconds / TICK);
  for (let i = 0; i < steps && !stop(); i++) e.update(TICK);
}

/** Filter events from a SINGLE drain (drainEvents is destructive). */
function ofT(events: any[], t: string): any[] {
  return events.filter((ev) => ev.t === t);
}

describe('RoundEngine lifecycle', () => {
  it('runs countdown then playing, emitting 3-2-1 and GO', () => {
    const e = makeEngine();
    expect(e.phase).toBe('countdown');
    run(e, ROUND.countdown + 0.05);
    expect(e.phase).toBe('playing');
    const batch = e.drainEvents();
    const counts = ofT(batch, 'countdown').map((ev) => ev.n);
    expect(counts).toEqual(expect.arrayContaining([3, 2, 1, 0])); // 0 = GO
    expect(ofT(batch, 'phase').map((ev) => ev.p)).toContain('playing');
  });

  it('countdown keeps fighters inside the arena (clamp) and holds dashes until GO', () => {
    const e = makeEngine();
    const [a, b] = e.fighters;
    a.input.moveX = 1;
    b.input.moveY = -1;
    a.dashQueued = true;
    for (let i = 0; i < 89; i++) e.update(TICK); // still countdown
    expect(e.phase).toBe('countdown');
    expect(a.dashQueued).toBe(true); // untouched while counting down
    for (const f of e.fighters) {
      expect(Math.hypot(f.pos.x - CENTER, f.pos.y - CENTER)).toBeLessThan(420); // clamp held
    }
    expect(ofT(e.drainEvents(), 'dash')).toHaveLength(0);
    // Float note: 3 - 90*(1/30) leaves ~4e-16, so GO can land a tick later.
    for (let i = 0; i < 5 && e.phase === 'countdown'; i++) e.update(TICK);
    expect(e.phase).toBe('playing');
    expect(a.dashQueued).toBe(true); // the flip tick runs countdown physics only
    e.update(TICK); // first real playing tick
    expect(a.dashQueued).toBe(false); // consumed now
    const go = e.drainEvents();
    expect(ofT(go, 'dash').map((ev) => ev.id)).toContain(a.id);
  });

  it('spawns n fighters evenly (4 players reproduce the solo spawn angles)', () => {
    const e = new RoundEngine(
      [...ROSTER, { name: 'C', css: '#3ddc97', radius: 38 }, { name: 'D', css: '#4da3ff', radius: 36 }],
      1,
    );
    // Solo angles: 135 + 90*i degrees.
    const expected = [135, 225, 315, 45];
    e.fighters.forEach((f, i) => {
      const dx = f.pos.x - CENTER;
      const dy = f.pos.y - CENTER;
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      expect(deg).toBeCloseTo(expected[i], 3);
      expect(f.id).toBe(i + 1);
    });
  });
});

describe('RoundEngine modifiers', () => {
  // Bumper balls physically shove stationary test fighters; the modifier
  // tests below disable their SPAWN (not their schedule) for isolation.
  const origBumperCount = MODS.bumperCount;

  it('cycles slippery warn -> on -> off with the documented timing', () => {
    MODS.bumperCount = 0;
    try {
      const e = makeEngine();
      run(e, ROUND.countdown);
      e.drainEvents();
      run(e, SLIPPERY.normal + SLIPPERY.warning + 0.1);
      expect(ofT(e.drainEvents(), 'slippery').map((ev) => ev.stage)).toEqual(['warn', 'on']);
      run(e, SLIPPERY.slippery + 0.1);
      expect(ofT(e.drainEvents(), 'slippery').map((ev) => ev.stage)).toEqual(['off']);
    } finally {
      MODS.bumperCount = origBumperCount;
    }
  });

  it('warns, then spawns seeded bumper balls, then clears them', () => {
    const e = makeEngine(42);
    run(e, ROUND.countdown);
    e.drainEvents();
    run(e, MODS.firstDelay + MODS.warn + 0.1);
    expect(e.phys.obstacles.length).toBe(MODS.bumperCount);
    const batch = e.drainEvents();
    const stages = ofT(batch, 'mod').map((ev) => `${ev.kind}:${ev.stage}`);
    expect(stages).toContain('bumpers:warn');
    expect(stages).toContain('bumpers:active');
    run(e, MODS.bumperDuration + 0.1);
    expect(e.phys.obstacles.length).toBe(0);
    expect(ofT(e.drainEvents(), 'mod').map((ev) => ev.stage)).toContain('end');
  });

  it('bumper spawns are deterministic for a given seed', () => {
    const e1 = makeEngine(1234);
    const e2 = makeEngine(1234);
    run(e1, ROUND.countdown + MODS.firstDelay + MODS.warn + 1);
    run(e2, ROUND.countdown + MODS.firstDelay + MODS.warn + 1);
    expect(e2.phys.obstacles).toEqual(e1.phys.obstacles);
  });

  it('shrinks the arena during the shrink window and restores it', () => {
    MODS.bumperCount = 0; // schedule intact, no physical interference
    try {
      const e = makeEngine(7);
      // bumpers run first: firstDelay + warn + bumperDuration + restBetween + warn
      const preShrink =
        ROUND.countdown + MODS.firstDelay + MODS.warn + MODS.bumperDuration + MODS.restBetween + MODS.warn;
      run(e, preShrink + MODS.shrinkDuration / 2);
      expect(e.phys.arenaRadius).toBeLessThan(ARENA_RADIUS - MODS.shrinkAmount * 0.4);
      run(e, MODS.shrinkDuration / 2 + MODS.shrinkRestore + 0.2);
      expect(e.phys.arenaRadius).toBeCloseTo(ARENA_RADIUS, 0);
    } finally {
      MODS.bumperCount = origBumperCount;
    }
  });

  it('begins sudden death after 75s and erodes the radius', () => {
    MODS.bumperCount = 0; // keep stationary fighters alive until 75s
    try {
      const e = makeEngine(3);
      run(e, ROUND.countdown + 0.02);
      e.drainEvents();
      // +0.5s headroom: 2250 accumulated 1/30 ticks can land at 74.999... 
      run(e, ROUND.suddenDeathAfter + 0.5);
      expect(ofT(e.drainEvents(), 'sudden')).toHaveLength(1);
      run(e, 10);
      expect(e.suddenDeath).toBe(true);
      expect(e.phys.arenaRadius).toBeLessThan(ARENA_RADIUS - ROUND.suddenDeathShrink * 9);
    } finally {
      MODS.bumperCount = origBumperCount;
    }
  });
});

describe('RoundEngine eliminations', () => {
  it('a dash into a fighter near the rim eliminates them, credits the KO, ends the round', () => {
    const e = makeEngine(11);
    run(e, ROUND.countdown + 0.1); // -> playing (past float residue)
    e.drainEvents();
    const [a, b] = e.fighters;
    // B floats near the rim on +x; A lines up 160 px inward.
    b.pos.x = CENTER + ARENA_RADIUS - 30;
    b.pos.y = CENTER;
    a.pos.x = b.pos.x - 160;
    a.pos.y = CENTER;
    a.facing.x = 1;
    a.facing.y = 0;
    a.input.moveX = 1; // dash direction follows input
    a.dashQueued = true;

    runUntil(e, 6, () => e.isOver);

    expect(e.isOver).toBe(true);
    expect(b.state === 'falling' || b.state === 'out').toBe(true);
    expect(b.eliminated).toBe(true);
    expect(a.kos).toBe(1);
    expect(e.winnerId).toBe(a.id);
    const batch = e.drainEvents();
    expect(ofT(batch, 'fall').some((ev) => ev.id === b.id && ev.byId === a.id)).toBe(true);
    const end = ofT(batch, 'end');
    expect(end).toHaveLength(1);
    expect(end[0].winnerId).toBe(a.id);
  });

  it('ends in a draw when the last two fighters leave the arena together', () => {
    const e = makeEngine(11);
    run(e, ROUND.countdown + 0.1); // fully into playing before placing near the rim
    e.drainEvents();
    const [a, b] = e.fighters;
    a.pos.x = CENTER + ARENA_RADIUS - 10;
    a.vel.x = 900;
    b.pos.x = CENTER - ARENA_RADIUS + 10;
    b.vel.x = -900;
    run(e, 1);
    expect(e.isOver).toBe(true);
    expect(e.winnerId).toBeNull();
    expect(ofT(e.drainEvents(), 'end')[0].winnerId).toBeNull();
  });

  it('flips fallen fighters to out after the fall animation window', () => {
    const e = makeEngine(11);
    run(e, ROUND.countdown + 0.1);
    const [, b] = e.fighters;
    b.pos.x = CENTER + ARENA_RADIUS - 10;
    b.vel.x = 900;
    run(e, 1); // fall + anim window (450 ms) both pass
    expect(b.state).toBe('out');
  });
});

describe('RoundEngine determinism', () => {
  it('same seed + same input script -> bit-identical trajectories', () => {
    // Pre-generate the input script once, then replay it identically.
    const gen = mulberry32(5);
    const steps = 900; // 30 s: crosses the first bumper window
    const moveX: number[] = [];
    const moveY: number[] = [];
    const dashA: boolean[] = [];
    const dashB: boolean[] = [];
    for (let s = 0; s < steps; s++) {
      moveX.push(gen() * 2 - 1);
      moveY.push(gen() * 2 - 1);
      dashA.push(s % 97 === 1);
      dashB.push(s % 149 === 2);
    }
    const feed = (e: RoundEngine, s: number): void => {
      if (e.phase !== 'playing') return;
      const [a, b] = e.fighters;
      a.input.moveX = moveX[s];
      a.input.moveY = moveY[s];
      b.input.moveX = moveY[s];
      b.input.moveY = moveX[s];
      if (dashA[s]) a.dashQueued = true;
      if (dashB[s]) b.dashQueued = true;
    };
    const e1 = makeEngine(99);
    const e2 = makeEngine(99);
    for (let s = 0; s < steps; s++) {
      feed(e1, s);
      feed(e2, s);
      e1.update(TICK);
      e2.update(TICK);
    }
    for (let i = 0; i < e1.fighters.length; i++) {
      expect(e2.fighters[i].pos).toEqual(e1.fighters[i].pos);
      expect(e2.fighters[i].vel).toEqual(e1.fighters[i].vel);
      expect(e2.fighters[i].dashTimer).toBe(e1.fighters[i].dashTimer);
      expect(e2.fighters[i].dashCooldown).toBe(e1.fighters[i].dashCooldown);
    }
    expect(e2.phys.obstacles).toEqual(e1.phys.obstacles);
    expect(e2.phys.arenaRadius).toBe(e1.phys.arenaRadius);
    expect(e2.roundTime).toBeCloseTo(e1.roundTime, 10);
  });
});

describe('RoundEngine.forceOut (seat released mid-match)', () => {
  it('eliminates via the normal fall path: fall event, no KO credit, round ends', () => {
    const e = makeEngine(7);
    run(e, 4); // countdown(3s) + 1s of playing
    expect(e.phase).toBe('playing');
    e.drainEvents();

    e.forceOut(2);
    const events = e.drainEvents();
    const fall = events.find((x) => x.t === 'fall');
    expect(fall).toEqual({ t: 'fall', id: 2, byId: null });

    runUntil(e, 5, () => e.isOver);
    expect(e.isOver).toBe(true);
    expect(e.winnerId).toBe(1); // the remaining fighter wins
    expect(e.fighters[0].kos).toBe(0); // leaving is not a kill
    expect(e.fighters[0].state).toBe('active');
  });

  it('is a no-op outside playing and for unknown/already-out ids', () => {
    const e = makeEngine(7);
    e.forceOut(2); // countdown
    expect(e.drainEvents().filter((x) => x.t === 'fall')).toHaveLength(0);
    expect(e.fighters[1].state).toBe('active');

    run(e, 4); // playing
    e.forceOut(99);
    e.forceOut(2);
    e.forceOut(2); // already falling
    const falls = e.drainEvents().filter((x) => x.t === 'fall');
    expect(falls).toHaveLength(1);
  });
});
