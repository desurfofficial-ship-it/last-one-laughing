/**
 * Entrypoint: one Colyseus server serving BOTH the WebSocket multiplayer
 * rooms and the static Phaser client build (single deployable service).
 *
 * Environment:
 *   PORT              - listen port (default 8787)
 *   NODE_ENV          - 'production' disables dev CORS + verbose logs
 *   LOL_CLIENT_DIST   - client build dir (default ../../client/dist)
 *   LOL_ALLOWED_ORIGIN - comma-separated CORS origins for browser clients
 *                        calling from a DIFFERENT origin (e.g. the Vite dev
 *                        server). Same-origin deployments need none.
 *   LOL_TEST          - '1' enables the debug 'place' verb (tests only)
 *
 * Secrets: none are needed (no accounts/persistence). Anything sensitive
 * stays in environment variables and never ships to the browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
// NOTE: import from @colyseus/core, NOT the umbrella 'colyseus' package —
// the umbrella re-exports @colyseus/tools, which loads dotenv + @pm2/io
// (KeyMetrics instrumentation) at import time. We want neither.
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ArenaRoom, testFlags } from './ArenaRoom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const IS_PROD = process.env.NODE_ENV === 'production';
const CLIENT_DIST = process.env.LOL_CLIENT_DIST
  ? path.resolve(process.env.LOL_CLIENT_DIST)
  : path.resolve(__dirname, '../../client/dist');
const ALLOWED_ORIGINS = (process.env.LOL_ALLOWED_ORIGIN ?? (IS_PROD ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (process.env.LOL_TEST === '1') testFlags.debugVerbs = true;

const gameServer = new Server({
  transport: new WebSocketTransport({ pingInterval: 15_000 }),
  // The transport owns an Express-compatible app; this callback decorates it
  // (verified: ServerOptions.express in @colyseus/core 0.18).
  express: (app: express.Application) => {
    // Health endpoint FIRST (before static + fallback): host health checks
    // and uptime monitors hit this. Counts come from the in-process
    // matchmaker, cached for 3 s so probes stay cheap.
    let healthCache = { at: 0, rooms: 0, players: 0, matches: 0 };
    app.get('/health', async (_req, res) => {
      const now = Date.now();
      if (now - healthCache.at > 3_000) {
        try {
          const rooms = await matchMaker.query({});
          healthCache = {
            at: now,
            rooms: rooms.length,
            players: rooms.reduce((n, r) => n + (r.clients ?? 0), 0),
            matches: rooms.filter((r) => r.locked).length,
          };
        } catch {
          /* keep the last snapshot */
        }
      }
      res.json({
        ok: true,
        uptime_s: Math.round(process.uptime()),
        rooms: healthCache.rooms,
        players: healthCache.players,
        matches: healthCache.matches,
        node: process.version,
      });
    });

    // Dev CORS: allow the Vite dev server to call matchmake endpoints.
    // Browsers do not enforce CORS on the WebSocket upgrade itself; the
    // HTTP matchmaking calls are what need the headers.
    if (!IS_PROD && ALLOWED_ORIGINS.length > 0) {
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ALLOWED_ORIGINS.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
          if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
          }
        }
        next();
      });
    }

    if (fs.existsSync(CLIENT_DIST)) {
      app.use(express.static(CLIENT_DIST, { index: 'index.html' }));
      // SPA-ish fallback: unknown GET paths get the shell. Deep links like
      // /?room=CODE hit / and are served by static(); this covers future
      // path-style routes.
      app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        res.sendFile(path.join(CLIENT_DIST, 'index.html'));
      });
      console.log(`[lol] serving client build from ${CLIENT_DIST}`);
    } else {
      console.warn(`[lol] client build not found at ${CLIENT_DIST} - WebSocket-only mode`);
      app.get('/', (_req, res) => {
        res.type('text/plain').send('Last One Laughing multiplayer server (client build not bundled)');
      });
    }
  },
});

gameServer.define('arena', ArenaRoom);

gameServer
  .listen(PORT)
  .then(() => {
    console.log(`[lol] Colyseus server listening on :${PORT} (${IS_PROD ? 'production' : 'development'})`);
  })
  .catch((err) => {
    console.error('[lol] failed to listen', err);
    process.exit(1);
  });

// Graceful shutdown (rooms dispose, clients get a clean close).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[lol] ${sig} received, shutting down`);
    void gameServer.gracefullyShutdown(false).then(() => process.exit(0));
  });
}

// Crash visibility: hosts restart the process; logs must say why. Nothing
// here logs secrets (there are none - no tokens, no IPs, no headers).
process.on('uncaughtException', (err) => {
  console.error('[lol] uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[lol] unhandledRejection', reason);
  process.exit(1);
});
