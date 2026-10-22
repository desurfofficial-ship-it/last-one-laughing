/**
 * Shared type vocabulary. The physics and modifier modules depend only on
 * these structural types, so they stay engine-agnostic and could be reused
 * by an authoritative server in a future stage.
 */

export interface InputState {
  moveX: number;
  moveY: number;
}

export type FighterState = 'active' | 'falling' | 'out';

/** Minimal body contract consumed by ArenaPhysics. */
export interface Body {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  radius: number;
  invMass: number;
  state: FighterState;
  dashTimer: number;
  dashCooldown: number;
  input: InputState;
}

export type Phase = 'idle' | 'countdown' | 'playing' | 'over';

/** Kinematic moving obstacle (arena modifier "bumper balls").
 *  Engine-agnostic: infinite mass, bounces inside the arena circle,
 *  shoves fighters but is never moved by them. */
export interface Obstacle {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  radius: number;
}

export interface HitEvent<F extends Body> {
  /** Approximate contact point. */
  x: number;
  y: number;
  /** Largest delta-v inflicted on either participant (px/s). */
  deltaV: number;
  /** True when the impact is heavy enough for full feedback (flash/hitstop/shake). */
  big: boolean;
  victim: F;
  attacker: F | null;
  /** Unit direction the victim is shoved (contact normal, victim-relative). */
  dirX: number;
  dirY: number;
}

export interface RoundResultMsg {
  playerWon: boolean;
  winnerName: string;
  winnerCss: string;
  roundTime: number;
  playerKos: number;
  playerOut: boolean;
  outBy: string | null;
}

export type UiCommand = 'start' | 'pause' | 'resume' | 'restart' | 'menu';
