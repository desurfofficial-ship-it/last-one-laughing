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
import type { Body, HitEvent, InputState } from '../types';

export type BoundaryMode = 'open' | 'clamp';

const STEP_HZ = 120;
const STEP_H = 1 / STEP_HZ;
const MAX_STEPS = 6;

export class ArenaPhysics<F extends Body> {
  /** Current arena radius (shrinks during sudden death). */
  arenaRadius = ARENA_RADIUS;
  onHit?: (e: HitEvent<F>) => void;
  onFallStart?: (f: F) => void;

  private acc = 0;
  private freeze = 0;

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

    const deltaV = Math.max(impulse * a.invMass, impulse * b.invMass);
    // "Big" must reflect a genuinely heavy impact. Previously ANY dash contact
    // (even a grazing tap at deltaV ~ 60) counted as big and fired hitstop +
    // shake + flash, while plain bumps needed deltaV > bigHitDeltaV. A dash
    // now needs a real connection (deltaV > dashBigDeltaV) to count as big.
    const big =
      deltaV > COMBAT.bigHitDeltaV ||
      (attacker !== null && deltaV > COMBAT.dashBigDeltaV);

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
}

/** Zeroed input helper shared by controllers. */
export function emptyInput(): InputState {
  return { moveX: 0, moveY: 0 };
}
