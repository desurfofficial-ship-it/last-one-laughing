/**
 * ArenaRoom: the authoritative multiplayer room (Colyseus 0.18).
 *
 * The server owns EVERYTHING that matters: round timing, positions,
 * collisions, knockback, dashes, eliminations, modifier windows, sudden
 * death and the final winner (via the shared RoundEngine). Clients send
 * tiny validated input intents; nothing they report is trusted.
 *
 * Lifecycle: lobby (seat up to 8, ready flags) -> host starts -> countdown
 * 3s (clamp physics, inputs ignored) -> playing (30 Hz sim, 20 Hz patches)
 * -> over (victory lap ~6 s) -> back to lobby.
 *
 * Room code = this.roomId (officially replaceable during onCreate — see
 * docs/colyseus-api-verification.md). Reconnection: allowReconnection holds
 * the seat for ABSENT_KICK_MS; the absent fighter keeps simulating with
 * zeroed input, which is arena-consistent (they drift and get shoved off
 * like anyone else).
 */

import { Room, CloseCode, type Client } from '@colyseus/core';
import { GameState, ObstacleState, PlayerState, type GameStateT, type PlayerStateT } from '../../shared/src/state/schema';
import { RoundEngine, type RosterEntry } from '../../shared/src/sim/RoundEngine';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROSTER_COLORS,
  ROSTER_RADII,
  type ErrorMsg,
  type MatchEvent,
} from '../../shared/src/net/protocol';
import { ARENA_RADIUS } from '../../shared/src/constants';

const TICK_HZ = 30;
const TICK_MS = Math.round(1000 / TICK_HZ);
export const ABSENT_KICK_MS = 90; // seconds (allowReconnection grace)
export const LOBBY_RETURN_MS = 6_000; // victory lap before the lobby
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const CODE_LEN = 6;

/** Test-only knobs (never settable by clients). */
export const testFlags = { debugVerbs: false };

interface JoinOpts {
  name?: string;
}

interface InputPayload {
  mx?: unknown;
  my?: unknown;
  dash?: unknown;
}

export class ArenaRoom extends Room<{ state: GameStateT }> {
  /** Victory-lap duration; tests shorten it. (static so tests can retune.) */
  static lobbyReturnMs = LOBBY_RETURN_MS;

  private engine: RoundEngine | null = null;
  /** Latest input intent per pid; the dash bit is consumed on the tick that receives it. */
  private pendingInputs = new Map<number, { mx: number; my: number; dash: boolean }>();
  private pidBySession = new Map<string, number>();
  private voluntary = new Set<string>();
  private nextPid = 1;
  private endedAt: number | null = null;
  /** Lobby auto-start when everyone is ready (cancelled if someone un-readies). */
  private autoStartTimer: ReturnType<typeof setTimeout> | null = null;

  override onCreate(): void {
    this.maxClients = MAX_PLAYERS;
    this.patchRate = 50; // 20 Hz state patches (sim ticks at 30 Hz)
    // Built-in flood control: any client exceeding this is disconnected
    // (inputs are sent at ~30 Hz; 60/s leaves ample headroom).
    this.maxMessagesPerSecond = 60;

    // Private room code, server-generated, unguessable. Officially allowed
    // during onCreate only (docs/colyseus-api-verification.md).
    let code = '';
    do {
      code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      // Collision odds are negligible (31^6 space); drivers dedupe anyway.
    } while (code === 'DELETE');
    this.roomId = code;

    this.setState(new GameState());
    this.state.code = code;
    this.state.phase = 'lobby';
    this.state.hostPid = 0;
    this.state.radius = ARENA_RADIUS;

    this.onMessage('input', (client, msg: InputPayload) => this.handleInput(client, msg));
    this.onMessage('ready', (client, ready: unknown) => this.handleReady(client, ready));
    this.onMessage('start', (client) => this.handleStart(client));
    this.onMessage('leave', (client) => {
      this.voluntary.add(client.sessionId);
      client.leave();
    });
    this.onMessage('ping', (client) => client.send('pong', Date.now()));
    this.onMessage('debug', (client, msg: any) => this.handleDebug(client, msg));

    // Fixed-rate authoritative simulation. (0.18 renamed setSimulationInterval;
    // see docs/colyseus-api-verification.md.)
    this.setTimestep(() => this.tick(), TICK_MS);

    console.log(`[arena] room created: ${this.roomId}`);
  }

  override onDispose(): void {
    console.log(`[arena] room disposed: ${this.roomId}`);
  }

  // ----------------------------------------------------------------- joins

  override onJoin(client: Client, opts: JoinOpts = {}): void {
    if (this.state.players.size >= MAX_PLAYERS) {
      // Matchmaking normally enforces this; belt and braces.
      throw new Error('room_full');
    }
    const pid = this.nextPid++;
    const player = new PlayerState();
    player.pid = pid;
    player.sid = client.sessionId;
    player.name = uniqueName(sanitizeName(opts?.name ?? ''), this.names());
    player.css = ROSTER_COLORS[(pid - 1) % ROSTER_COLORS.length];
    player.host = this.state.players.size === 0;
    player.ready = false;
    player.present = true;
    this.state.players.set(String(pid), player);
    if (player.host) this.state.hostPid = pid;
    this.pidBySession.set(client.sessionId, pid);
    this.voluntary.delete(client.sessionId);

    // NOTE: identity flows through the state row (player.sid == sessionId).
    // Do NOT client.send() from inside onJoin — messages sent before the
    // client's join handshake completes corrupt its message stream in
    // @colyseus/sdk 0.18.6 (client self-closes with CONSENTED).
    this.refreshRosterFlags();
    console.log(`[arena ${this.roomId}] + player ${pid} (${player.name}); ${this.state.players.size} seated`);
  }

  /** The caller's own player row (by sessionId), if seated. */
  private rowOf(client: Client): PlayerStateT | undefined {
    const pid = this.pidBySession.get(client.sessionId);
    return pid !== undefined ? this.state.players.get(String(pid)) : undefined;
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const pid = this.pidBySession.get(client.sessionId);
    if (pid === undefined) return;
    const player = this.state.players.get(String(pid));
    if (!player) return;

    // Classify the departure:
    //  - CONSENTED (the SDK's room.leave() protocol byte) or our 'leave'
    //    message -> deliberate; release the seat immediately.
    //  - A force-close (flood/protocol error) or any leave where the socket
    //    is STILL OPEN -> evict. Core defers the socket close until this
    //    handler resolves, so awaiting allowReconnection here would hang the
    //    client's leave() promise for the whole grace window.
    //  - A socket that is genuinely GONE (browser refresh, network drop,
    //    offline self-close) -> hold the seat for the reconnection grace.
    const consented = code === CloseCode.CONSENTED;
    const socketOpen = (client as unknown as { ref?: { readyState?: number } }).ref?.readyState === 1; // ws OPEN
    if (consented || this.voluntary.has(client.sessionId) || socketOpen) {
      this.voluntary.delete(client.sessionId);
      this.pidBySession.delete(client.sessionId);
      this.state.players.delete(String(pid));
      this.reassignHost();
      this.onSeatReleased(pid);
      this.maybeAbandonMatch();
      this.scheduleAutoStart(); // may cancel if below min / not all ready
      console.log(`[arena ${this.roomId}] - player ${pid} left (code ${code}); seat released`);
      return;
    }

    // Dropped socket: hold the seat for a while. The absent fighter keeps
    // simulating with zeroed input (present=false), exactly like the
    // stage-2 raw-ws design.
    player.present = false;
    this.refreshRosterFlags();
    console.log(`[arena ${this.roomId}] - player ${pid} dropped (code ${code}); seat held`);
    try {
      await this.allowReconnection(client, ABSENT_KICK_MS);
      player.present = true;
      player.sid = client.sessionId; // defensive: reserved seat keeps its id
      this.refreshRosterFlags();
      console.log(`[arena ${this.roomId}] player ${pid} reconnected`);
    } catch {
      // Grace expired: release the seat for real.
      this.pidBySession.delete(client.sessionId);
      this.state.players.delete(String(pid));
      this.reassignHost();
      this.onSeatReleased(pid);
      this.maybeAbandonMatch();
      console.log(`[arena ${this.roomId}] player ${pid} seat released`);
    }
  }

  // ----------------------------------------------------------- lobby msgs

  private handleReady(client: Client, ready: unknown): void {
    const player = this.rowOf(client);
    if (!player || this.engine) return; // lobby only
    player.ready = ready === true;
    this.scheduleAutoStart();
  }

  private handleStart(client: Client): void {
    const player = this.rowOf(client);
    if (!player) return;
    if (player.pid !== this.state.hostPid) {
      this.error(client, 'not_host', 'Only the room host can start the match.');
      return;
    }
    const err = this.startMatch();
    if (err) this.error(client, err, 'Cannot start the match right now.');
  }

  /** Returns an error code on failure, null on success. */
  /** When every present player is ready, auto-start after a short delay so
   *  guests are not stuck staring at a silent lobby while the host hunts for
   *  the Start button. Host can still start immediately. */
  private scheduleAutoStart(): void {
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer);
      this.autoStartTimer = null;
    }
    if (this.engine) return;
    const present = [...this.state.players.values()].filter((p) => p.present);
    if (present.length < MIN_PLAYERS) return;
    if (!present.every((p) => p.ready)) return;
    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null;
      const err = this.startMatch();
      if (err) console.log(`[arena ${this.roomId}] auto-start skipped: ${err}`);
    }, 2500);
  }

  private startMatch(): Extract<ErrorMsg['code'], 'match_running' | 'need_players' | 'need_ready'> | null {
    if (this.engine) return 'match_running';
    // Only present players enter the match. Absent seats (reconnection grace)
    // must not create uncontrollable ghost fighters, and fighter ids MUST equal
    // the stable player pid so inputs / schema writes / forceOut stay aligned
    // even when lobby leave+rejoin left gaps in the pid sequence.
    const present = [...this.state.players.values()]
      .filter((p) => p.present)
      .sort((a, b) => a.pid - b.pid);
    if (present.length < MIN_PLAYERS) return 'need_players';
    if (!present.every((p) => p.ready)) return 'need_ready';

    const seed = Math.floor(Math.random() * 0x7fffffff);
    const roster: RosterEntry[] = present.map((p) => ({
      id: p.pid,
      name: p.name,
      css: p.css,
      radius: ROSTER_RADII[(p.pid - 1) % ROSTER_RADII.length],
    }));
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer);
      this.autoStartTimer = null;
    }
    this.engine = new RoundEngine(roster, seed);
    this.pendingInputs.clear();
    this.endedAt = null;

    this.state.seed = seed;
    this.state.phase = 'countdown';
    this.state.radius = ARENA_RADIUS;
    this.state.winnerPid = 0;
    this.state.winnerName = '';
    this.state.obstacles.clear();

    this.lock(); // no mid-match joins; reconnections still work (reserved seat)
    console.log(`[arena ${this.roomId}] match started (seed ${seed}, ${roster.length} fighters)`);
    return null;
  }

  /** Over -> lobby: reset round view, unlock the room. */
  private backToLobby(): void {
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer);
      this.autoStartTimer = null;
    }
    this.engine = null;
    this.pendingInputs.clear();
    this.endedAt = null;
    const s = this.state;
    s.phase = 'lobby';
    s.roundTime = 0;
    s.radius = ARENA_RADIUS;
    s.slippery = false;
    s.modKind = '';
    s.modStage = '';
    s.sudden = false;
    s.winnerPid = 0;
    s.winnerName = '';
    s.countdownN = 0;
    s.obstacles.clear();
    for (const p of s.players.values()) {
      p.ready = false;
      p.kos = 0;
      p.state = 'active';
      p.dashT = 0;
      p.dashCd = 0;
    }
    this.unlock();
  }

  // ----------------------------------------------------------- sim tick

  private tick(): void {
    const e = this.engine;
    if (!e) return;
    const playing = e.phase === 'playing';

    // Hold the match while a seat is in the reconnection grace window so a
    // brief drop does not become an instant forfeit / edge-fall win.
    if (playing) {
      const waiting = [...this.state.players.values()].some((p) => !p.present);
      if (waiting) {
        this.writeMatchState(e);
        return;
      }
    }

    for (const f of e.fighters) {
      const player = this.state.players.get(String(f.id));
      if (!playing || !player || !player.present || f.state !== 'active') {
        // Countdown/over, absent players, and non-active fighters hold
        // the stick neutral: no ghost steering.
        f.input.moveX = 0;
        f.input.moveY = 0;
        continue;
      }
      const inp = this.pendingInputs.get(f.id);
      if (inp) {
        let { mx, my } = inp;
        const mag = Math.hypot(mx, my);
        if (mag > 1) {
          mx /= mag;
          my /= mag;
        }
        f.input.moveX = mx;
        f.input.moveY = my;
        if (inp.dash) f.dashQueued = true;
        inp.dash = false;
      } else {
        f.input.moveX = 0;
        f.input.moveY = 0;
      }
    }

    e.update(1 / TICK_HZ);
    const events = e.drainEvents();
    if (process.env.LOL_EV === '1') logMatchEvents(e, events);
    for (const ev of events) this.broadcast('ev', ev);
    this.writeMatchState(e);

    if (e.isOver && this.endedAt === null) this.endedAt = Date.now();
    if (this.endedAt !== null && Date.now() - this.endedAt >= ArenaRoom.lobbyReturnMs) {
      this.backToLobby();
    }
  }

  /** Mirror the engine into the schema (delta-encoded; only changes ship). */
  private writeMatchState(e: RoundEngine): void {
    const s = this.state;
    s.phase = e.phase;
    s.countdownN = e.phase === 'countdown' ? Math.max(0, Math.ceil(e.countdownT)) : 0;
    s.roundTime = r1(e.roundTime);
    s.radius = r1(e.phys.arenaRadius);
    s.slippery = e.slipperyState === 'slippery';
    const mv = e.modView;
    s.modKind = mv ? (mv.kind as string) : '';
    s.modStage = mv ? mv.stage : '';
    s.sudden = e.suddenDeath;
    if (e.isOver) {
      s.winnerPid = e.winnerId === null || e.winnerId === undefined ? -1 : e.winnerId;
      const w = e.winnerId != null ? s.players.get(String(e.winnerId)) : undefined;
      s.winnerName = e.winnerId == null ? '' : (w?.name ?? '');
    }

    for (const f of e.fighters) {
      const p = s.players.get(String(f.id));
      if (!p) continue;
      p.x = r1(f.pos.x);
      p.y = r1(f.pos.y);
      p.vx = r1(f.vel.x);
      p.vy = r1(f.vel.y);
      p.facing = r2(Math.atan2(f.facing.y, f.facing.x));
      p.state = f.state;
      p.dashT = r2(f.dashTimer);
      p.dashCd = r2(f.dashCooldown);
      p.kos = f.kos;
    }

    // Bumpers: rebuild only when the set changes, update positions otherwise.
    const obs = e.obstacles;
    if (s.obstacles.length !== obs.length) {
      s.obstacles.clear();
      for (const o of obs) {
        const os = new ObstacleState();
        os.x = r1(o.pos.x);
        os.y = r1(o.pos.y);
        os.vx = r1(o.vel.x);
        os.vy = r1(o.vel.y);
        os.radius = o.radius;
        s.obstacles.push(os);
      }
    } else {
      for (let i = 0; i < obs.length; i++) {
        const os = s.obstacles[i];
        const o = obs[i];
        if (!os) continue;
        os.x = r1(o.pos.x);
        os.y = r1(o.pos.y);
        os.vx = r1(o.vel.x);
        os.vy = r1(o.vel.y);
        os.radius = o.radius;
      }
    }
  }

  // ------------------------------------------------------- input + debug

  /**
   * Clients send validated input intents (~30 Hz): a move vector plus a
   * dash REQUEST bit consumed exactly once. Everything is re-validated
   * here; the schema/JSON can carry NaN/strings from a modified client.
   */
  private handleInput(client: Client, msg: InputPayload): void {
    if (!this.engine) return;
    const player = this.rowOf(client);
    if (!player) return;
    const mx = Number(msg?.mx);
    const my = Number(msg?.my);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return; // NaN/Infinity junk
    this.pendingInputs.set(player.pid, { mx, my, dash: msg?.dash === true });
  }

  /** Test/dev only — rejected unless the process runs with LOL_TEST=1. */
  private handleDebug(client: Client, msg: any): void {
    if (!testFlags.debugVerbs) return this.error(client, 'forbidden', 'Debug verbs are disabled.');
    if (!this.engine || msg?.cmd !== 'place') return;
    const f = this.engine.fighters.find((x) => x.id === Number(msg.id));
    if (!f) return;
    f.pos.x = Number(msg.x);
    f.pos.y = Number(msg.y);
    f.vel.x = Number(msg.vx ?? 0);
    f.vel.y = Number(msg.vy ?? 0);
  }

  private error(client: Client, code: ErrorMsg['code'], message: string): void {
    client.send('error', { code, message } satisfies ErrorMsg);
  }

  // ---------------------------------------------------------------- misc

  /** Mirror presence/host flags into the schema rows (UI list sources). */
  private refreshRosterFlags(): void {
    const hostPid = this.state.hostPid;
    for (const p of this.state.players.values()) p.host = p.pid === hostPid;
  }

  private reassignHost(): void {
    if (this.state.players.size === 0) {
      this.state.hostPid = 0;
      return;
    }
    const alive = [...this.state.players.values()].sort((a, b) => a.pid - b.pid);
    if (!alive.some((p) => p.pid === this.state.hostPid)) {
      this.state.hostPid = alive[0]?.pid ?? 0;
    }
    this.refreshRosterFlags();
  }

  /**
   * A seat was released while a round exists: keep the match honest.
   * The released fighter must not linger as a ghost that can never be
   * eliminated (it would stall the round forever), and its schema row is
   * already gone so clients cannot render it. forceOut runs the normal fall
   * path in countdown AND playing (a countdown leave in a 2-player room ends
   * the round as a win for whoever stayed; in bigger rooms the match simply
   * continues without them). 'over' needs nothing.
   */
  private onSeatReleased(pid: number): void {
    this.engine?.forceOut(pid);
  }

  /**
   * Everyone left mid-match (all seats dropped and grace expired, or all
   * left): tear the match down so the room doesn't linger as a locked husk.
   */
  private maybeAbandonMatch(): void {
    if (this.state.players.size > 0) return;
    if (this.engine) {
      this.engine = null;
      this.pendingInputs.clear();
      this.endedAt = null;
    }
    this.state.phase = 'lobby';
    this.unlock();
  }

  private names(): string[] {
    return [...this.state.players.values()].map((p) => p.name);
  }
}

// -------------------------------------------------------------------- utils

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Verbose diagnostics for server operators (LOL_EV=1): logs match-shaping
 * events with round time and positions. Never enabled by default; logs no
 * secrets (there are none in MatchEvents).
 */
function logMatchEvents(e: RoundEngine, events: MatchEvent[]): void {
  for (const ev of events) {
    if (
      ev.t !== 'hit' &&
      ev.t !== 'fall' &&
      ev.t !== 'mod' &&
      ev.t !== 'sudden' &&
      ev.t !== 'phase' &&
      ev.t !== 'end'
    ) {
      continue;
    }
    const pos =
      ev.t === 'hit' ? ` at(${Math.round(ev.x)},${Math.round(ev.y)}) dv${Math.round(ev.deltaV)}` : '';
    const victim =
      ev.t === 'fall'
        ? (() => {
            const f = e.fighters.find((x) => x.id === ev.id);
            return ` pos(${Math.round(f?.pos.x ?? -1)},${Math.round(f?.pos.y ?? -1)}) R=${Math.round(e.phys.arenaRadius)}`;
          })()
        : '';
    console.log(`[ev] t=${e.roundTime.toFixed(1)} ${JSON.stringify(ev)}${pos}${victim}`);
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sanitizeName(raw: string): string {
  return String(raw ?? '')
    // Strip control chars, trim, cap length.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 12);
}

function uniqueName(base: string, taken: string[]): string {
  const name = base || 'Player';
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}
