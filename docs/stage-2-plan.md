# Stage 2 Implementation Plan — Server-Authoritative Online Multiplayer

Status: PLAN ONLY (approved-by-audit, not yet implemented). Written after a full
read of the client source at commit `9262a2f` (= `230c768` + the remote
`fix: requestDash return contract + distinct bot personalities` commit, which
landed during this audit and is folded into the findings below). Verified
findings vs assumptions are labeled throughout. Nothing in this document
changes gameplay code.

## 0. Audit summary (verified unless noted)

### Module inventory and server-shareability

| File | Role | Phaser/DOM? | Server-shareable |
| --- | --- | --- | --- |
| `client/src/game/physics/ArenaPhysics.ts` | 120 Hz substep circle physics, impulses, dash slam bonus, bumper obstacles, fall detection | NO — imports only `constants` + `types` | YES, verbatim |
| `client/src/game/constants.ts` | All tuning numbers, fighter defs, spawn angles | NO | YES, verbatim |
| `client/src/game/types.ts` | `InputState`, `Body`, `Obstacle`, `HitEvent`, `Phase` | NO (types only) | YES, verbatim |
| `client/src/game/modifiers/SlipperyFloor.ts` | slippery cycle state machine (10/2/4 s) | NO | YES, verbatim |
| `client/src/game/modifiers/ModifierDirector.ts` | bumpers/shrink schedule (rest→warn→active→restore) | NO | YES, verbatim |
| `client/src/game/entities/Fighter.ts` | sim state (`Body`) + Phaser view in one class | YES (view) | PARTIAL — sim fields yes; `requestDash()` must be extracted (see §3) |
| `client/src/game/entities/BotController.ts` | bot AI producing `InputState` | type-only import of Fighter | YES in principle (needs `dashQueued` on the body type); defer |
| `client/src/game/scenes/GameScene.ts` (~1000 lines) | round lifecycle, timers, sudden death, modifier hooks, HUD, fx | YES | NO — lifecycle logic must be re-expressed in a shared `RoundEngine` |
| `client/src/input/playerInput.ts` | input bridge `{moveX, moveY, dashQueued, consumeDash()}` | NO (DOM-free) | reference for the wire input contract |
| `client/src/input/InputManager.ts`, `ui/UIManager.ts`, `main.ts`, `EventBus.ts`, `sfx.ts`, `motion.ts`, `styles.css`, `index.html` | DOM/touch/audio/menus | YES | NO (client-only) |

### Physics interfaces (verified)

- `ArenaPhysics<F extends Body>`: constructor takes `center` + fighters array.
  Per-frame entry: `step(dt, slippery: boolean, mode: 'open' | 'clamp')`.
  Callbacks: `onHit?(HitEvent<F>)`, `onFallStart?(f: F)`; `arenaRadius` is a
  public mutable field; `obstacles: Obstacle[]` is public and externally driven
  (GameScene pushes/pulls bumper balls); `freezeFor(ms)` pauses the sim
  (hitstop); `clearFreeze()` for restarts.
- Internally: dt clamped to 0.05 s, accumulator with fixed 1/120 s substeps,
  `MAX_STEPS = 6`. Pure math; zero randomness inside the module (verified).
- Collision/knockback: positional correction weighted by invMass; impulse with
  `COMBAT.restitution` 0.94; dash slam multiplier 1.35 + flat 90 px/s shove +
  guaranteed ≥ 470 px/s victim speed on confirmed slams; bumper strikes have
  their own softened impulse (restitution 0.55, capped 620).
- Fall: `open` boundary, fighter center beyond `arenaRadius + FALL_MARGIN (6)`
  → `state = 'falling'`, `onFallStart` fires; scene marks eliminated, awards
  the KO, fx later set `state = 'out'`.

### Player input contract (verified)

- Effective per-frame sim input on a `Body`: `{ moveX, moveY }` (normalized,
  deadzone 0.1 applied client-side) plus `dashQueued` boolean (NOT part of the
  `Body` interface — it lives only on `Fighter`). This trio is exactly what a
  networked client must send; `BotController` already proves the seam ("same
  InputState a networked player would produce").
- Dash execution (`Fighter.requestDash`, contract fixed in `9262a2f`): ALWAYS
  consumes `dashQueued`, checks `state === 'active'` and `dashCooldown <= 0`,
  direction = normalized input when magnitude ≥ 0.15 else `facing`, applies
  `+ DASH.speed (840)` impulse, sets `dashTimer = 0.16`, `dashCooldown = 1.8`,
  and returns `true` only when the dash actually fired. The call site is now a
  plain `if (f.requestDash())`. This consume-then-report contract is exactly
  the shape the server-side dash function must implement (client sends a dash
  bit; server consumes it once per tick and reports success via the next
  snapshot's `dashT/dashCd`).
- Bots (`9262a2f`): named personalities — Rex aggressive (aggression
  0.88–1.0, dashSkill 0.70–0.95), Momo balanced (0.60–0.80 / 0.45–0.70), Bit
  opportunistic (0.50–0.80 / 0.65–0.95), generic fallback otherwise. Input
  contract unchanged; irrelevant to the server except for future bot filler.

### Round lifecycle (verified, currently client-owned in GameScene)

`idle → countdown (3 s) → playing → over`:
- playing: `roundTime += dt`; slippery + director tick; sudden death at 75 s
  (base radius erodes 14 px/s to floor 270); applied radius =
  `max(ARENA_MIN_RADIUS, baseRadius − director.shrinkOffset())`; dash queues
  resolved; `phys.step(dt, slippery, 'open')`; win when active fighters ≤ 1
  (`alive[0] ?? null` — 0 alive = DRAW); 1400 ms later the result event fires.
- Elimination attribution: `lastHitBy` is set inside the scene's `onHit`
  handler (`e.victim.lastHitBy = e.attacker` when attacker non-null), KO
  credit awarded in `onFallStart`.
- Bumper spawn (`spawnBumpers`) uses `Math.random()` — the ONLY randomness in
  the sim path (bots are input-only). Server must own spawning with a seeded
  RNG; seed broadcast at round start.

### Arena modifiers (verified)

Three, all announced: SlipperyFloor (own cycle), ModifierDirector
(bumpers ⇄ shrink, warn 2.5 s before each window). Both are pure timing state
machines with injected hooks — server can run them identically and broadcast
state transitions as events.

### Build scripts / deployment (verified)

- `client/package.json`: `dev` (vite), `build` = `tsc --noEmit && vite build`,
  `typecheck`. Node `>=20`. Only runtime dep: `phaser ^3.90.0`.
- No root package.json, no workspace, no server, no tests (README documents
  this as stage-1 scope).
- `.github/workflows/deploy.yml`: push to `[main]` → `npm ci && npm run build`
  in `client/` → artifact `client/dist` → GitHub Pages (Actions source).
  Static hosting only — **cannot host WebSockets**; a separate server host is
  required.
- Vite `base: './'` (relocatable bundle), FIT scaling, 1080×1080 logical space.

### Test results run for this audit

- `npm run typecheck` — **exit 0** (clean), run at `230c768` and re-run after
  rebasing onto `9262a2f`.
- `npm run build` — **exit 0**, 22 modules; bundle 1250.46 kB (gzip 345 kB) at
  `230c768`, 1250.72 kB (gzip 345.41 kB, `index-vnkSyOKB.js`) at `9262a2f`;
  only the pre-existing Phaser chunk-size warning in both.
- Git: clean tree; audit began at `230c768` (in sync with origin); remote
  advanced mid-audit to `9262a2f` (requestDash contract + bot personalities);
  local rebased on top with this plan as `cd45d0d`.

## 1. Chosen architecture (smallest safe)

**Server-authoritative simulation, no client prediction in v1.**

- One Node process: plain `node:http` + `ws` (single dependency), no framework.
- The server runs the SAME `ArenaPhysics`, `SlipperyFloor`, `ModifierDirector`
  and constants inside a new shared `RoundEngine`, at a fixed 30 Hz tick (the
  physics accumulator turns each tick into 120 Hz substeps, unchanged).
- Clients send inputs (30 Hz, tiny), receive snapshots (20 Hz) + events.
  Rendering interpolates ~100 ms behind. Input latency ≈ RTT/2 + buffer; with
  damping-limited movement (terminal ~540 px/s) this is acceptable for an
  arena brawler and buys a drastically smaller, safer implementation than
  prediction+reconciliation. Prediction for the local fighter is a documented
  follow-up, not v1.
- Solo mode stays exactly as shipped (local sim, bots, zero networking) — the
  prototype is preserved. Multiplayer is a parallel read/write path selected
  at the menu.
- Rooms: 6-char code, shareable link `?room=CODE`, 2–8 players, no accounts,
  no persistence (rooms die with the process), no matchmaking/listing —
  "private" by construction.
- Reconnection: server issues a secret token at join (kept in
  `sessionStorage`); reconnect = `{roomCode, token}` within a 90 s grace
  window; absent fighters keep simulating with zeroed input (arena-consistent
  and fair); snapshot resync on rejoin.
- Authority: server validates input magnitudes (clamp), owns dash execution,
  collisions, knockback, eliminations, KO attribution, timers, modifiers,
  bumper spawns (seeded RNG, seed in `match_start`), winner. Clients render.

Why not alternatives: lockstep (needs bit-exact determinism — float math
across browsers is a trap); Cloudflare Durable Objects (fine, but platform-
specific API and egress shape); managed channels (Ably/Pusher cannot run our
sim). A plain Node process is portable to Fly.io/Render/Railway and keeps all
code in this repo in plain TypeScript.

## 2. Monorepo layout (npm workspaces)

```
last-one-laughing/
├── package.json              # NEW: workspaces [client, server, shared], scripts
├── shared/                   # NEW: engine-agnostic code (no phaser, no node, no DOM)
│   └── src/
│       ├── constants.ts      # moved (client keeps a re-export shim)
│       ├── types.ts          # moved + net-facing additions
│       ├── physics/ArenaPhysics.ts      # moved verbatim
│       ├── modifiers/{SlipperyFloor,ModifierDirector}.ts  # moved verbatim
│       ├── sim/Dash.ts       # extracted requestDash math (pure)
│       ├── sim/RoundEngine.ts  # NEW: authoritative round state machine
│       ├── net/protocol.ts   # C2S/S2C message types + quantization
│       └── util/rng.ts       # mulberry32 seeded RNG
├── server/                   # NEW
│   └── src/
│       ├── index.ts          # http + ws attach, static optional
│       ├── rooms.ts          # codes, tokens, capacity, rejoin
│       └── match.ts          # tick loop, input ingestion, snapshots
│   └── test/                 # vitest: RoundEngine unit + two-client integration
└── client/                   # UNCHANGED except the files listed in §5
```

## 3. Physics code that CANNOT be shared safely (verified)

1. `Fighter.requestDash()` — lives in a Phaser-importing file and its dash
   fallback direction reads `facing`, which is updated by the RENDER loop
   (`syncVisual`, frame-rate dependent). Server-side dash needs the same math
   but sim-owned facing. → Extract to `shared/sim/Dash.ts` implementing the
   (now fixed) consume-then-report contract; `Fighter` keeps a thin wrapper so
   solo mode is byte-for-byte behavior-identical. The facing update itself
   (lerp toward velocity direction) must also move into the shared sim so
   server and client agree on dash direction.
2. Hitstop `phys.freezeFor()` — it freezes the SIMULATION, which is correct
   locally but wrong on a server and would desync a predicting client. In MP
   mode hitstop must become view-only (pause interpolation, not the net loop).
   The server never calls it. (Solo mode keeps the current behavior.)
3. GameScene's lifecycle logic (timers, sudden death, radius application,
   `alive ≤ 1` end condition, KO attribution in the `onHit` handler) — Phaser-
   coupled and interleaved with fx. → Re-expressed once in `shared/sim/
   RoundEngine.ts`; GameScene keeps solo behavior, MP mode mirrors RoundEngine
   state into view.
4. `BotController` — type-shareable (imports Fighter as a TYPE only) but
   depends on the `dashQueued` field living on the fighter and is riddled with
   `Math.random()` (fine on a server, but unnecessary for v1 scope). Defer
   server-side bot filler to a later task.
5. `ArenaPhysics.step`'s dt clamp + `MAX_STEPS` accumulator — safe to reuse,
   but the server must call it once per fixed tick (dt = 1/30) and never use
   `freezeFor`, or catch-up behavior changes sim timing.

Shareable verbatim (verified by import inspection): `ArenaPhysics`,
`SlipperyFloor`, `ModifierDirector`, `constants`, engine-agnostic `types`.
Zero randomness inside any of them.

## 4. Network protocol (v1)

Transport: WebSocket, JSON messages (payloads are tiny; binary is a later
optimization). Client → server (30 Hz sample, heartbeat 1 Hz):

```jsonc
{ t: 'join',  room: "AB3F9K", name: "Mo" }         // or { t:'rejoin', token }
{ t: 'input', seq: 412, mx: 0.62, my: -0.31, dash: false }  // mx/my clamped
{ t: 'leave' } / { t: 'ping' }
```

Server → client:

```jsonc
{ t: 'joined', you: 3, room: "AB3F9K", token: "s3cret", players: [...] }
{ t: 'lobby',  players: [...] }                     // roster changes
{ t: 'start',  seed: 128371, roster: [...] }        // roster: id,name,color,radius,spawn
{ t: 'snap',   tick: 912, radius: 440, slippery: false,
   mod: null, players: [ { id, x, y, vx, vy, state, dashT, dashCd } ],
   events: [ { t:'hit', ... }, { t:'fall', id, by } ] }   // events attach to the tick
{ t: 'countdown', n: 2 }  { t: 'phase', p: 'playing' }
{ t: 'end', winner: 3 | null, stats: [...] }        // null = draw
{ t: 'left', reason: "..." }
```

- Quantization: x/y/vx/vy as i16 in the 1080-space (JSON numbers at v1;
  the protocol module already defines the int mapping so a binary upgrade is
  drop-in). ≈ 100 bytes/player → ~2 kB/s per client at 20 Hz with 8 players.
- Interpolation: client keeps a 100 ms buffer of snapshots, renders entities
  lerp'd between the two surrounding ticks; events play fx exactly once.
- Input model: `dash` is a request bit; the server consumes it exactly once
  (mirrors `consumeDash()`), validates cooldown, executes shared dash math.

## 5. Proposed file changes

### New
- Root `package.json` (workspaces; scripts: `dev` = concurrently server+client,
  `build`, `test`, `typecheck`).
- `shared/**` per §2 (moves + RoundEngine + protocol + rng).
- `server/**`: `index.ts`, `rooms.ts`, `match.ts`, `serverFighter.ts`,
  `tsconfig.json`, `package.json`.
- `server/test/roundEngine.test.ts` — deterministic unit tests: countdown →
  playing; slippery/bumper/shrink windows fire in order; sudden death at 75 s
  (compressed clock); scripted dash into rim → elimination + KO attribution;
  0-alive → draw; winner broadcast; `cancel()` on round end.
- `server/test/twoClients.test.ts` — **the proof requested**: spin server on
  ephemeral port, two `ws` clients join the same code → both get `joined` +
  identical `snap` streams (same tick, same roster); client A's inputs move
  A in snapshots both receive; scripted slam near the rim eliminates B →
  BOTH clients receive the same `fall` event + same winner; A disconnects and
  rejoins with token → same match state continues.
- `client/src/multiplayer/NetClient.ts` — ws lifecycle, input sampler,
  snapshot buffer/interpolation, event → gameBus dispatch.
- `client/src/multiplayer/room.ts` — `?room=` parsing, share-link builder.
- `docs/stage-2-plan.md` — this document.

### Modified (minimal, additive)
- `client/src/main.ts` — mode selection (solo vs multiplayer); NetClient wiring.
- `client/src/game/scenes/GameScene.ts` — MP read path: remote fighters driven
  by interpolated snapshots, local input sampled out; solo path untouched.
  Largest and most delicate change; gated by a mode flag.
- `client/src/game/entities/Fighter.ts` — dash math + facing update extracted
  to shared (thin local wrapper remains).
- `client/src/game/constants.ts`, `types.ts`, `physics/*`, `modifiers/*` —
  become re-export shims from `shared/` (zero call-site churn).
- `client/src/ui/UIManager.ts` + `index.html` + `styles.css` — host/join/lobby
  overlay, share button, 2–8 dynamic roster dots, reconnect banner.
- `client/vite.config.ts` — `@shared` alias + dev proxy `/ws → :8787`.
- `.github/workflows/deploy.yml` — inject `VITE_WS_URL` at build time (one env
  line). Pages job otherwise unchanged.

### Not touched
Gameplay tuning, solo/bot mode, sfx, motion, input managers, physics content,
Pages pipeline shape, no accounts/db/monetization.

## 6. Dependencies

Runtime: `ws` (server). Dev: `vitest`, `tsx`, `concurrently`, `@types/ws`,
`@types/node`. Client runtime deps unchanged (phaser only). Node ≥ 20
(matches engines; CI uses 22).

## 7. Implementation sequence (each step has a verification gate)

1. **Workspace + shared extraction** with client re-export shims.
   Gate: typecheck + build + headless smoke — behavior byte-identical.
2. **RoundEngine (shared, pure)** + seeded RNG; unit tests with virtual
   fighters and a compressed clock.
   Gate: vitest green; no server code yet.
3. **Server**: rooms/tokens/capacity, tick loop on RoundEngine, snapshots.
   Gate: `twoClients.test.ts` proves join → identical snapshots → scripted KO
   → identical winner events → disconnect/rejoin continuity.
4. **Client multiplayer path**: NetClient, room UI, GameScene MP read path.
   Gate: headless browser, two pages, same room, both move; solo smoke suite
   still green.
5. **Mobile + UX pass**: latency feel, reconnect banner, lobby on phone,
   portrait/landscape, one-handed controls unaffected.
6. **Deploy**: server to a Node host; wire `VITE_WS_URL`; two-phone E2E;
   solo Pages build unchanged.

## 8. Assumptions (NOT verified — flag before/during implementation)

1. A persistent Node host (Fly/Render/Railway free tier) is acceptable for
   running the room server; GitHub Pages alone cannot host WebSockets.
2. No-prediction latency (~RTT/2 + 100 ms) is acceptable for v1 gameplay.
3. Rooms are ephemeral (in-memory; die on restart); no DB — consistent with
   the no-accounts constraint.
4. 2–8 players means humans only at v1 (bot filler deferred).
5. Server-hosting cost/ops burden is acceptable to the user (free tier ok).
6. JSON protocol bandwidth (~2 kB/s per client at 8 players) needs no
   optimization before launch.
7. iOS Safari backgrounding will aggressively kill WebSockets → the 90 s
   rejoin grace + auto-rejoin on foreground is sufficient (needs device test).

## 9. Risks

- **GameScene MP read path** is the regression hotspot → keep it strictly
  additive, mode-gated; re-run the existing headless smoke suite after every
  touch.
- **facing/dash semantics** must stay numerically identical after extraction
  (solo feel is already tuned); unit-test the extracted function against
  current behavior.
- **View-only hitstop** in MP slightly changes game feel vs solo — accepted,
  documented.
- **Snapshot ambiguity on events** — solved by attaching events to ticks.
