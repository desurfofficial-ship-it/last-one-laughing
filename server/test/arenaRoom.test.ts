/**
 * ArenaRoom integration tests over the REAL Colyseus transport
 * (@colyseus/testing boots a real server; app.sdk is a real @colyseus/sdk
 * client doing real matchmake HTTP + WebSocket round-trips).
 *
 * Coverage required by the stage-2 brief:
 *  - room joining (create + shareable code + join by code)
 *  - room capacity (2-8 players; 9th rejected)
 *  - round transitions (lobby -> countdown -> playing -> over -> lobby,
 *    host-only start, min players, ready gating)
 *  - elimination/winner logic (same fall + same winner on BOTH wires;
 *    KO attribution itself is covered by the RoundEngine unit tests)
 *  - reconnection (abrupt drop holds the seat; token rejoin keeps identity)
 *  - input validation + server-side rate limits
 */

import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeClient, startTestServer, type TestServer } from './harness';
import { GameState, type GameStateT } from '../../shared/src/state/schema';
import type { MatchEvent, WelcomeMsg } from '../../shared/src/net/protocol';
import { ArenaRoom } from '../src/ArenaRoom';

process.env.LOL_TEST = '1';

type SdkRoom = {
  state: GameStateT;
  sessionId: string;
  reconnectionToken: string;
  send: (t: string, data?: unknown) => void;
  leave: (c?: boolean) => Promise<number>;
  onMessage: (t: string, cb: (payload: any) => void) => () => void;
  onLeave: (cb: (code: number) => void) => () => void;
  connection: { close: () => void };
};

// Short victory lap so round-transition tests don't wait 6 s.
ArenaRoom.lobbyReturnMs = 700;

function sdkRoom(raw: any): SdkRoom {
  return raw as SdkRoom;
}

function collectEvents(room: SdkRoom): MatchEvent[] {
  const events: MatchEvent[] = [];
  room.onMessage('ev', (e: MatchEvent) => events.push(e));
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  label: string,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

/** Join (create or by code); identity comes from the state row whose sid == room.sessionId. */
async function join(
  port: number,
  opts: { code?: string; name: string },
): Promise<{ room: SdkRoom; welcome: WelcomeMsg; events: MatchEvent[] }> {
  const client = makeClient(port);
  const raw = opts.code
    ? await client.joinById(opts.code, { name: opts.name }, GameState)
    : await client.create('arena', { name: opts.name }, GameState);
  const room = sdkRoom(raw);
  const events = collectEvents(room);
  // The decoded state (and our own row) arrives asynchronously after the
  // join promise resolves; wait for the row keyed by our sessionId.
  const row = await waitFor(() => {
    for (const p of room.state.players.values()) {
      if (p.sid === room.sessionId) return p;
    }
    return null;
  }, 'own player row in decoded state');
  return { room, welcome: { pid: row.pid, code: room.state.code }, events };
}

/** Start a ready 2-player match and wait for the playing phase. */
async function startMatch(port: number): Promise<{
  a: Awaited<ReturnType<typeof join>>;
  b: Awaited<ReturnType<typeof join>>;
}> {
  const a = await join(port, { name: 'Ada' });
  const b = await join(port, { code: a.welcome.code, name: 'Basil' });
  const errors: string[] = [];
  a.room.onMessage('error', (e: any) => errors.push(e?.code));
  b.room.onMessage('error', (e: any) => errors.push(e?.code));
  // Cross-socket ordering is not guaranteed: stagger the lobby messages so
  // each has landed before the next one fires.
  a.room.send('ready', true);
  await sleep(120);
  b.room.send('ready', true);
  await sleep(120);
  a.room.send('start');
  await waitFor(() => a.room.state.phase === 'playing', 'playing phase', 9_000);
  expect(errors).toEqual([]);
  return { a, b };
}

describe('ArenaRoom (Colyseus 0.18)', () => {
  let srv: TestServer;
  let port: number;

  beforeAll(async () => {
    srv = await startTestServer();
    port = srv.port;
  });

  afterAll(async () => {
    await srv.close();
  });

  // -------------------------------------------------------------- joining

  it('create gives a server-generated 6-char code and a welcome with a stable pid', async () => {
    const { room, welcome } = await join(port, { name: 'Ada' });
    expect(welcome.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(welcome.pid).toBeGreaterThan(0);
    expect(room.state.code).toBe(welcome.code);
    expect(room.state.phase).toBe('lobby');
    const me = room.state.players.get(String(welcome.pid));
    expect(me?.name).toBe('Ada');
    expect(me?.host).toBe(true);
    expect(me?.present).toBe(true);
    await room.leave();
  });

  it('two clients join the same room by code and see the same roster', async () => {
    const a = await join(port, { name: 'Ada' });
    const b = await join(port, { code: a.welcome.code, name: 'Basil' });
    expect(b.room.state.code).toBe(a.welcome.code);
    // Both clients converge on the SAME authoritative state (b's ADD patch).
    await waitFor(() => a.room.state.players.size === 2, 'a sees both players');
    expect(b.room.state.players.size).toBe(2);
    expect(a.room.state.players.get(String(b.welcome.pid))?.name).toBe('Basil');
    expect(b.room.state.players.get(String(a.welcome.pid))?.name).toBe('Ada');
    // Host is the first seated player.
    expect(a.room.state.hostPid).toBe(a.welcome.pid);
    expect(a.room.state.players.get(String(a.welcome.pid))?.host).toBe(true);
    await a.room.leave();
    await b.room.leave();
  });

  it('joining an unknown code fails with a matchmake error', async () => {
    await expect(makeClient(port).joinById('ZZZZZZ', { name: 'Ghost' }, GameState)).rejects.toThrow();
  });

  // ------------------------------------------------------------- capacity

  it('caps the room at 8 players and rejects the 9th', async () => {
    const host = await join(port, { name: 'Host' });
    const clients = [host];
    for (let i = 2; i <= 8; i++) {
      clients.push(await join(port, { code: host.welcome.code, name: `P${i}` }));
    }
    // ADD patches ship on the 50 ms patch cadence.
    await waitFor(() => host.room.state.players.size === 8, 'all adds visible to host');
    await expect(
      makeClient(port).joinById(host.welcome.code, { name: 'Late' }, GameState),
    ).rejects.toThrow();
    for (const c of clients) {
      c.room.leave().catch(() => {});
    }
  });

  // ---------------------------------------------------- round transitions

  it('start is host-only and blocked until MIN_PLAYERS present and ready', async () => {
    const a = await join(port, { name: 'Ada' });
    const errors: string[] = [];
    a.room.onMessage('error', (e: any) => errors.push(e.code));
    const bErrors: string[] = [];

    a.room.send('start'); // alone, not ready
    await sleep(120);
    expect(errors).toContain('need_players');

    const b = await join(port, { code: a.welcome.code, name: 'Basil' });
    b.room.onMessage('error', (e: any) => bErrors.push(e.code));
    b.room.send('start'); // not the host (the error goes to B)
    await sleep(120);
    expect(bErrors).toContain('not_host');

    a.room.send('ready', true); // host ready, Basil not
    await sleep(120);
    a.room.send('start');
    await sleep(120);
    expect(errors).toContain('need_ready');

    // Both ready -> start works and the phase advances for BOTH clients.
    b.room.send('ready', true);
    await sleep(120);
    a.room.send('start');
    await waitFor(() => a.room.state.phase === 'countdown', 'countdown phase');
    await waitFor(() => b.room.state.phase === 'countdown', 'countdown phase on b');
    a.room.leave().catch(() => {});
    b.room.leave().catch(() => {});
  });

  it('runs lobby -> countdown -> playing -> over -> lobby with matching events on both clients', async () => {
    const { a, b } = await startMatch(port);
    const evA = a.events;
    const evB = b.events;

    // Countdown events 3..1 (+ GO at 0) arrive identically on both wires.
    await waitFor(() => a.room.state.phase === 'playing', 'playing', 8_000);
    const countsA = evA.filter((e) => e.t === 'countdown').map((e) => (e as any).n);
    const countsB = evB.filter((e) => e.t === 'countdown').map((e) => (e as any).n);
    expect(countsA).toContain(3);
    expect(countsA).toContain(0);
    expect(countsB).toEqual(countsA);

    // Same seed view + phase + round clock on both clients.
    expect(b.room.state.seed).toBe(a.room.state.seed);
    expect(b.room.state.phase).toBe(a.room.state.phase);
    expect(b.room.state.roundTime).toBe(a.room.state.roundTime);
    expect(b.room.state.radius).toBe(a.room.state.radius);

    // Shove Basil's fighter past the rim (test-only debug verb) -> fall.
    await waitFor(() => a.room.state.roundTime >= 0.4, 'some play time');
    sendPlace(a.room, 2, 540 + 520, 540, 950, 0);
    await waitFor(() => evA.some((e) => e.t === 'fall' && (e as any).id === 2), 'fall event on A');
    await waitFor(() => evB.some((e) => e.t === 'fall' && (e as any).id === 2), 'fall event on B');
    await waitFor(() => a.room.state.phase === 'over', 'over phase');
    const endA = evA.find((e) => e.t === 'end') as any;
    const endB = evB.find((e) => e.t === 'end') as any;
    expect(endA).toBeTruthy();
    expect(endB.winnerId).toBe(endA.winnerId);
    expect(endA.winnerId).toBe(1); // Ada is the last one standing
    expect(a.room.state.winnerPid).toBe(1);

    // Short victory lap; the room returns to the lobby and unlocks.
    await waitFor(() => a.room.state.phase === 'lobby', 'lobby return', 5_000);
    expect(b.room.state.phase).toBe('lobby');
    // Ready flags reset for the next match.
    expect(a.room.state.players.get(String(a.welcome.pid))?.ready).toBe(false);
    a.room.leave().catch(() => {});
    b.room.leave().catch(() => {});
  });

  // ---------------------------------------------------------- reconnection

  it('holds the seat on an abrupt drop and preserves identity through token rejoin', async () => {
    const a = await join(port, { name: 'Ada' });
    const b = await join(port, { code: a.welcome.code, name: 'Basil' });

    // The SDK delivers the reconnection token asynchronously after join.
    await waitFor(() => b.room.reconnectionToken, 'reconnection token delivered');

    // Simulate a network drop (not a voluntary leave).
    b.room.connection.close();
    await waitFor(
      () => a.room.state.players.get(String(b.welcome.pid))?.present === false,
      'presence=false on drop',
    );
    // Seat is still held (no removal) during the reconnection window.
    expect(a.room.state.players.size).toBe(2);

    // Rebind with the reconnection token -> same pid, presence restored.
    const rejoined = sdkRoom(await makeClient(port).reconnect(b.room.reconnectionToken, GameState));
    const rejoinedRow = await waitFor(() => {
      for (const p of rejoined.state.players.values()) {
        if (p.sid === rejoined.sessionId) return p;
      }
      return null;
    }, 'rejoined own player row');
    expect(rejoinedRow.present).toBe(true);
    expect(rejoinedRow.pid).toBe(b.welcome.pid); // identity preserved
    expect(rejoined.state.code).toBe(a.welcome.code);
    await waitFor(() => a.room.state.players.get(String(b.welcome.pid))?.present === true, 'presence restored for a');
    a.room.leave().catch(() => {});
    rejoined.leave().catch(() => {});
  });

  it('releases the seat immediately on a voluntary leave', async () => {
    const a = await join(port, { name: 'Ada' });
    const b = await join(port, { code: a.welcome.code, name: 'Basil' });
    b.room.send('leave'); // voluntary
    await waitFor(() => a.room.state.players.size === 1, 'seat released on voluntary leave');
    await a.room.leave();
  });

  // ------------------------------------------- input validation + limits

  it('rejects malformed input and keeps simulating (no trust in client data)', async () => {
    const { a, b } = await startMatch(port);
    const t0 = a.room.state.roundTime;

    a.room.send('input', { mx: Number.NaN, my: 0, dash: true });
    a.room.send('input', { mx: Infinity, my: 0, dash: false });
    a.room.send('input', { mx: 'up', my: null, dash: 'yes' });
    a.room.send('input', 42);
    await sleep(400);

    // The room kept ticking despite the garbage.
    expect(a.room.state.phase).toBe('playing');
    expect(a.room.state.roundTime).toBeGreaterThan(t0);
    // Nobody was teleported out of the arena by input abuse (positions come
    // from the authoritative sim over the wire, and the rim is at ~980 px).
    for (const p of a.room.state.players.values()) {
      expect(Math.hypot(p.x - 540, p.y - 540)).toBeLessThan(700);
    }
    a.room.leave().catch(() => {});
    b.room.leave().catch(() => {});
  });

  it('disconnects clients that flood messages (built-in rate limit)', async () => {
    const a = await join(port, { name: 'Flood' });
    for (let i = 0; i < 200; i++) a.room.send('input', { mx: 0.1, my: 0, dash: false });
    // The server force-closes the socket (CloseCode.WITH_ERROR); the SDK's
    // auto-reconnection may delay onLeave, so assert on the raw socket.
    await waitFor(
      () => (a.room.connection as any).transport?.ws?.readyState !== 1,
      'socket closed by server after flood',
    );
    await sleep(200);
  });

  // ------------------------------------------------------- late-join lock

  it('locks the room during a match and rejects late joiners', async () => {
    const { a, b } = await startMatch(port);
    await expect(makeClient(port).joinById(a.welcome.code, { name: 'Late' }, GameState)).rejects.toThrow();
    a.room.leave().catch(() => {});
    b.room.leave().catch(() => {});
  });
});

/** Test-only debug verb: teleport a fighter (requires LOL_TEST=1). */
function sendPlace(room: SdkRoom, id: number, x: number, y: number, vx = 0, vy = 0): void {
  room.send('debug', { cmd: 'place', id, x, y, vx, vy });
}

describe('ArenaRoom seat release mid-match (no ghost fighters)', () => {
  let srv: TestServer;
  let port: number;

  beforeAll(async () => {
    srv = await startTestServer();
    port = srv.port;
  });

  afterAll(async () => {
    await srv.close();
  });

  it('a voluntary leave mid-match force-outs the fighter and ends the round', async () => {
    const { a, b } = await startMatch(port);

    // Ada leaves mid-match: her fighter must go through the fall path and
    // the round must end with Basil as the winner (no eternal ghost stall).
    // The fall event arrives on the REMAINING client's wire (Ada is gone).
    await a.room.leave();
    await waitFor(() => b.events.some((e) => e.t === 'fall' && (e as any).id === 1), 'fall event for leaver');
    await waitFor(() => b.room.state.phase === 'over', 'over phase', 9_000);
    const end = b.events.find((e) => e.t === 'end') as any;
    expect(end).toBeTruthy();
    expect(end.winnerId).toBe(2); // Basil is the last one standing
    // Authoritative check from the remaining client: Ada's seat is released.
    expect(b.room.state.players.has('1')).toBe(false);

    await waitFor(() => b.room.state.phase === 'lobby', 'lobby return', 6_000);
    b.room.leave().catch(() => {});
  });

  it('a leave during countdown with too few players aborts back to the lobby', async () => {
    const a = await join(port, { name: 'Ada' });
    const b = await join(port, { code: a.welcome.code, name: 'Basil' });
    a.room.send('ready', true);
    await sleep(120);
    b.room.send('ready', true);
    await sleep(120);
    a.room.send('start');
    await waitFor(() => a.room.state.phase === 'countdown', 'countdown', 9_000);

    await b.room.leave();
    await waitFor(() => a.room.state.phase === 'lobby', 'match aborted to lobby', 9_000);
    expect(a.room.state.players.has(String(b.welcome.pid))).toBe(false);
    a.room.leave().catch(() => {});
  });
});
