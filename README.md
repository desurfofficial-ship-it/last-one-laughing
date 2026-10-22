# Last One Laughing

A mobile-first 2D browser game prototype: a knockout arena where you bump,
dash and shove three bots off a shrinking circle floor. **Last one standing
wins.** Built with **Phaser 3 + TypeScript + Vite**, no art assets —
everything is geometric shapes and synthesized sound.

![gameplay](docs/screenshot-gameplay.png)

## Status: stage 2 in progress

- Solo mode (3 bots with distinct personalities) is complete and unchanged.
- Stage 2 online multiplayer is under way: the shared authoritative
  simulation and the Node server are implemented and tested (see
  [docs/stage-2-plan.md](docs/stage-2-plan.md)); the client's multiplayer
  UI/connection layer comes next. No accounts, database, payments,
  analytics.

## Quick start

Prerequisites: **Node.js >= 20** and npm. The repo is an npm workspace with
three packages: `client/` (Phaser game), `shared/` (engine-agnostic
simulation) and `server/` (authoritative multiplayer, stage 2 in progress).

```bash
# 1. Clone
git clone https://github.com/<owner>/last-one-laughing.git
cd last-one-laughing

# 2. Install all workspaces
npm install

# 3. Run client + server together (dev)
npm run dev
#   - web client: http://localhost:5173
#   - game server: ws://localhost:8787/ws

# 4. Production client build (typecheck + bundle)
npm run build

# 5. Simulation tests (RoundEngine unit + two-client integration)
npm test

# 6. Typecheck everything
npm run typecheck
```

### Test on a real phone

1. Run `npm run dev` (or `npm run preview -- --host`) on your computer.
2. Open the **Network** URL Vite prints (e.g. `http://192.168.x.x:5173`) in
   your phone's browser — both devices must be on the same Wi-Fi.
3. The deployed GitHub Pages URL (below) is even easier: open it on the phone.

## Controls

| Action | Mobile | Desktop |
| --- | --- | --- |
| Move | touch-drag **anywhere on screen** (floating joystick, one-handed friendly) | `WASD` or arrow keys |
| Dash / slam | big DASH button (bottom right) | `Space` |
| Pause | pause icon (top right) | `P` or `Esc` |
| Play again (result screen) | button | `Enter` / `Space` |

No gameplay action requires hovering or a keyboard.

## How it plays

- 4 circular fighters (you are yellow) on a circular arena with **no walls**.
- Collisions transfer momentum; dashing into someone multiplies the knockback
  (confirmed slam connections guarantee a strong, readable shove). Get shoved
  far enough and your center crosses the rim — you fall and are out.
- **Three announced arena modifiers**, each with its own warning banner,
  sound and ring color:
  1. **Slippery floor** (yellow warn -> icy ring): every 10 s the floor warns
     for 2 s, then turns slippery for 4 s (low friction, high drift).
  2. **Bumper balls** (orange warn): two heavy balls sweep across the arena
     for 9 s, bouncing off the rim and shoving anyone they hit. Bots dodge
     them; you should too.
  3. **Shrinking arena** (red warn): the rim pulls in for 7 s, then eases
     back out. Anyone outside the rim while it pulls in falls.
- After 75 s **sudden death** begins: the arena shrinks for good so every
  round is guaranteed to end.
- Rounds open with a 3-2-1 countdown (plus one-time tutorial hints on your
  first round), and show a visible round timer; the result screen reports the
  winner, round time, your knockouts and your fastest win (stored in
  `localStorage`).
- **Reduced motion:** if your OS enables "reduce motion", camera shake is
  skipped and particle effects are halved.

![slippery warning](docs/screenshot-slippery.png)

## Project structure

```
last-one-laughing/
├── client/                  # the Phaser game (Vite + TypeScript)
│   ├── index.html           # canvas host + DOM menus/controls
│   └── src/
│       ├── main.ts          # bootstrap: Phaser game + DOM wiring
│       ├── styles.css       # menus, overlays, touch controls
│       ├── game/            # gameplay layer (no DOM access)
│       │   ├── scenes/      # GameScene: solo round flow, HUD, feedback
│       │   ├── entities/    # Fighter (view+state), BotController (AI)
│       │   └── ...          # constants/types/physics/modifiers are shims → shared/
│       ├── input/           # keyboard + touch joystick + dash button
│       └── ui/              # start/pause/result overlays + out-card (DOM)
├── shared/                  # engine-agnostic sim (no phaser/node/DOM)
│   └── src/
│       ├── constants.ts     # all tuning knobs (single source of truth)
│       ├── types.ts         # Body/Phase/HitEvent/Obstacle contracts
│       ├── physics/         # ArenaPhysics: impulses, knockback, obstacles
│       ├── modifiers/       # SlipperyFloor + ModifierDirector
│       ├── sim/             # Dash.ts + RoundEngine.ts (authoritative round)
│       ├── net/protocol.ts  # wire messages (JSON over WebSocket)
│       └── util/rng.ts      # mulberry32 seeded RNG
├── server/                  # authoritative multiplayer (stage 2)
│   ├── src/
│   │   ├── index.ts         # entry (PORT env, default 8787)
│   │   ├── app.ts           # http + /ws + static client hosting
│   │   ├── rooms.ts         # private rooms, tokens, rejoin, capacity
│   │   └── match.ts         # 30 Hz sim tick + 20 Hz snapshots
│   └── test/                # RoundEngine unit + two-client integration
├── docs/                    # screenshots + stage-2-plan.md
└── .github/workflows/       # GitHub Pages deploy (client)
```

Stage 2 status: shared simulation + authoritative server + tests are in;
the client's multiplayer UI/connection layer is the next step (see
[docs/stage-2-plan.md](docs/stage-2-plan.md)). Solo mode is unchanged.

## Architecture notes

- **Fixed logical resolution:** the game simulates a 1080x1080 world and
  Phaser's `Scale.FIT` letterboxes it, preserving the full play area on
  portrait phones, landscape phones and desktops.
- **Separation of concerns:** gameplay (Phaser scenes/entities/physics) never
  touches the DOM. Menus, overlays and touch controls are DOM, connected
  through a tiny event bus (`game/EventBus.ts`) and an input bridge
  (`input/playerInput.ts`). Bots produce the same `InputState` a networked
  player would.
- **Simulation:** fixed-timestep (120 Hz substeps) custom circle physics with
  exponential damping (natural terminal velocity), impulse collisions with a
  dash "slam" bonus and a guaranteed minimum slam knockback, kinematic
  bumper-ball obstacles, brief hitstop + camera shake on heavy hits (shake
  respects the OS reduce-motion setting).
- **Safety:** delta-time is clamped; the round auto-pauses on tab hide/window
  blur; input state clears on blur; audio is unlocked on first gesture only;
  `localStorage` access is guarded.

## Build & deploy (GitHub Pages)

A workflow at `.github/workflows/deploy.yml` installs the workspace, builds
`client/dist` (`npm run build -w client`) and deploys it to GitHub Pages on
every push to `main`. One-time setup if enabling manually: **Settings ->
Pages -> Source: GitHub Actions**. The multiplayer server is deployed
separately (any Node host; `npm run start -w server`).

The Vite `base` is `./`, so the bundle also works from any subdirectory or
static host without rewrites.

## Tuning

Every gameplay number (movement, friction, dash, knockback, slippery cycle,
sudden death, colors, names) lives in
[`client/src/game/constants.ts`](client/src/game/constants.ts).

## Roadmap

1. **Stage 2 - online multiplayer:** authoritative server reusing
   `ArenaPhysics`/`SlipperyFloor`, room management, WebSocket protocol,
   lag-compensated input.
2. Polish: bot difficulty levels, more arena modifiers, gamepad support,
   sound toggle, PWA offline mode.

## Known limitations (stage 1)

- Bots have distinct personalities (Rex aggressive, Momo balanced, Bit
  opportunistic) but only one implicit difficulty; no difficulty selector.
- Sounds are synthesized (no audio toggle - use the device volume; iOS may
  mute WebAudio when the ringer switch is off).
- Touch controls are not remappable; the floating joystick spawns wherever
  you drag (full screen) by design.
- No unit/integration test suite; verification so far = `tsc` typecheck,
  production build, and headless-browser smoke tests of the full round loop.
- Multiplayer, accounts, persistence (beyond local best time), and analytics
  are out of scope by design.

## License

[MIT](LICENSE)
