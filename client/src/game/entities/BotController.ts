/**
 * Local bot AI. Produces the same InputState a networked player would, so
 * swapping bots for remote fighters later touches nothing else.
 *
 * Behavior: hunt the nearest (slightly randomized) opponent, lead the target,
 * blend a strong inward pull when close to the edge, add steering noise so
 * paths look organic, and dash opportunistically near the rim.
 */

import type { Fighter } from './Fighter';
import type { Obstacle, Phase } from '../types';

export interface BotCtx {
  phase: Phase;
  center: { x: number; y: number };
  radius: number;
  slippery: boolean;
  /** Active bumper balls (empty most of the round). */
  obstacles: readonly Obstacle[];
}

const THINK_MIN = 0.1;
const THINK_MAX = 0.22;

export class BotController {
  private think = 0;
  private dir = { x: 0, y: 0 };
  private readonly wanderSeed = Math.random() * 1000;
  private wanderT = 0;
  private readonly aggression: number;
  private readonly dashSkill: number;

  constructor(
    private me: Fighter,
    private fighters: Fighter[],
  ) {
    this.aggression = 0.65 + Math.random() * 0.35;
    this.dashSkill = 0.35 + Math.random() * 0.55;
  }

  update(dt: number, ctx: BotCtx): void {
    const me = this.me;
    if (me.state !== 'active' || ctx.phase === 'over') {
      me.input.moveX = 0;
      me.input.moveY = 0;
      return;
    }

    if (ctx.phase === 'idle' || ctx.phase === 'countdown') {
      // Idle laps around the arena for a lively menu backdrop.
      this.wanderT += dt;
      const a = this.wanderSeed + this.wanderT * 0.45;
      this.dir.x = Math.cos(a) * 0.45;
      this.dir.y = Math.sin(a * 1.3) * 0.45;
      me.input.moveX = this.dir.x;
      me.input.moveY = this.dir.y;
      return;
    }

    this.think -= dt;
    if (this.think <= 0) {
      this.think = THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
      this.decide(ctx);
    }
    me.input.moveX = this.dir.x;
    me.input.moveY = this.dir.y;
  }

  private decide(ctx: BotCtx): void {
    const me = this.me;

    // Pick a target: nearest opponent, damped by a random factor so bots
    // naturally split their attention.
    let target: Fighter | null = null;
    let best = Infinity;
    for (const f of this.fighters) {
      if (f === me || f.state !== 'active') continue;
      const d =
        Math.hypot(f.pos.x - me.pos.x, f.pos.y - me.pos.y) * (0.8 + Math.random() * 0.45);
      if (d < best) {
        best = d;
        target = f;
      }
    }

    let dx = 0;
    let dy = 0;
    if (target) {
      // Lead the target slightly.
      dx = target.pos.x + target.vel.x * 0.22 - me.pos.x;
      dy = target.pos.y + target.vel.y * 0.22 - me.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      dx *= this.aggression;
      dy *= this.aggression;
    }

    // Edge safety: pull inward with rising weight near the rim.
    const cx = ctx.center.x - me.pos.x;
    const cy = ctx.center.y - me.pos.y;
    const dc = Math.hypot(cx, cy) || 0.0001;
    const safe = Math.max(40, ctx.radius - me.radius - 40);
    const danger = clamp((dc - safe * 0.7) / (safe * 0.32), 0, 1);
    if (danger > 0) {
      const nx = cx / dc;
      const ny = cy / dc;
      const w = danger * 1.7;
      dx = dx * (1 - Math.min(0.95, danger)) + nx * w;
      dy = dy * (1 - Math.min(0.95, danger)) + ny * w;
    }

    // Dodge bumper balls: repulsion grows as a ball closes in.
    for (const o of ctx.obstacles) {
      const ox = me.pos.x - o.pos.x;
      const oy = me.pos.y - o.pos.y;
      const od = Math.hypot(ox, oy) || 0.0001;
      const range = o.radius + me.radius + 130;
      if (od < range) {
        const w = 1.2 * (1 - od / range);
        dx += (ox / od) * w;
        dy += (oy / od) * w;
      }
    }

    // Steering noise so bots feel less mechanical.
    const jitter = (Math.random() - 0.5) * 0.55;
    const cos = Math.cos(jitter);
    const sin = Math.sin(jitter);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const rlen = Math.hypot(rx, ry);
    if (rlen > 0.001) {
      this.dir.x = rx / rlen;
      this.dir.y = ry / rlen;
    } else {
      this.dir.x = cx / dc;
      this.dir.y = cy / dc;
    }

    // Dash decisions.
    if (me.dashCooldown <= 0 && target) {
      const tdx = target.pos.x - me.pos.x;
      const tdy = target.pos.y - me.pos.y;
      const distT = Math.hypot(tdx, tdy) || 1;
      const targetEdgeDist = Math.hypot(
        target.pos.x - ctx.center.x,
        target.pos.y - ctx.center.y,
      );
      const towardEdge = targetEdgeDist > ctx.radius * 0.55;
      const aligned = (me.vel.x * tdx + me.vel.y * tdy) / ((Math.hypot(me.vel.x, me.vel.y) || 1) * distT);

      if (distT < 240 && towardEdge && aligned > 0.5 && Math.random() < 0.14 * this.dashSkill) {
        me.dashQueued = true;
      } else if (dc > ctx.radius * 0.88 && Math.random() < 0.4 * this.dashSkill) {
        // Emergency: dash back toward the center (dash follows current input dir).
        me.dashQueued = true;
      }
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
