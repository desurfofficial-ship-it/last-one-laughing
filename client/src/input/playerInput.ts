/**
 * Bridge between the DOM input layer and the Phaser game layer.
 * The InputManager (DOM) writes here; GameScene reads during play.
 */

export interface MutablePlayerInput {
  moveX: number;
  moveY: number;
  dashQueued: boolean;
  /** Returns true once per queued dash request. */
  consumeDash(): boolean;
}

export const playerInput: MutablePlayerInput = {
  moveX: 0,
  moveY: 0,
  dashQueued: false,
  consumeDash(): boolean {
    const queued = this.dashQueued;
    this.dashQueued = false;
    return queued;
  },
};
