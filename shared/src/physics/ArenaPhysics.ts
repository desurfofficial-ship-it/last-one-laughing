/**
 * Fixed-timestep, engine-agnostic circular physics for the knockout arena.
 *
 * - Exponential damping gives a natural terminal speed for movement.
 * - Circle-circle impulses support a dash "slam" bonus for punchy knockback.
 * - The arena edge has no walls: in 'open' mode a fighter whose center leaves
 *   the circle starts falling; in 'clamp' mode (menus / countdown / victory)
 *   fighters bounce gently back inside.
 *
 * This module imports nothing from Phaser, so a future authoritative server
 * (stage 2 multiplayer) can reuse it verbatim.
 */

import { ARENA_RADIUS, COMBAT, DASH, FALL_MARGIN, MOVEMENT } from '../constants';
import type { Body, HitEvent, InputState, Obstacle } from '../types';

export type BoundaryMode = 'open' | 'clamp';

const STEP_HZ = 120;
const STEP_H = 1 / STEP_HZ;
const MAX_STEPS = 6;

export class ArenaPhysics<F extends Body> {
  /** Current arena radius (shrinks during sudden death / the shrink modifier). */
  arenaRadius = ARENA_RADIUS;
  onHit?: (e: HitEvent<F>) => void;
  onFallStart?: (f: F) => void;
  /** Kinematic bumper balls (modifier). Empty outside their activation window. */
  obstacles: Obstacle[] = [];

  private acc = 0;
  private freeze = 0;
  /** Internal clock (s); drives per-fighter bumper-strike cooldowns. */
  private simTime = 0;
  /** Fighter -> simTime when a bumper may strike it again. Without this a
   *  moving bumper chains overlap impulses every substep and "rides" a
   *  fighter from spawn to the rim (observed: 5 hits / 450 px in 3.7 s). */
  private bumperCd = new Map<F, number>();

  constructor(
    public center: { x: number; y: number },
    public fighters: F[],
  ) {}

  /** Briefly stop simulation for hitstop-style impact weight. */
  freezeFor(ms: number): void {
    this.freeze = Math.max(this.freeze, ms / 1000);
  }

  /** Drop any pending hitstop (used when a round restarts mid-freeze). */
  clearFreeze(): void {
    this.freeze = 0;
    this.acc = 0;
  }

  step(dt: number, slippery: boolean, mode: BoundaryMode): void {
    if (this.freeze > 0) {
      this.freeze -= dt;
      this.acc = 0; // no catch-up burst after the freeze
      return;
    }
    this.acc += Math.min(dt, 0.05);
    let steps = 0;
    while (this.acc >= STEP_H && steps < MAX_STEPS) {
      this.substep(STEP_H, slippery, mode);
      this.acc -= STEP_H;
      steps++;
    }
    if (steps >= MAX_STEPS) this.acc = 0;
  }

  private substep(h: number, slippery: boolean, mode: BoundaryMode): void {
    this.simTime += h;
    const accel = slippery ? MOVEMENT.accelSlippery : MOVEMENT.accelNormal;
    const damping = slippery ? MOVEMENT.dampingSlippery : MOVEMENT.dampingNormal;

    for (const f of this.fighters) {
      if (f.state === 'out') continue;
      if (f.state === 'falling') {
        // Keep flying off outward; no forces apply.
        f.pos.x += f.vel.x * h;
        f.pos.y += f.vel.y * h;
        continue;
      }
      f.vel.x += f.input.moveX * accel * h;
      f.vel.y += f.input.moveY * accel * h;
      const damp = Math.exp(-damping * h);
      f.vel.x *= damp;
      f.vel.y *= damp;
      if (f.dashTimer > 0) f.dashTimer = Math.max(0, f.dashTimer - h);
      if (f.dashCooldown > 0) f.dashCooldown = Math.max(0, f.dashCooldown - h);
      f.pos.x += f.vel.x * h;
      f.pos.y += f.vel.y * h;
    }

    const fs = this.fighters;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const a = fs[i];
        const b = fs[j];
        if (a.state !== 'active' || b.state !== 'active') continue;
        this.collide(a, b);
      }
    }

    if (this.obstacles.length > 0) this.stepObstacles(h, fs);
    for (const f of fs) {
      if (f.state !== 'active') continue;
      const dx = f.pos.x - this.center.x;
      const dy = f.pos.y - this.center.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      if (mode === 'open') {
        if (d > this.arenaRadius + FALL_MARGIN) {
          f.state = 'falling';
          f.input.moveX = 0;
          f.input.moveY = 0;
          this.onFallStart?.(f);
        }
      } else {
        const maxD = Math.max(1, this.arenaRadius - f.radius);
        if (d > maxD) {
          const nx = dx / d;
          const ny = dy / d;
          f.pos.x = this.center.x + nx * maxD;
          f.pos.y = this.center.y + ny * maxD;
          const vn = f.vel.x * nx + f.vel.y * ny;
          if (vn > 0) {
            f.vel.x -= nx * vn * 1.6;
            f.vel.y -= ny * vn * 1.6;
          }
        }
      }
    }
  }

  private collide(a: F, b: F): void {
    let nx = b.pos.x - a.pos.x;
    let ny = b.pos.y - a.pos.y;
    let d = Math.hypot(nx, ny);
    const minD = a.radius + b.radius;
    if (d >= minD) return;
    if (d === 0) {
      nx = 1;
      ny = 0;
      d = 0.0001;
    } else {
      nx /= d;
      ny /= d;
    }

    // Positional correction weighted by inverse mass.
    const overlap = minD - d;
    const invSum = a.invMass + b.invMass;
    a.pos.x -= nx * overlap * (a.invMass / invSum);
    a.pos.y -= ny * overlap * (a.invMass / invSum);
    b.pos.x += nx * overlap * (b.invMass / invSum);
    b.pos.y += ny * overlap * (b.invMass / invSum);

    // Impulse along the contact normal.
    const rvx = b.vel.x - a.vel.x;
    const rvy = b.vel.y - a.vel.y;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return; // already separating

    let boost = 1;
    let attacker: F | null = null;
    let victim: F = b;
    if (a.dashTimer > 0 && b.dashTimer <= 0) {
      boost = DASH.knockbackMultiplier;
      attacker = a;
      victim = b;
    } else if (b.dashTimer > 0 && a.dashTimer <= 0) {
      boost = DASH.knockbackMultiplier;
      attacker = b;
      victim = a;
    } else if (a.dashTimer > 0 && b.dashTimer > 0) {
      boost = 1.15;
    }

    const impulse = (-(1 + COMBAT.restitution) * vn / invSum) * boost;
    a.vel.x -= nx * impulse * a.invMass;
    a.vel.y -= ny * impulse * a.invMass;
    b.vel.x += nx * impulse * b.invMass;
    b.vel.y += ny * impulse * b.invMass;

    if (attacker) {
      const dirX = victim === b ? nx : -nx;
      const dirY = victim === b ? ny : -ny;
      victim.vel.x += dirX * DASH.flatKnockback;
      victim.vel.y += dirY * DASH.flatKnockback;
    }

    let deltaV = Math.max(impulse * a.invMass, impulse * b.invMass);
    // "Big" must reflect a genuinely heavy impact. Previously ANY dash contact
    // (even a grazing tap at deltaV ~ 60) counted as big and fired hitstop +
    // shake + flash, while plain bumps needed deltaV > bigHitDeltaV. A dash
    // now needs a real connection (deltaV > dashBigDeltaV) to count as big.
    const big =
      deltaV > COMBAT.bigHitDeltaV ||
      (attacker !== null && deltaV > COMBAT.dashBigDeltaV);

    // Predictability floor: a CONFIRMED dash slam always shoves the victim
    // outward at a guaranteed minimum speed, so the same connection always
    // produces the same readable result instead of occasionally "pooting".
    if (attacker && deltaV > COMBAT.dashBigDeltaV) {
      const sx = victim === b ? nx : -nx;
      const sy = victim === b ? ny : -ny;
      const vN = victim.vel.x * sx + victim.vel.y * sy;
      if (vN < COMBAT.slamMinKnock) {
        const add = COMBAT.slamMinKnock - vN;
        victim.vel.x += sx * add;
        victim.vel.y += sy * add;
        deltaV = Math.max(deltaV, COMBAT.slamMinKnock);
      }
    }

    // Direction the victim is shoved: toward b when b is the victim (or no
    // attacker), toward a otherwise. Purely informational (view feedback).
    const victimIsB = victim === b;
      this.onHit?.({
      x: (a.pos.x + b.pos.x) / 2,
      y: (a.pos.y + b.pos.y) / 2,
      deltaV,
      big,
      victim,
      attacker,
      dirX: victimIsB ? nx : -nx,
      dirY: victimIsB ? ny : -ny,
    });
  }

  /** Kinematic bumper balls: move, bounce off the arena circle and each
   *  other, and shove fighters. Purely local - no Phaser types here. */
  private stepObstacles(h: number, fs: F[]): void {
    const R = this.arenaRadius;
    const obs = this.obstacles;

    for (const o of obs) {
      o.pos.x += o.vel.x * h;
      o.pos.y += o.vel.y * h;
      // Always confined, whatever the boundary mode: bumpers never fall.
      const dx = o.pos.x - this.center.x;
      const dy = o.pos.y - this.center.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      const maxD = Math.max(1, R - o.radius);
      if (d > maxD) {
        const nx = dx / d;
        const ny = dy / d;
        o.pos.x = this.center.x + nx * maxD;
        o.pos.y = this.center.y + ny * maxD;
        const vn = o.vel.x * nx + o.vel.y * ny;
        if (vn > 0) {
          o.vel.x -= nx * vn * 2; // perfectly elastic reflection
          o.vel.y -= ny * vn * 2;
        }
      }
    }

    // Obstacle vs obstacle: equal-mass elastic swap of normal components.
    for (let i = 0; i < obs.length; i++) {
      for (let j = i + 1; j < obs.length; j++) {
        const a = obs[i];
        const b = obs[j];
        const nx = b.pos.x - a.pos.x;
        const ny = b.pos.y - a.pos.y;
        const d = Math.hypot(nx, ny) || 0.0001;
        const minD = a.radius + b.radius;
        if (d >= minD) continue;
        const ux = nx / d;
        const uy = ny / d;
        const overlap = (minD - d) / 2;
        a.pos.x -= ux * overlap;
        a.pos.y -= uy * overlap;
        b.pos.x += ux * overlap;
        b.pos.y += uy * overlap;
        const va = a.vel.x * ux + a.vel.y * uy;
        const vb = b.vel.x * ux + b.vel.y * uy;
        if (va - vb > 0) continue; // separating
        a.vel.x += ux * (vb - va);
        a.vel.y += uy * (vb - va);
        b.vel.x -= ux * (vb - va);
        b.vel.y -= uy * (vb - va);
      }
    }

    // Obstacle vs fighter: one clean strike, then a short grace. The grace
    // skips impulse AND push-out so the ball rolls through instead of
    // pinning the fighter to its leading rim and carrying them off.
    for (const o of obs) {
      for (const f of fs) {
        if (f.state !== 'active') continue;
        if (this.simTime < (this.bumperCd.get(f) ?? 0)) continue;
        const nx = f.pos.x - o.pos.x;
        const ny = f.pos.y - o.pos.y;
        const d = Math.hypot(nx, ny) || 0.0001;
        const minD = o.radius + f.radius;
        if (d >= minD) continue;
        const ux = nx / d;
        const uy = ny / d;
        // Push the fighter fully out of the bumper.
        f.pos.x = o.pos.x + ux * minD;
        f.pos.y = o.pos.y + uy * minD;
        const rvn = (f.vel.x - o.vel.x) * ux + (f.vel.y - o.vel.y) * uy;
        if (rvn >= 0) continue; // already separating
        // Soften vs. fighter-fighter hits: bumpers should displace, not
        // launch. Lower restitution, no flat bonus, hard cap on the shove.
        const j = Math.min(-(1 + 0.55) * rvn, COMBAT.bumpShoveCap);
        f.vel.x += ux * j;
        f.vel.y += uy * j;
        f.dashTimer = 0; // a bumper strike interrupts an ongoing dash
        // Ricochet: reflect the ball off the fighter (elastic, like the rim)
        // and back it out of contact. Without this the ball simply chases the
        // victim it just shoved - its 300 px/s outruns the damped impulse and
        // it "rides" the fighter from spawn to the rim (the round-decider bug).
        const bvn = o.vel.x * ux + o.vel.y * uy;
        if (bvn > 0) {
          // approaching along u (u points ball -> fighter): reflect
          o.vel.x -= 2 * bvn * ux;
          o.vel.y -= 2 * bvn * uy;
          o.pos.x -= ux * (minD - d);
          o.pos.y -= uy * (minD - d);
        }
        this.bumperCd.set(f, this.simTime + COMBAT.bumpRestrikeS);
        this.onHit?.({
          x: o.pos.x + ux * o.radius,
          y: o.pos.y + uy * o.radius,
          deltaV: j,
          big: j > COMBAT.bumpBigDeltaV,
          victim: f,
          attacker: null,
          dirX: ux,
          dirY: uy,
        });
      }
    }
  }
}
/** Zeroed input helper shared by controllers. */
export function emptyInput(): InputState {
  return { moveX: 0, moveY: 0 };
}
