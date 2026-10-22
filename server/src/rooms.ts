/**
 * Private rooms: 6-char unguessable codes, seat tokens for reconnection,
 * 2-8 players, no accounts, no persistence (rooms live in memory and die
 * with the process). A disconnected player keeps their seat for
 * ABSENT_KICK_MS; their fighter keeps simulating with zeroed input, which is
 * arena-consistent (they drift and get shoved off like anyone else).
 */

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Match } from './match';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROSTER_COLORS,
  ROSTER_RADII,
  type ClientMsg,
  type NetPlayerInfo,
  type ServerMsg,
} from '../../shared/src/net/protocol';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
export const ABSENT_KICK_MS = 90_000;
const EMPTY_ROOM_TTL_MS = 60_000;
export const LOBBY_RETURN_MS = 6_000;

export interface PlayerConn {
  id: number;
  name: string;
  token: string;
  ws: WebSocket | null;
  absentSince: number | null;
}

export class Room {
  readonly players: PlayerConn[] = [];
  match: Match | null = null;
  private nextId = 1;
  emptySince: number | null = Date.now();

  constructor(
    readonly manager: RoomManager,
    readonly code: string,
  ) {}

  get hostId(): number {
    return this.players[0]?.id ?? 0;
  }

  presentCount(): number {
    let n = 0;
    for (const p of this.players) if (p.ws) n++;
    return n;
  }

  isPresent(id: number): boolean {
    return this.players.some((p) => p.id === id && p.ws !== null);
  }

  playerByToken(token: string): PlayerConn | null {
    return this.players.find((p) => p.token === token) ?? null;
  }

  roster(): NetPlayerInfo[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      css: ROSTER_COLORS[(p.id - 1) % ROSTER_COLORS.length],
      radius: ROSTER_RADII[(p.id - 1) % ROSTER_RADII.length],
      present: p.ws !== null,
    }));
  }

  addPlayer(ws: WebSocket, name: string): PlayerConn {
    const player: PlayerConn = {
      id: this.nextId++,
      name: uniqueName(sanitizeName(name), this.players.map((p) => p.name)),
      token: randomBytes(16).toString('hex'),
      ws,
      absentSince: null,
    };
    this.players.push(player);
    this.emptySince = null;
    return player;
  }

  removePlayer(player: PlayerConn): void {
    const i = this.players.indexOf(player);
    if (i !== -1) this.players.splice(i, 1);
    if (this.players.length === 0) this.emptySince = Date.now();
  }

  sendTo(player: PlayerConn, msg: ServerMsg): void {
    try {
      player.ws?.send(JSON.stringify(msg));
    } catch {
      /* socket dying; close handler will clean up */
    }
  }

  broadcast(msg: ServerMsg, except?: PlayerConn): void {
    for (const p of this.players) {
      if (p === except) continue;
      this.sendTo(p, msg);
    }
  }

  /** Host-only; returns an error code on failure, null on success. */
  startMatch(): string | null {
    if (this.match) return 'match_running';
    if (this.presentCount() < MIN_PLAYERS) return 'need_players';
    this.match = new Match(this);
    this.broadcast({ t: 'start', seed: this.match.seed, roster: this.roster() });
    this.match.start();
    return null;
  }

  backToLobby(): void {
    this.match = null;
    this.broadcast({ t: 'lobby', players: this.roster(), hostId: this.hostId });
  }

  /** Socket dropped: release the wire but hold the seat for a rejoin. */
  markAbsent(player: PlayerConn): void {
    player.ws = null;
    player.absentSince = Date.now();
    this.broadcast({ t: 'lobby', players: this.roster(), hostId: this.hostId });
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private byWs = new Map<WebSocket, { room: Room; player: PlayerConn }>();

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  get count(): number {
    return this.rooms.size;
  }

  membership(ws: WebSocket): { room: Room; player: PlayerConn } | undefined {
    return this.byWs.get(ws);
  }

  createRoom(): Room {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
      }
    } while (this.rooms.has(code));
    const room = new Room(this, code);
    this.rooms.set(code, room);
    return room;
  }

  /** Route one raw client message. testMode unlocks the debug verb. */
  handle(ws: WebSocket, raw: string, testMode: boolean): void {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      this.error(ws, 'bad_json', 'Message is not valid JSON.');
      return;
    }
    if (!msg || typeof msg.t !== 'string') {
      this.error(ws, 'bad_msg', 'Missing message type.');
      return;
    }

    switch (msg.t) {
      case 'host': {
        if (this.byWs.has(ws)) return this.error(ws, 'already_in_room', 'Leave your current room first.');
        const room = this.createRoom();
        const player = room.addPlayer(ws, msg.name ?? '');
        this.byWs.set(ws, { room, player });
        room.sendTo(player, {
          t: 'joined',
          you: player.id,
          room: room.code,
          token: player.token,
          players: room.roster(),
          hostId: room.hostId,
        });
        return;
      }
      case 'join': {
        if (this.byWs.has(ws)) return this.error(ws, 'already_in_room', 'Leave your current room first.');
        const room = this.get(String(msg.room ?? ''));
        if (!room) return this.error(ws, 'room_not_found', 'No room with that code.');
        if (room.players.length >= MAX_PLAYERS) return this.error(ws, 'room_full', 'That room is full.');
        const player = room.addPlayer(ws, msg.name ?? '');
        this.byWs.set(ws, { room, player });
        room.sendTo(player, {
          t: 'joined',
          you: player.id,
          room: room.code,
          token: player.token,
          players: room.roster(),
          hostId: room.hostId,
        });
        room.broadcast({ t: 'lobby', players: room.roster(), hostId: room.hostId }, player);
        return;
      }
      case 'rejoin': {
        if (this.byWs.has(ws)) return this.error(ws, 'already_in_room', 'Already connected to a room.');
        const room = this.get(String(msg.room ?? ''));
        const player = room?.playerByToken(String(msg.token ?? ''));
        if (!room || !player) return this.error(ws, 'bad_rejoin', 'Unknown room or token.');
        if (player.ws && player.ws !== ws) player.ws.close(4001, 'rejoined elsewhere');
        player.ws = ws;
        player.absentSince = null;
        this.byWs.set(ws, { room, player });
        room.sendTo(player, {
          t: 'joined',
          you: player.id,
          room: room.code,
          token: player.token,
          players: room.roster(),
          hostId: room.hostId,
        });
        room.broadcast({ t: 'lobby', players: room.roster(), hostId: room.hostId }, player);
        return;
      }
      case 'input': {
        const m = this.byWs.get(ws);
        if (!m?.room.match) return;
        const seq = Number(msg.seq ?? 0);
        if (!Number.isFinite(seq)) return;
        m.room.match.applyInput(
          m.player.id,
          Number(msg.mx ?? 0),
          Number(msg.my ?? 0),
          msg.dash === true,
        );
        return;
      }
      case 'start': {
        const m = this.byWs.get(ws);
        if (!m) return;
        if (m.player.id !== m.room.hostId) {
          return this.error(ws, 'not_host', 'Only the room host can start the match.');
        }
        const err = m.room.startMatch();
        if (err) this.error(ws, err, 'Cannot start the match right now.');
        return;
      }
      case 'leave': {
        const m = this.byWs.get(ws);
        if (!m) return;
        m.room.removePlayer(m.player);
        this.byWs.delete(ws);
        m.room.broadcast({ t: 'lobby', players: m.room.roster(), hostId: m.room.hostId });
        this.send(ws, { t: 'lobby', players: [], hostId: 0 }); // ack; client resets to menu
        return;
      }
      case 'ping':
        this.send(ws, { t: 'pong' });
        return;
      case 'debug': {
        if (!testMode) return this.error(ws, 'forbidden', 'Debug verbs are disabled.');
        const m = this.byWs.get(ws);
        if (!m?.room.match) return;
        if (msg.cmd === 'place') {
          const f = m.room.match.engine.fighters.find((x) => x.id === Number(msg.id));
          if (f) {
            f.pos.x = Number(msg.x);
            f.pos.y = Number(msg.y);
            f.vel.x = Number(msg.vx ?? 0);
            f.vel.y = Number(msg.vy ?? 0);
          }
        }
        return;
      }
      default:
        return this.error(ws, 'bad_msg', 'Unknown message type.');
    }
  }

  /** A socket went away (close/error): release the wire, hold the seat. */
  onClose(ws: WebSocket): void {
    const m = this.byWs.get(ws);
    if (!m) return;
    this.byWs.delete(ws);
    m.room.markAbsent(m.player);
  }

  /** Periodic maintenance: kick long-absent seats, delete empty rooms. */
  sweep(now = Date.now()): void {
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.players]) {
        if (p.ws === null && p.absentSince !== null && now - p.absentSince > ABSENT_KICK_MS) {
          room.removePlayer(p);
          room.broadcast({ t: 'lobby', players: room.roster(), hostId: room.hostId });
        }
      }
      if (room.players.length === 0) {
        if (room.emptySince === null) room.emptySince = now;
        else if (now - room.emptySince > EMPTY_ROOM_TTL_MS) this.rooms.delete(room.code);
      }
    }
  }

  /** Test teardown. */
  closeAll(): void {
    for (const ws of [...this.byWs.keys()]) {
      try {
        ws.close(1001, 'server closing');
      } catch {
        /* already gone */
      }
    }
    this.byWs.clear();
    this.rooms.clear();
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* dying socket */
    }
  }

  private error(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { t: 'error', code, message });
  }
}

function sanitizeName(raw: string): string {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 12);
  return cleaned;
}

function uniqueName(base: string, taken: string[]): string {
  const name = base || 'Player';
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}
