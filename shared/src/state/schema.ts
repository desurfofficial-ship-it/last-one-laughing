/**
 * Colyseus state schema (schema 5, decorator-free functional API — see
 * docs/colyseus-api-verification.md). Imported by BOTH the server (mutates)
 * and the client (decodes), so the two always agree on the wire format.
 *
 * Design: only what clients need to render smooth gameplay. Transient
 * one-shot effects (hit sparks, countdown pops, KO messaging, modifier
 * banners) ride as 'ev' messages carrying shared MatchEvent objects; this
 * schema carries continuous values only.
 *
 * Conventions:
 * - Players are keyed by their stable numeric pid ("1".."8", server-issued,
 *   survives reconnection) — never by Colyseus sessionId.
 * - winnerPid: 0 while undecided, -1 on a draw, >0 the winner's pid.
 * - Positions are the 1080x1080 logical world (same as solo).
 */

import { schema, t } from '@colyseus/schema';

export const PlayerState = schema(
  {
    /** Stable server-issued id (1..8) used by events and the engine. */
    pid: t.number(),
    /**
     * The owning Colyseus sessionId. Clients locate THEIR row by matching
     * room.sessionId (messages sent during onJoin can race the client's
     * handler registration, so a 'welcome' message alone is not reliable).
     * The sessionId survives reconnection (reserved seat keeps its id).
     */
    sid: t.string(),
    name: t.string(),
    /** Roster color as '#rrggbb'. */
    css: t.string(),
    host: t.boolean(),
    /** Lobby ready flag (reset every time the room returns to the lobby). */
    ready: t.boolean(),
    /** False while the seat is held for a dropped player. */
    present: t.boolean(),
    // ---- match view (written every tick, patched at 20 Hz) ----
    x: t.number(),
    y: t.number(),
    vx: t.number(),
    vy: t.number(),
    /** Facing angle in radians (clients derive the direction vector). */
    facing: t.number(),
    /** 'active' | 'falling' | 'out' (FighterState). */
    state: t.string(),
    dashT: t.number(),
    dashCd: t.number(),
    kos: t.number(),
  },
  'PlayerState',
);

export const ObstacleState = schema(
  {
    x: t.number(),
    y: t.number(),
    vx: t.number(),
    vy: t.number(),
    radius: t.number(),
  },
  'ObstacleState',
);

export const GameState = schema(
  {
    /** The 6-char room code (== the Colyseus roomId). */
    code: t.string(),
    /** Seed used for bumper spawns (informational; server is authoritative). */
    seed: t.number(),
    /** 'lobby' | 'countdown' | 'playing' | 'over'. */
    phase: t.string(),
    hostPid: t.number(),
    /** 3..1 during countdown, 0 otherwise/GO. */
    countdownN: t.number(),
    /** Seconds since GO (HUD timer). */
    roundTime: t.number(),
    /** Current arena radius (sudden death + shrink already applied). */
    radius: t.number(),
    slippery: t.boolean(),
    /** Current modifier window: '' when none, else ModKind. */
    modKind: t.string(),
    /** 'warn' | 'active' | ''. */
    modStage: t.string(),
    sudden: t.boolean(),
    winnerPid: t.number(),
    winnerName: t.string(),
    players: t.map(PlayerState),
    obstacles: t.array(ObstacleState),
  },
  'GameState',
);

export type PlayerStateT = InstanceType<typeof PlayerState>;
export type GameStateT = InstanceType<typeof GameState>;
