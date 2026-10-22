/**
 * Wire protocol for Last One Laughing multiplayer (v1, JSON over WebSocket).
 *
 * Design rules:
 * - All authoritative state flows in `snap` messages (20 Hz); transient
 *   gameplay events (hits, falls, phase changes, modifier stages) ride along
 *   attached to the tick that produced them, so ordering is unambiguous.
 * - Inputs are tiny and rate-agnostic: the server keeps only the latest one
 *   per player per tick (mirrors the local `playerInput` bridge semantics:
 *   move vector + a dash REQUEST bit that is consumed exactly once).
 * - Quantization helpers live here so a later binary upgrade is drop-in;
 *   v1 ships human-readable JSON.
 */

import type { FighterState } from '../types';
import type { ModKind } from '../modifiers/ModifierDirector';

/** A fighter as announced in lobby/start messages (view data only). */
export interface NetPlayerInfo {
  id: number;
  name: string;
  css: string;
  radius: number;
  /** False while the player is disconnected (seat held for rejoin). */
  present: boolean;
}

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
 * `hit` is only emitted when the client would show feedback
 * (deltaV >= COMBAT.hitFxMinDeltaV or big), so grinding stays quiet.
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
  | { t: 'end'; winnerId: number | null };

/** One fighter's state in a snapshot. Positions are world-space (1080 box). */
export interface SnapPlayer {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: FighterState;
  dashT: number;
  dashCd: number;
}

/** Authoritative match state at a tick; clients interpolate ~100 ms behind. */
export interface Snapshot {
  tick: number;
  /** Seconds since GO (HUD timer). */
  roundTime: number;
  /** Current arena radius (sudden death + shrink modifier already applied). */
  radius: number;
  slippery: boolean;
  mod: { kind: ModKind; stage: 'warn' | 'active' } | null;
  players: SnapPlayer[];
  events: MatchEvent[];
}

// ---------------------------------------------------------------- client → server

export type ClientMsg =
  /** Create a private room; server answers `joined` with the code to share. */
  | { t: 'host'; name?: string }
  /** Join an existing room by code; server answers `joined` or `error`. */
  | { t: 'join'; room: string; name?: string }
  /** Rebind to a room after a drop (token issued in `joined`). */
  | { t: 'rejoin'; room: string; token: string }
  /** Sampled ~30 Hz while playing; mx/my clamped to [-1,1], dash is a request bit. */
  | { t: 'input'; seq: number; mx: number; my: number; dash: boolean }
  /** Host-only: start a match from the lobby (needs MIN_PLAYERS present). */
  | { t: 'start' }
  | { t: 'leave' }
  | { t: 'ping' }
  /** Test/dev only — the server rejects this unless LOL_TEST=1. */
  | { t: 'debug'; cmd: 'place'; id: number; x: number; y: number; vx?: number; vy?: number };

// ---------------------------------------------------------------- server → client

export type ServerMsg =
  | {
      t: 'joined';
      you: number;
      room: string;
      token: string;
      players: NetPlayerInfo[];
      hostId: number;
    }
  | { t: 'lobby'; players: NetPlayerInfo[]; hostId: number }
  | { t: 'start'; seed: number; roster: NetPlayerInfo[] }
  | { t: 'snap'; s: Snapshot }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };
