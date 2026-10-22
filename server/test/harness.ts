/**
 * Minimal test harness: a REAL Colyseus server bound to an ephemeral port +
 * real @colyseus/sdk clients over real loopback WebSockets.
 *
 * (@colyseus/testing is deliberately NOT used: it pulls in @colyseus/tools,
 * whose @pm2/io dependency hijacks process.send() and crashes vitest's IPC
 * pool. A hand-rolled harness is ~20 lines and more honest anyway — tests
 * exercise the same browser code path: matchmake HTTP + WebSocket.)
 */

import { Server } from '@colyseus/core';
import { Client } from '@colyseus/sdk';
import { ArenaRoom, testFlags } from '../src/ArenaRoom';

export interface TestServer {
  port: number;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  if (process.env.LOL_TEST === '1') testFlags.debugVerbs = true;
  const gameServer = new Server({ devMode: false, greet: false, gracefullyShutdown: false });
  gameServer.define('arena', ArenaRoom);
  await gameServer.listen(0);
  const httpServer = (gameServer.transport as unknown as { server?: { address?: () => unknown } }).server;
  const addr = httpServer?.address?.() as { port?: number } | string | null;
  const port = typeof addr === 'object' && addr !== null ? (addr.port ?? 2577) : 2577;
  return {
    port,
    close: () => gameServer.gracefullyShutdown(false),
  };
}

export function makeClient(port: number): Client {
  return new Client(`ws://127.0.0.1:${port}`);
}
