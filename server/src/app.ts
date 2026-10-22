/**
 * HTTP + WebSocket server assembly. Serves the static client build (so the
 * whole game can ship as ONE deployable service) and mounts the multiplayer
 * endpoint at /ws. No framework, one runtime dependency (ws).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager } from './rooms';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AliveWs extends WebSocket {
  isAlive?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export interface App {
  httpServer: http.Server;
  rooms: RoomManager;
  testMode: boolean;
  /** Close everything (used by tests and graceful shutdown). */
  close(): Promise<void>;
}

export function createApp(
  opts: { staticDir?: string | null; testMode?: boolean } = {},
): App {
  const testMode = opts.testMode ?? process.env.LOL_TEST === '1';
  const staticDir = opts.staticDir !== undefined ? opts.staticDir : path.resolve(__dirname, '../../client/dist');

  const httpServer = http.createServer((req, res) => {
    if (!staticDir) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    const target = path.normalize(path.join(staticDir, rel));
    if (!target.startsWith(staticDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        // SPA-ish fallback: unknown paths get the shell (the client is a
        // single page; deep links like /?room=CODE hit / and are fine).
        fs.readFile(path.join(staticDir, 'index.html'), (err2, shell) => {
          if (err2) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(shell);
        });
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  const rooms = new RoomManager();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (rawWs: WebSocket) => {
    const ws = rawWs as AliveWs;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => {
      rooms.handle(ws, String(data), testMode);
    });
    ws.on('close', () => rooms.onClose(ws));
    ws.on('error', () => {
      /* 'close' always follows; nothing else to do */
    });
  });

  const heartbeat = setInterval(() => {
    for (const raw of wss.clients) {
      const ws = raw as AliveWs;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);

  const sweeper = setInterval(() => rooms.sweep(), 5_000);

  return {
    httpServer,
    rooms,
    testMode,
    close(): Promise<void> {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      rooms.closeAll();
      return new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
}
