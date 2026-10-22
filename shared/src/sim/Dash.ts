/**
 * Dash execution + facing update, extracted from the client's `Fighter`
 * (stage 2) so the authoritative server executes dashes with IDENTICAL math.
 *
 * Contract (fixed in commit 9262a2f, kept verbatim): consuming the queue
 * always happens, the return value reports whether a dash actually fired,
 * and the direction falls back to `facing` when the input stick is near-zero.
 *
 * `facing` must be advanced by the simulation (not the render loop) so server
 * and client agree on fallback dash direction; `updateFacing` is the exact
 * formula previously in Fighter.syncVisual.
 */

import { DASH } from '../constants';
import type { FighterState, InputState } from '../types';

/** Minimal structural contract for anything a dash can be executed on. */
export interface DashBody {
  state: FighterState;
  dashCooldown: number;
  dashTimer: number;
  dashQueued: boolean;
  input: InputState;
  facing: { x: number; y: number };
  vel: { x: number; y: number };
}

/**
 * Execute a dash if one was queued (consumes the request).
 * Returns true when the dash actually fired.
 *
 * Contract (restores the pre-9262a2f gating that the remote commit
 * accidentally dropped — see docs/stage-2-plan.md):
 *   1. the queue is ALWAYS consumed;
 *   2. no queued request -> no dash, return false;
 *   3. queued but unavailable (out/falling, cooldown) -> request wasted,
 *      return false;
 *   4. otherwise apply the impulse and return true.
 */
export function tryDash(f: DashBody): boolean {
  const queued = f.dashQueued;
  f.dashQueued = false;
  if (!queued) return false;
  if (f.state !== 'active' || f.dashCooldown > 0) return false;

  let dx = f.input.moveX;
  let dy = f.input.moveY;
  const mag = Math.hypot(dx, dy);
  if (mag < 0.15) {
    dx = f.facing.x;
    dy = f.facing.y;
  } else {
    dx /= mag;
    dy /= mag;
  }
  f.vel.x += dx * DASH.speed;
  f.vel.y += dy * DASH.speed;
  f.dashTimer = DASH.duration;
  f.dashCooldown = DASH.cooldown;
  return true;
}

/** Ease `facing` toward the current velocity direction (dt in seconds). */
export function updateFacing(
  f: { vel: { x: number; y: number }; facing: { x: number; y: number } },
  dt: number,
): void {
  const speed = Math.hypot(f.vel.x, f.vel.y);
  if (speed > 20) {
    const k = Math.min(1, dt * 8);
    f.facing.x += (f.vel.x / speed - f.facing.x) * k;
    f.facing.y += (f.vel.y / speed - f.facing.y) * k;
    const fl = Math.hypot(f.facing.x, f.facing.y) || 1;
    f.facing.x /= fl;
    f.facing.y /= fl;
  }
}
