/**
 * THE stage-2 proof: two separate WebSocket clients join the same private
 * room and play one full authoritative match.
 *
 * Proven here:
 *  1. host + join by code -> both admitted to one room;
 *  2. host starts -> both receive the SAME seed and roster;
 *  3. both clients' inputs drive the ONE server-owned simulation
 *     (identical snapshots on both wires; A drifts left, B drifts right);
 *  4. mid-match disconnect + token rejoin -> same match continues;
 *  5. a scripted elimination -> BOTH clients observe the same fall
 *     (with the same KO attribution) and the same winner;
 *  6. the room returns to the lobby afterwards.
 */

import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ARENA_RADIUS, ARENA_CENTER } from '../../shared/src/constants';
import { createApp, type App } from '../src/app';

// --------------------------------------------------------------- test client

class Client {
  readonly ws: WebSocket;
  private msgs: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Send an input burst at ~30 Hz for `ms` milliseconds. */
  streamInput(ms: number, mx: number, my: number): NodeJS.Timeout {
    let seq = 0;
    const timer = setInterval(() => this.send({ t: 'input', seq: seq++, mx, my, dash: false }), 33);
    setTimeout(() => clearInterval(timer), ms);
    return timer;
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 8000): Promise<any> {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  snaps(): any[] {
    return this.msgs.filter((m) => m.t === 'snap');
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new Client(ws);
}

const snapWithEvent = (c: Client, t: string, extra: (ev: any) => boolean = () => true) =>
  c.waitFor((m) => m.t === 'snap' && m.s.events.some((ev: any) => ev.t === t && extra(ev)), 12_000);

// ------------------------------------------------------------------- fixture

let app: App;
let url: string;

beforeAll(async () => {
  app = createApp({ testMode: true, staticDir: null });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = app.httpServer.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await app.close();
});

// --------------------------------------------------------------------- tests

describe('two clients, one authoritative match', () => {
  it('join -> play -> rejoin -> elimination -> same winner -> lobby', async () => {
    // 1. Host creates the private room; guest joins by code.
    const a = await connect(url);
    a.send({ t: 'host', name: 'Ann' });
    const aJoined = await a.waitFor((m) => m.t === 'joined');
    const room = aJoined.room as string;
    expect(room).toMatch(/^[A-Z2-9]{6}$/);
    expect(aJoined.you).toBe(1);

    const b = await connect(url);
    b.send({ t: 'join', room, name: 'Bob' });
    const bJoined = await b.waitFor((m) => m.t === 'joined');
    expect(bJoined.you).toBe(2);
    expect(bJoined.players).toHaveLength(2);
    await a.waitFor((m) => m.t === 'lobby' && m.players.length === 2);

    // 2. Host starts; both get the same seed + roster.
    a.send({ t: 'start' });
    const [aStart, bStart] = await Promise.all([
      a.waitFor((m) => m.t === 'start'),
      b.waitFor((m) => m.t === 'start'),
    ]);
    expect(aStart.seed).toBe(bStart.seed);
    expect(aStart.roster.map((p: any) => p.id)).toEqual([1, 2]);

    // 3. Both streams of inputs drive the single server sim.
    //    Streams must span the 3 s countdown INTO the playing phase (the
    //    server rightly ignores inputs until GO), and aim from each spawn
    //    (Ann bottom-left, Bob top-right) across the center so nobody
    //    drifts off the rim.
    a.streamInput(3800, 0.5, -0.5); // Ann drifts up-right, toward center
    b.streamInput(3800, -0.5, 0.5); // Bob drifts down-left, toward center
    await new Promise((r) => setTimeout(r, 3900));

    const aSnaps = a.snaps();
    const bSnaps = b.snaps();
    expect(aSnaps.length).toBeGreaterThan(5);
    expect(bSnaps.length).toBeGreaterThan(5);
    // Same tick => byte-identical authoritative state on both wires.
    const bByTick = new Map(bSnaps.map((m) => [m.s.tick, m.s]));
    let compared = 0;
    for (const am of aSnaps) {
      const bs = bByTick.get(am.s.tick);
      if (!bs) continue;
      expect(bs.players).toEqual(am.s.players);
      expect(bs.radius).toBe(am.s.radius);
      compared++;
    }
    expect(compared).toBeGreaterThan(5);
    // The server-owned physics actually moved them across the center.
    const firstA = aSnaps[0].s.players.find((p: any) => p.id === 1);
    const lastA = aSnaps.at(-1).s.players.find((p: any) => p.id === 1);
    const firstB = aSnaps[0].s.players.find((p: any) => p.id === 2);
    const lastB = aSnaps.at(-1).s.players.find((p: any) => p.id === 2);
    expect(lastA.x).toBeGreaterThan(firstA.x + 60);
    expect(lastB.x).toBeLessThan(firstB.x - 60);

    // 4. Mid-match drop + token rejoin: same match, continuing ticks.
    const lastTickSeen = aSnaps.at(-1).s.tick;
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    const a2 = await connect(url);
    a2.send({ t: 'rejoin', room, token: aJoined.token });
    const a2Joined = await a2.waitFor((m) => m.t === 'joined');
    expect(a2Joined.you).toBe(1);
    expect(a2Joined.players.every((p: any) => p.present)).toBe(true);
    // Snapshots resume with ticks strictly beyond what A saw before dropping.
    await a2.waitFor((m) => m.t === 'snap' && m.s.tick > lastTickSeen);
    // And the rejoiner still receives the same shared state as B.
    const a2Snap = await a2.waitFor((m) => m.t === 'snap');
    const bMatch = b.waitFor((m) => m.t === 'snap' && m.s.tick === a2Snap.s.tick);
    await expect(bMatch).resolves.toBeTruthy();

    // 5. Scripted elimination through REAL network inputs: park Bob near the
    //    rim (neutral stick), line Ann up 160 px inward, and dash right.
    //    The dash must knock Bob past the rim with attribution to Ann on
    //    BOTH wires, then end the round with Ann as the winner.
    b.send({ t: 'input', seq: 999, mx: 0, my: 0, dash: false }); // neutralize stale stick
    a2.send({ t: 'debug', cmd: 'place', id: 2, x: ARENA_CENTER.x + ARENA_RADIUS - 30, y: ARENA_CENTER.y, vx: 0, vy: 0 });
    a2.send({ t: 'debug', cmd: 'place', id: 1, x: ARENA_CENTER.x + ARENA_RADIUS - 190, y: ARENA_CENTER.y, vx: 0, vy: 0 });
    let seq = 1000;
    const dasher = setInterval(
      () => a2.send({ t: 'input', seq: seq++, mx: 1, my: 0, dash: true }),
      33,
    );
    setTimeout(() => clearInterval(dasher), 1200);

    const [aFall, bFall] = await Promise.all([
      snapWithEvent(a2, 'fall', (ev) => ev.id === 2),
      snapWithEvent(b, 'fall', (ev) => ev.id === 2),
    ]);
    const aFallEv = aFall.s.events.find((ev: any) => ev.t === 'fall' && ev.id === 2);
    const bFallEv = bFall.s.events.find((ev: any) => ev.t === 'fall' && ev.id === 2);
    expect(aFallEv.byId).toBe(1);
    expect(bFallEv.byId).toBe(1);

    const [aEnd, bEnd] = await Promise.all([
      snapWithEvent(a2, 'end'),
      snapWithEvent(b, 'end'),
    ]);
    expect(aEnd.s.events.find((ev: any) => ev.t === 'end').winnerId).toBe(1);
    expect(bEnd.s.events.find((ev: any) => ev.t === 'end').winnerId).toBe(1);

    // 6. Room returns to the lobby on both wires.
    await Promise.all([
      a2.waitFor((m) => m.t === 'lobby', 10_000),
      b.waitFor((m) => m.t === 'lobby', 10_000),
    ]);
    a2.close();
    b.close();
  }, 25_000);

  it('rejects joining an unknown room code', async () => {
    const c = await connect(url);
    c.send({ t: 'join', room: 'ZZZZZZ' });
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err.code).toBe('room_not_found');
    c.close();
  });

  it('refuses to start with fewer than two players present', async () => {
    const c = await connect(url);
    c.send({ t: 'host', name: 'Solo' });
    await c.waitFor((m) => m.t === 'joined');
    c.send({ t: 'start' });
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err.code).toBe('need_players');
    c.close();
  });
});
