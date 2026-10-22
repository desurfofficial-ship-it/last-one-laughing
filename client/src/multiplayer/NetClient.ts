/**
 * NetClient / mpSession: the browser side of multiplayer. Wraps
 * @colyseus/sdk 0.18 and owns:
 *  - room create/join-by-code/reconnect flows
 *  - the reconnection loop (sessionStorage token, ~90 s grace server-side)
 *  - a tiny event emitter so the DOM lobby (MpUI) and the Phaser
 *    MultiplayerScene can both observe the session without knowing
 *    about each other.
 *
 * The server validates everything it receives; this layer only ever sends
 * input intents and lobby verbs (see ArenaRoom.handleInput).
 */

import { Client, type Room } from '@colyseus/sdk';
import { GameState, type GameStateT } from '../../../shared/src/state/schema';
import type { MatchEvent } from '../../../shared/src/net/protocol';

/** Multiplayer endpoint: same origin by default (the game server hosts the
 *  client build); override with VITE_MP_ENDPOINT when the client ships
 *  from a static host (e.g. GitHub Pages) and the server lives elsewhere.
 *
 *  Production rules baked in here:
 *   - HTTPS pages always get a secure endpoint (http endpoints are upgraded
 *     to https; the hosts we target terminate TLS at the edge).
 *   - A Pages build without VITE_MP_ENDPOINT resolves to '' so the lobby can
 *     show its "not configured" state instead of doomed joins. */
const VITE_ENDPOINT = ((import.meta.env?.VITE_MP_ENDPOINT as string | undefined) ?? '').trim();

function resolveEndpoint(): string {
  if (import.meta.env.PROD && !VITE_ENDPOINT && /\.github\.io$/.test(window.location.hostname)) {
    return '';
  }
  const base = VITE_ENDPOINT || window.location.origin;
  try {
    const u = new URL(base);
    if (window.location.protocol === 'https:' && u.protocol === 'http:') u.protocol = 'https:';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return base;
  }
}

export const MP_ENDPOINT: string = resolveEndpoint();

const TOKEN_KEY = 'lol_mp_reconnect';

export type MpStatus =
  | 'idle'
  | 'connecting'
  | 'lobby'
  | 'in-match'
  | 'reconnecting'
  | 'left'
  | 'error';

type Handler = (payload: any) => void;

export class MpSession {
  /** Lazily built so a misconfigured deploy never throws at import time. */
  private _client: Client | null = null;
  get client(): Client {
    if (!this._client) this._client = new Client(MP_ENDPOINT || window.location.origin);
    return this._client;
  }
  room: Room<GameStateT> | null = null;
  myPid = 0;
  code = '';
  name = '';
  status: MpStatus = 'idle';
  lastError = '';
  /** True while WE are tearing the session down on purpose. */
  private leaving = false;
  /** True while the SDK's transparent auto-reconnection owns recovery. */
  private reconnecting = false;
  private reconnectAbort: (() => void) | null = null;
  private handlers = new Map<string, Set<Handler>>();

  // ------------------------------------------------------------------ bus

  on(ev: string, cb: Handler): () => void {
    let set = this.handlers.get(ev);
    if (!set) {
      set = new Set();
      this.handlers.set(ev, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  private emit(ev: string, payload?: unknown): void {
    for (const cb of [...(this.handlers.get(ev) ?? [])]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[mp] handler for "${ev}" failed`, err);
      }
    }
  }

  private setStatus(status: MpStatus): void {
    this.status = status;
    console.info(`[mp] status -> ${status}`);
    this.emit('status', status);
  }

  // ---------------------------------------------------------------- state

  get state(): GameStateT | null {
    return (this.room?.state as GameStateT) ?? null;
  }

  get connected(): boolean {
    return this.room !== null && this.status !== 'reconnecting';
  }

  // --------------------------------------------------------------- joins

  async create(name: string): Promise<void> {
    this.assertNotConfigured();
    await this.enter(() => this.client.create('arena', { name }, GameState as any), name);
  }

  async join(code: string, name: string): Promise<void> {
    this.assertNotConfigured();
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(clean)) throw new Error('Room codes are 6 letters/digits.');
    await this.enter(() => this.client.joinById(clean, { name }, GameState as any), name);
  }

  private assertNotConfigured(): void {
    if (!MP_ENDPOINT) throw new Error('mp_not_configured');
  }

  /** Re-enter a room after a drop (page reload included). */
  async reconnectToken(token: string): Promise<void> {
    await this.enter(() => this.client.reconnect(token, GameState as any), this.name);
  }

  private async enter(
    joinFn: () => Promise<Room<GameStateT>>,
    name: string,
  ): Promise<void> {
    this.leaving = false;
    this.reconnecting = false;
    this.lastError = '';
    this.name = name;
    this.setStatus('connecting');
    try {
      const room = await this.joinWithRetry(joinFn);
      this.room = room;
      try {
        sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken);
      } catch {
        /* private mode: reconnection across reloads just won't work */
      }
      this.bindRoom(room);
      // The state (and our row, via sid == sessionId) lands asynchronously.
      const pid = await this.waitForOwnPid(room, 8000);
      this.myPid = pid;
      this.code = String((room.state as GameStateT).code ?? '');
      this.setStatus('lobby');
      this.emit('entered', { pid, code: this.code });
    } catch (err: any) {
      this.room = null;
      this.lastError = explainJoinError(err);
      this.setStatus('error');
      this.emit('error', this.lastError);
      throw err;
    }
  }

  /**
   * Free-tier hosts spin idle servers down; the first join after a lull
   * waits out a cold start of up to ~1 minute. Retry network-class
   * failures in production before surfacing an error (dev: one attempt).
   */
  private async joinWithRetry(joinFn: () => Promise<Room<GameStateT>>): Promise<Room<GameStateT>> {
    const attempts = import.meta.env.PROD ? 7 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await joinFn();
      } catch (err) {
        if (attempt >= attempts || !isNetworkError(err)) throw err;
        this.emit('connecting-retry', { attempt, attempts });
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }

  private async waitForOwnPid(room: Room<GameStateT>, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = room.state as GameStateT | undefined;
      if (state) {
        for (const p of state.players.values()) {
          if (p.sid === room.sessionId) return p.pid;
        }
      }
      if (Date.now() > deadline) {
        throw new Error('Joined, but the room state never arrived.');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private bindRoom(room: Room<GameStateT>): void {
    room.onMessage('ev', (e: MatchEvent) => this.emit('ev', e));
    room.onMessage('error', (e: { code: string; message: string }) =>
      this.emit('server-error', e),
    );
    room.onStateChange(() => this.emit('state'));
    room.onLeave((code) => this.handleLeave(code));
  }

  private handleLeave(code: number): void {
    if (this.leaving) {
      this.room = null;
      this.myPid = 0;
      this.clearToken();
      this.setStatus('left');
      this.emit('left', { intentional: true });
      return;
    }

    if (!this.reconnecting) {
      // First unexpected drop: @colyseus/sdk auto-reconnection is ALREADY
      // retrying the same session transparently (same sessionId, so the
      // server never releases the seat). Keep the room + state objects so
      // the scene keeps rendering, and resume when it lands.
      this.reconnecting = true;
      this.setStatus('reconnecting');
      this.emit('left', { intentional: false, code });
      this.room?.onReconnect(() => {
        this.reconnecting = false;
        this.setStatus('lobby');
        this.emit('reconnected', {});
      });
      return;
    }

    // The SDK gave up (its retries exhausted). Fall back to the stored
    // reconnection token while the server still holds the seat (90 s).
    this.reconnecting = false;
    this.room = null;
    this.myPid = 0;
    const token = this.readToken();
    this.setStatus('reconnecting');
    this.emit('left', { intentional: false, code });
    if (!token) {
      this.finishReconnectFailure('You were disconnected.');
      return;
    }
    this.reconnectLoop(token);
  }

  private reconnectLoop(token: string): void {
    let cancelled = false;
    this.reconnectAbort = () => {
      cancelled = true;
    };
    const deadline = Date.now() + 95_000; // slightly past the server's grace
    const attempt = async (): Promise<void> => {
      while (!cancelled && Date.now() < deadline) {
        try {
          await this.reconnectToken(token);
          return; // 'entered' flow re-bound everything
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!cancelled) this.finishReconnectFailure('Could not rejoin the room in time.');
    };
    void attempt();
  }

  private finishReconnectFailure(message: string): void {
    this.clearToken();
    this.lastError = message;
    this.setStatus('error');
    this.emit('error', message);
  }

  // ---------------------------------------------------------------- verbs

  sendInput(mx: number, my: number, dash: boolean): void {
    this.room?.send('input', { mx, my, dash });
  }

  sendReady(ready: boolean): void {
    this.room?.send('ready', ready);
  }

  sendStart(): void {
    this.room?.send('start');
  }

  requestLeave(): void {
    if (!this.room) {
      this.setStatus('idle');
      return;
    }
    this.leaving = true;
    this.reconnectAbort?.();
    const room = this.room;
    this.room = null;
    room.leave().catch(() => {});
    this.clearToken();
    this.setStatus('left');
    this.emit('left', { intentional: true });
  }

  // ---------------------------------------------------------------- token

  readToken(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  clearToken(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
}

function explainJoinError(err: any): string {
  const msg = String(err?.message ?? err ?? '');
  if (/mp_not_configured/i.test(msg)) return 'Multiplayer is not configured for this build.';
  if (/room not found|invalid room/i.test(msg)) return 'No room with that code.';
  if (/locked|full/i.test(msg)) return 'That room is full or mid-match - try again soon.';
  if (/failed to reconnect|expired/i.test(msg)) return 'Your seat expired - join again.';
  if (/network|fetch|WebSocket/i.test(msg)) return 'Could not reach the multiplayer server.';
  return msg || 'Connection failed.';
}

/** Cold starts / dead servers surface as fetch or websocket failures. */
function isNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  return /network|fetch|websocket|econnrefused|bad gateway|service unavailable|timeout|unavailable|upgrade required/i.test(
    msg,
  );
}

export const mpSession = new MpSession();
