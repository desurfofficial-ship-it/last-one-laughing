/**
 * Arena modifier: the floor periodically turns slippery.
 *
 * Cycle while a round is playing:
 *   normal (10s) -> warning (2s, banner + ring pulse) -> slippery (4s)
 *   -> normal (10s) -> ...
 *
 * During the slippery phase the physics layer swaps to low-friction
 * acceleration/damping, so fighters drift and melee becomes dangerous.
 * This module is timing logic only; visual/audio hooks are injected.
 */

import { SLIPPERY } from '../constants';

export type SlipperyState = 'normal' | 'warning' | 'slippery';

export interface SlipperyHooks {
  onWarning(): void;
  onSlippery(): void;
  onNormal(): void;
}

export class SlipperyFloor {
  private stateValue: SlipperyState = 'normal';
  private t = SLIPPERY.normal;

  constructor(private hooks: SlipperyHooks) {}

  get state(): SlipperyState {
    return this.stateValue;
  }

  isSlippery(): boolean {
    return this.stateValue === 'slippery';
  }

  /** Reset to the start of a normal phase without firing hooks. */
  reset(): void {
    this.stateValue = 'normal';
    this.t = SLIPPERY.normal;
  }

  /** Stop the cycle and return to normal without firing hooks (round end). */
  silence(): void {
    this.reset();
  }

  update(dt: number): void {
    this.t -= dt;
    if (this.t > 0) return;
    switch (this.stateValue) {
      case 'normal':
        this.stateValue = 'warning';
        this.t = SLIPPERY.warning;
        this.hooks.onWarning();
        break;
      case 'warning':
        this.stateValue = 'slippery';
        this.t = SLIPPERY.slippery;
        this.hooks.onSlippery();
        break;
      case 'slippery':
        this.stateValue = 'normal';
        this.t = SLIPPERY.normal;
        this.hooks.onNormal();
        break;
    }
  }
}
