/**
 * Fighter: a colored circle with eyes that glances toward its movement
 * direction. Holds both the simulation state (pos/vel/input, satisfying the
 * engine-agnostic Body contract) and its Phaser view (container of shapes).
 */

import Phaser from 'phaser';
import { COMBAT, FALL_ANIM_MS } from '../constants';
import type { FighterDef } from '../constants';
import { emptyInput } from '../physics/ArenaPhysics';
import { tryDash, updateFacing } from '../../../../shared/src/sim/Dash';
import type { Body, FighterState, InputState } from '../types';

export class Fighter implements Body {
  pos = { x: 0, y: 0 };
  vel = { x: 0, y: 0 };
  input: InputState = emptyInput();
  state: FighterState = 'active';
  dashTimer = 0;
  dashCooldown = 0;
  dashQueued = false;

  eliminated = false;
  kos = 0;
  lastHitBy: Fighter | null = null;
  facing = { x: 0, y: 1 };

  /** View-only directional impact offset (decays fast; never feeds physics). */
  private knockX = 0;
  private knockY = 0;

  readonly radius: number;
  readonly mass: number;
  readonly invMass: number;

  readonly container: Phaser.GameObjects.Container;
  private readonly bodyArc: Phaser.GameObjects.Arc;
  private readonly halo: Phaser.GameObjects.Arc | null = null;
  private readonly eyeL: Phaser.GameObjects.Arc;
  private readonly eyeR: Phaser.GameObjects.Arc;
  private readonly pupilL: Phaser.GameObjects.Arc;
  private readonly pupilR: Phaser.GameObjects.Arc;
  private readonly trail: Phaser.GameObjects.Particles.ParticleEmitter;
  private trailHot = false;

  constructor(
    private scene: Phaser.Scene,
    readonly def: FighterDef,
  ) {
    this.radius = def.radius;
    this.mass = (def.radius * def.radius) / 1600;
    this.invMass = 1 / this.mass;

    this.container = scene.add.container(0, 0).setDepth(10);

    if (def.isPlayer) {
      this.halo = scene.add.circle(0, 0, def.radius + 10).setStrokeStyle(3, 0xffffff, 0.35);
      this.container.add(this.halo);
      scene.tweens.add({
        targets: this.halo,
        alpha: { from: 0.55, to: 0.2 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    this.bodyArc = scene.add.circle(0, 0, def.radius, def.color);
    this.bodyArc.setStrokeStyle(3, 0xffffff, 0.35);

    this.eyeL = scene.add.circle(0, 0, 7, 0xffffff);
    this.eyeR = scene.add.circle(0, 0, 7, 0xffffff);
    this.pupilL = scene.add.circle(0, 0, 3.2, 0x11162b);
    this.pupilR = scene.add.circle(0, 0, 3.2, 0x11162b);

    const label = scene.add
      .text(0, def.radius + 12, def.name, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        fontStyle: 'bold',
        color: '#eef1ff',
        resolution: 2,
      })
      .setOrigin(0.5, 0)
      .setAlpha(0.55);

    this.container.add([this.bodyArc, this.eyeL, this.pupilL, this.eyeR, this.pupilR, label]);

    this.trail = scene.add
      .particles(0, 0, 'dot', {
        follow: this.container,
        speed: { min: 10, max: 50 },
        lifespan: 280,
        scale: { start: 0.55, end: 0 },
        alpha: { start: 0.7, end: 0 },
        tint: def.color,
        blendMode: 'ADD',
        frequency: 16,
        quantity: 1,
        emitting: false,
      })
      .setDepth(9);
  }

  get isPlayer(): boolean {
    return this.def.isPlayer;
  }

  /** Execute a dash if available (consumes any queued request). Returns true when it fires.
   *  Math lives in shared/sim/Dash.ts so the authoritative server runs the same code. */
  requestDash(): boolean {
    return tryDash(this);
  }

  syncVisual(dt: number): void {
    if (this.state === 'out') return;

    // Decay the knock offset exponentially (~140ms visible tail).
    if (this.knockX !== 0 || this.knockY !== 0) {
      const k = Math.exp(-dt * 16);
      this.knockX *= k;
      this.knockY *= k;
      if (Math.hypot(this.knockX, this.knockY) < 0.4) {
        this.knockX = 0;
        this.knockY = 0;
      }
    }
    this.container.setPosition(this.pos.x + this.knockX, this.pos.y + this.knockY);

    updateFacing(this, dt);
    const fx = this.facing.x;
    const fy = this.facing.y;
    const px = -fy;
    const py = fx;
    const fwd = this.radius * 0.34;
    const side = this.radius * 0.3;
    this.eyeL.setPosition(fx * fwd + px * side, fy * fwd + py * side);
    this.eyeR.setPosition(fx * fwd - px * side, fy * fwd - py * side);
    this.pupilL.setPosition(this.eyeL.x + fx * 2.6, this.eyeL.y + fy * 2.6);
    this.pupilR.setPosition(this.eyeR.x + fx * 2.6, this.eyeR.y + fy * 2.6);

    const hot = this.dashTimer > 0 && this.state === 'active';
    if (hot && !this.trailHot) this.trail.start();
    if (!hot && this.trailHot) this.trail.stop();
    this.trailHot = hot;
  }

  /** Directional knockback feedback: displace the view along the shove. */
  knock(dirX: number, dirY: number, severity: number): void {
    const amp = COMBAT.knockOffsetFrac * this.radius * Phaser.Math.Clamp(severity, 0, 1);
    this.knockX += dirX * amp;
    this.knockY += dirY * amp;
  }

  flashWhite(): void {
    this.bodyArc.setFillStyle(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (this.state !== 'out') this.bodyArc.setFillStyle(this.def.color);
    });
  }

  squash(): void {
    this.scene.tweens.add({
      targets: this.container,
      scale: { from: 1.18, to: 1 },
      duration: 170,
      ease: 'Quad.easeOut',
    });
  }

  startFallFx(onDone: () => void): void {
    this.trail.stop();
    this.trailHot = false;
    this.scene.tweens.add({
      targets: this.container,
      scale: 0.12,
      alpha: 0.1,
      duration: FALL_ANIM_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.container.setVisible(false);
        onDone();
      },
    });
  }

  victory(): void {
    this.scene.tweens.add({
      targets: this.container,
      scale: { from: 1, to: 1.15 },
      duration: 260,
      yoyo: true,
      repeat: 3,
      ease: 'Sine.easeInOut',
    });
  }

  reset(): void {
    this.scene.tweens.killTweensOf(this.container);
    this.state = 'active';
    this.vel.x = 0;
    this.vel.y = 0;
    this.input.moveX = 0;
    this.input.moveY = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashQueued = false;
    this.eliminated = false;
    this.kos = 0;
    this.lastHitBy = null;
    this.knockX = 0;
    this.knockY = 0;
    this.container.setVisible(true).setAlpha(1).setScale(1);
    this.bodyArc.setFillStyle(this.def.color);
    this.trail.stop();
    this.trailHot = false;
    this.syncVisual(0);
  }
}
