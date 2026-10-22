# Colyseus API verification (installed versions)

Verified against the packages actually installed in this repo (read from
`node_modules/*/build/*.d.ts` and `Room.mjs` source, not from blog posts),
per the "verify the APIs for the installed SDK versions" requirement.

## Versions installed (2026-10, pinned in package.json)

| Package | Version | Role |
| --- | --- | --- |
| `colyseus` | 0.18.10 | server framework (`@colyseus/core` 0.18.23 resolved) |
| `@colyseus/schema` | 5.0.42 | state serialization (shared by server + client) |
| `@colyseus/sdk` | 0.18.6 | browser client SDK (0.18's new client package) |
| `@colyseus/testing` | 0.18.6 | test boot helper (dev dep of server) |
| Node engine | >= 22 required by colyseus 0.18 | repo runs Node v24 |

Note: the legacy client package `colyseus.js` (0.16.x) is NOT used — 0.18's
client SDK is `@colyseus/sdk`, which depends on schema 5 and matches the 0.18
wire protocol.

## Server APIs verified (`@colyseus/core/build/{Server,Room}.d.ts`)

- `new Server({ express: (app) => {...} })` — the transport initializes an
  Express-compatible app and hands it to this callback. Used to serve the
  static client build + dev-only CORS from the same port as the WebSocket.
- `gameServer.define("arena", ArenaRoom)` then `await gameServer.listen(port)`.
- Room lifecycle: `onCreate(options)`, `onAuth`, `onJoin(client, options)`,
  `onLeave(client, code)`, `onDispose()`, `onMessage(type, handler)`.
- **Custom room id is official**: `Room.d.ts` line ~326 — *"You may replace
  `this.roomId` during `onCreate()`"* (setter exists, allowed only during
  creation). We set the 6-char room code here; clients join via
  `client.joinById(code)`.
- `this.maxClients = 8` — matchmaking enforces capacity.
- `this.lock() / unlock()` — block/unblock new joins (we lock during a live
  match; reconnections bypass the lock because the seat is reserved).
- `this.patchRate = 50` — state patch frequency in **milliseconds**
  (default 50 = 20 Hz, exactly our snapshot rate). `setPatchRate()` is
  deprecated in favor of the `patchRate` property.
- `this.setTimestep(cb, ms)` — the 0.18 name for the simulation loop
  (`setSimulationInterval` still exists but is deprecated; we use
  `setTimestep`).
- `this.allowReconnection(client, seconds)` — Room **method** (not a module
  import like 0.14/0.16), returns `Deferred<Client>`. Throws when the grace
  period expires. `client.reconnectionToken` + `client.reconnect(token)` on
  the SDK side complete the flow.
- **Auto-dispose vs reconnect seats** (verified in `Room.mjs` source,
  `#_disposeIfEmpty()`): a room auto-disposes only when
  `clients.length === 0 && reservedSeats === 0`. A pending
  `allowReconnection` holds a reserved seat, so a room whose last player
  briefly dropped stays alive for the full grace window, and disposes right
  after the grace expires. Default `autoDispose = true` fits our design —
  no manual lifecycle management needed.
- `this.maxMessagesPerSecond` — built-in per-client flood control
  (disconnects a client that exceeds it; default Infinity). We set 60.
- `this.clock` (from `@colyseus/timer`) — `setTimeout/setInterval/...` tied
  to the room lifecycle (auto-cleared on dispose).
- `this.broadcast(type, message, { except? })`, `this.broadcastPatch()`.

## Schema 5 APIs verified (`@colyseus/schema/build/annotations.d.ts`, `types/builder.d.ts`)

- Decorators (`@type`) still exist, but this repo's tsconfigs use
  `useDefineForClassFields: true` without `experimentalDecorators` — legacy
  property decorators would silently misbehave. Chosen solution: the
  **decorator-free functional API**:
  - `const GameState = schema({ ...fields }, "GameState")` — creates a fully
    typed Schema subclass at runtime.
  - Field builder `t`: `t.string()`, `t.number()`, `t.boolean()`,
    `t.map(ChildClass)`, `t.array(ChildClass)`.
  - Collections: `MapSchema`, `ArraySchema` exported for typing.
- No tsconfig changes required anywhere (client stays byte-identical at the
  compiler level — important for the solo-parity gate).
- The 63-field limit per schema class: our state classes use 15 and 18.

## Client SDK APIs verified (`@colyseus/sdk/build/Client.d.ts`, `Room.d.ts`)

- `new Client(endpoint)`; `client.create(roomName, options, GameState)`,
  `client.joinById(roomId, options, GameState)`,
  `client.reconnect(reconnectionToken, GameState)`.
- Room instance: `room.sessionId`, `room.reconnectionToken`,
  `room.state`, `room.send(type, payload)`, `room.onMessage(type, cb)`
  (callback receives the payload only — wildcard form gets `(type, payload)`),
  `room.onStateChange(cb)`, `room.onLeave(cb)`, `room.leave()`.
- Matchmaking errors reject the join promise (used for room-not-found /
  room-full / room-locked UX).

## Testing APIs verified (`@colyseus/testing/build/index.d.ts`, `TestServer.d.ts`)

- `boot({ rooms: { arena: ArenaRoom } }, port?)` → test server with:
  `.sdk` (a real `@colyseus/sdk` client talking to the real transport),
  `.http.get/post/...`, `.createRoom(name, clientOptions)`,
  `.getRoomById(roomId)`, `.cleanup()`, `.shutdown()`.
- Integration tests use `app.sdk.joinById(...)` etc. — the same code path
  browsers take (matchmake HTTP + WebSocket), in-process.

## Behavior decisions grounded in the above

1. Room code = custom `roomId` (verified official), join via `joinById`.
2. Reconnection = `allowReconnection(client, 90)` + `client.reconnect(token)`;
   server maps stable numeric player ids (pid 1..8) to whatever the current
   `sessionId` is, because Colyseus reconnection re-creates the connection.
3. Built-in `maxMessagesPerSecond = 60` + our own per-message input
   validation (NaN/Infinity checks, magnitude clamp, boolean coercion).
4. `patchRate = 50` (20 Hz patches) while the sim ticks at 30 Hz — identical
   cadence to the stage-2 raw-ws design, now handled by the schema encoder.
