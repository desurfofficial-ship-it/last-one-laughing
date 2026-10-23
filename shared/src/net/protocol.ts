/**
 * Shared multiplayer vocabulary (transport-agnostic; the Colyseus port keeps
 * these shapes: MatchEvent objects ride as 'ev' room messages, the schema in
 * state/schema.ts carries the continuous state — see docs/stage-2-plan.md).
 *
 * Gameplay events are emitted by the shared RoundEngine on the tick they
 * happen, so ordering is unambiguous. `hit` is only emitted when the client
 * would show feedback (deltaV >= COMBAT.hitFxMinDeltaV or big), so grinding
 * stays quiet.
 */

import type { ModKind } from '../modifiers/ModifierDirector';

/** Server-side roster defaults for up to 8 players (colors/radii echo the solo defs). */
export const ROSTER_COLORS = [
  '#ffd23f', '#ff5d5d', '#3ddc97', '#4da3ff',
  '#c792ea', '#ff9f43', '#7fd8ff', '#f06292',
];
export const ROSTER_RADII = [40, 44, 38, 36, 42, 39, 37, 41];
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

/**
 * One gameplay event produced by the shared RoundEngine during a tick.
 */
export type MatchEvent =
  | { t: 'phase'; p: 'countdown' | 'playing' | 'over' }
  | { t: 'countdown'; n: number } // 3..1, then 0 = GO
  | { t: 'dash'; id: number }
  | {
      t: 'hit';
      x: number;
      y: number;
      deltaV: number;
      big: boolean;
      victimId: number;
      attackerId: number | null;
      dirX: number;
      dirY: number;
    }
  | { t: 'fall'; id: number; byId: number | null }
  | { t: 'mod'; kind: ModKind; stage: 'warn' | 'active' | 'end' }
  | { t: 'slippery'; stage: 'warn' | 'on' | 'off' }
  | { t: 'sudden' }
  | { t: 'end'; winnerId: number | null; reason?: 'forfeit' | 'normal' };

/** Server -> joining client, right after a seat is granted. */
export interface WelcomeMsg {
  /** The client's stable player id (1..8). */
  pid: number;
  /** The 6-char room code (share this / the ?room= link). */
  code: string;
}

/** Server -> client: an input/start request was rejected. */
export interface ErrorMsg {
  code: 'not_host' | 'need_players' | 'need_ready' | 'match_running' | 'forbidden' | 'bad_msg';
  message: string;
}
