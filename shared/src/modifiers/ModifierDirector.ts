/**
 * Modifier director: schedules the two announced arena modifiers that are not
 * the slippery floor (which keeps its own independent cycle):
 *
 *   bumpers -> shrink -> bumpers -> shrink -> ...
 *
 * Cycle while a round is playing:
 *   rest (quiet) -> warn (banner + sound, MODS.warn s) -> active (window)
 *   [shrink then eases back out] -> rest -> ...
 *
 * The director is timing/state logic only. The scene injects hooks for
 * banner/audio/spawn effects and owns the arena radius application via
 * shrinkOffset(), so sudden death and the modifier shrink compose cleanly:
 *
 *   applied radius = baseRadius (sudden death) - shrinkOffset() (modifier)
 */

import { MODS } from '../constants';

export type ModKind = 'bumpers' | 'shrink';

export interface DirectorHooks {
  /** Warning started (banner + sfx live in the scene). */
  onWarn(kind: ModKind): void;
  /** Window activated: bumpers spawn here. */
  onActivate(kind: ModKind): void;
  /** Window finished: bumpers despawn here. */
  onEnd(kind: ModKind): void;
}

type DirectorState = 'rest' | 'warn' | 'active' | 'restore' | 'done';

export class ModifierDirector {
  private state: DirectorState = 'rest';
  private t = MODS.firstDelay;
  private next: ModKind = 'bumpers';
  /** Progress 0..1 through the active shrink window (for shrinkOffset). */
  private shrinkProgress = 0;
  /** Progress 0..1 through the restore ease-back. */
  private restoreProgress = 0;
  private active: ModKind | null = null;
  /** Set when cancelled mid-window: finish the current ease, then stop. */
  private noMore = false;

  constructor(private hooks: DirectorHooks) {}

  /** Extra radius removed by the shrink modifier right now (px, >= 0). */
  shrinkOffset(): number {
    const base = Math.min(MODS.shrinkAmount, this.maxShrinkAllowed());
    if (this.state === 'active' && this.active === 'shrink') {
      // Ease in/out so the shrink reads as a smooth pull, not a snap.
      const eased = this.shrinkProgress * this.shrinkProgress * (3 - 2 * this.shrinkProgress);
      return base * eased;
    }
    if (this.state === 'restore') {
      const eased = this.restoreProgress * this.restoreProgress * (3 - 2 * this.restoreProgress);
      return base * (1 - eased);
    }
    return 0;
  }

  get kind(): ModKind | null {
    return this.state === 'warn' || this.state === 'active' ? this.next : this.active;
  }

  get isWarning(): boolean {
    return this.state === 'warn';
  }

  get isActive(): boolean {
    return this.state === 'active';
  }

  /** Round over / sudden death: finish gracefully, schedule nothing more. */
  cancel(): void {
    this.noMore = true;
    switch (this.state) {
      case 'warn':
        this.state = 'rest';
        this.t = Infinity;
        break;
      case 'active': {
        const kind = this.active;
        if (kind === 'shrink') {
          this.state = 'restore'; // keep easing back out, then stop
        } else if (kind === 'bumpers') {
          this.hooks.onEnd(kind);
          this.active = null;
          this.state = 'done';
        } else {
          this.state = 'done';
        }
        break;
      }
      default:
        this.state = 'done';
    }
  }

  /** Fresh round: back to the start of the quiet period. */
  reset(): void {
    this.state = 'rest';
    this.t = MODS.firstDelay;
    this.next = 'bumpers';
    this.active = null;
    this.shrinkProgress = 0;
    this.restoreProgress = 0;
    this.noMore = false;
  }

  update(dt: number): void {
    switch (this.state) {
      case 'rest':
        if (Number.isFinite(this.t)) {
          this.t -= dt;
          if (this.t <= 0) {
            this.state = 'warn';
            this.t = MODS.warn;
            this.hooks.onWarn(this.next);
          }
        }
        break;
      case 'warn':
        this.t -= dt;
        if (this.t <= 0) {
          this.active = this.next;
          this.state = 'active';
          this.t = this.active === 'shrink' ? MODS.shrinkDuration : MODS.bumperDuration;
          this.shrinkProgress = 0;
          this.hooks.onActivate(this.active);
        }
        break;
      case 'active':
        this.t -= dt;
        if (this.active === 'shrink') {
          this.shrinkProgress = Math.min(1, 1 - this.t / MODS.shrinkDuration);
        }
        if (this.t <= 0) {
          if (this.active === 'shrink') {
            this.state = 'restore';
            this.t = MODS.shrinkRestore;
          } else if (this.active === 'bumpers') {
            this.hooks.onEnd(this.active);
            this.active = null;
            this.state = 'rest';
            this.t = MODS.restBetween;
            this.next = 'shrink';
          } else {
            this.active = null;
            this.state = 'rest';
            this.t = MODS.restBetween;
          }
        }
        break;
      case 'restore':
        this.t -= dt;
        this.restoreProgress = Math.min(1, 1 - this.t / MODS.shrinkRestore);
        if (this.t <= 0) {
          this.restoreProgress = 0;
          this.active = null;
          if (this.noMore) {
            this.state = 'done';
          } else {
            this.state = 'rest';
            this.t = MODS.restBetween;
            this.next = this.next === 'shrink' ? 'bumpers' : 'shrink';
          }
        }
        break;
      case 'done':
        break;
    }
  }

  /** Never shrink past what sudden death still needs as headroom. */
  private maxShrinkAllowed(): number {
    // The caller applies offset to baseRadius and clamps at a floor; this
    // simply keeps the modifier from ever exceeding a sane fraction.
    return MODS.shrinkAmount;
  }
}
