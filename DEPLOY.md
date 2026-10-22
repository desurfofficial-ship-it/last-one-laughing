# Deploy & Operations

Production shape: **two deployments**.

| Piece | Host | Why |
|---|---|---|
| Frontend (static Phaser build) | **GitHub Pages** (free) | Pure static files; already wired via `.github/workflows/deploy.yml` |
| Multiplayer server (Colyseus, WebSockets) | **Render** web service (free tier) | Persistent Node.js process + WebSocket upgrades + managed TLS, no credit card |

The server also serves the client build (single origin). That means you can play at the Render URL even before/without Pages, and Pages only exists to give the game a stable, free, always-on frontend URL.

---

## 1. Platform choice — verified before committing

Requirements: WebSocket upgrades, persistent connections, Node.js ≥ 22 runtime, HTTPS/WSS, free tier.

- **Render Web Services** — verified against render.com/docs (2026-10):
  - "Render web services can accept inbound WebSocket connections from the public internet" — <https://render.com/docs/websocket>
  - Node.js runtimes with git-push deploys, bind to `$PORT`, managed TLS — <https://render.com/docs/web-services>
  - Free tier: 750 free instance hours/workspace/month, 512 MB RAM, no credit card, custom domains, env vars — <https://render.com/docs/free>
  - **Limit that matters:** free services **spin down after 15 minutes of inactivity; spin-up ≈ 1 minute**. The first player back pays the cold start. The client covers this: joins retry for ~1 minute and the lobby shows "Waking the server…". `/health` is a cheap probe — set an uptime monitor on it if you want to keep the service warm (this burns free hours: 24×31 = 744 h ≈ the whole monthly allowance, so choose warm-vs-sleep deliberately).
- **Fly.io (alternative, Dockerfile + `fly.toml` in repo)** — no ongoing free tier for new accounts (usage-based, card required). A `shared-cpu-1x` 256 MB machine with `auto_stop_machines = "suspend"` costs roughly $2–3/month at light usage plus bandwidth; verify current numbers at <https://fly.io/pricing/>. Machines auto-start on request (1–2 s boot) and support WebSockets natively.
- **Rejected:** GitHub Pages (static only — no server process), Vercel/Netlify functions (serverless, no persistent WebSocket connections), Cloudflare Workers free (10 ms CPU limit, V8 isolates, no Node process).

## 2. Deploy the server (Render, free)

1. Push `main` to GitHub.
2. Render dashboard → **New → Blueprint** → select this repo. Render reads `render.yaml` (service, build/start commands, `/health` check, env vars).
3. First deploy builds the client and starts the server. Your URL: `https://<service-name>.onrender.com` (visible on the service page).
4. Verify: `curl https://<your-service>.onrender.com/health` → `{"ok":true,...}`.

Rollback (Render): service page → **Events** → pick the earlier deploy → **Rollback**. Blueprints re-apply on the next sync, so also revert the commit if the change is in `render.yaml`.

## 3. Wire the Pages frontend to the server

The Pages build reads the repo **Actions variable** `VITE_MP_ENDPOINT` (baked at build time — `client/src/multiplayer/NetClient.ts` upgrades it to `https`/wss automatically on HTTPS pages):

```bash
# One-time after you know the Render URL (needs a repo admin token):
curl -X POST \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/desurfofficial-ship-it/last-one-laughing/actions/variables \
  -d '{"name":"VITE_MP_ENDPOINT","value":"https://<your-service>.onrender.com"}'

# Then re-run the Pages workflow (Actions → Deploy to GitHub Pages → Run workflow).
```

Until the variable is set, the Pages build shows the clean "Multiplayer is not configured." state instead of failing joins. The `https://` endpoint is mandatory on Pages (mixed-content `ws://` is blocked by browsers; `NetClient.ts` upgrades `http://` endpoints to `https://` defensively).

Rollback (Pages): Actions → pick the previous successful **Deploy to GitHub Pages** run → **Re-run all jobs**, or redeploy an older commit.

## 4. Custom domains

- **Pages:** repo Settings → Pages → Custom domain (DNS: `CNAME <user>.github.io`). HTTPS is issued automatically (Enforce HTTPS).
- **Render:** service → Settings → Custom Domains (free tier includes 2). Point a `CNAME` at the Render URL; TLS is managed. Update `VITE_MP_ENDPOINT` to the new URL and re-run the Pages workflow.

## 5. Environment variables

Server (all optional, no secrets needed — no accounts, no persistence):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port (Render/Fly inject their own; do not hardcode) |
| `NODE_ENV` | — | `production` disables dev CORS + verbose startup info |
| `LOL_CLIENT_DIST` | `../../client/dist` | Static client build to serve (single-origin mode) |
| `LOL_ALLOWED_ORIGIN` | dev-only localhost list | Comma-separated origins allowed to matchmake cross-origin (Pages calling a separate server does NOT need this — the Pages build talks to the server origin directly) |
| `LOL_TEST` | `0` | `1` enables the debug `place` verb. **Keep 0 in production.** |

Client (build-time):

| Var | Meaning |
|---|---|
| `VITE_MP_ENDPOINT` | Server base URL (`https://…`). Empty on `*.github.io` → "not configured" state. Same-origin builds need nothing. |

Secrets: none exist. Never put tokens into `VITE_*` vars — everything prefixed `VITE_` ships to the browser.

## 6. Health & logs

- `GET /health` → `{ok, uptime_s, rooms, players, matches, node}` (counts cached 3 s). Use as the Render health check / uptime monitor probe.
- Logs (stdout, host log viewer): room create/dispose, player join/leave/drop/reconnect, match start (seed + fighter count), graceful shutdown, `uncaughtException`/`unhandledRejection` (process exits so the host restarts it). **No secrets, no tokens, no IPs, no headers are logged — there are none to log.**

## 7. Free-tier limits & possible costs (identified, not assumed)

| Platform | Free allowance | Hard limits | When it costs money |
|---|---|---|---|
| GitHub Pages | Unlimited public static hosting | 100 GB soft bandwidth/mo, 10k builds/mo, static only | Custom domain + TLS are free; no paid tier needed here |
| Render (free web service) | 750 instance-h/workspace/mo | 512 MB RAM; **sleeps after 15 min idle; ~1 min wake**; suspends when hours exhausted | Removing sleep = Starter plan ($7/mo ≈ list price; verify at render.com/pricing) |
| Fly.io | Trial credits only (new accounts) | Card required | ~$2–3/mo for one suspended-on-idle 256 MB machine + bandwidth (verify at fly.io/pricing) |

Realistic monthly bill for this game as configured: **$0** (Pages + Render free), accepting the ~1-minute first-connection wake after idle periods.

## 8. Two-device test over the internet

1. Deploy the server (§2) and note the URL.
2. Open `https://<your-service>.onrender.com/` on device A → **Play online** → create room → copy the invite link.
3. Open the link (it contains `?room=CODE`) on device B → join → both ready → host starts.
4. Play a full round; verify KOs, reconnection (toggle airplane mode ~5 s on B: banner "Reconnecting…", seat held ~90 s), and the winner screen on both devices.
5. If you use Pages: repeat at the Pages URL after §3.

Local verification (already automated in this repo, distinct from the above): `npm run build && npm run start`, two desktop browsers at `http://localhost:8787`, same flow over `ws://localhost:8787`.
