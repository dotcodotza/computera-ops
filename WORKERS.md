# Workers — How to Connect

## What this is
Computera Ops runs as a fleet: one **master** node owns the workspace (`data/app.db`) and hosts the calendar; other PCs act as **workers** that contribute compute (Kilo and/or Ollama). Workers advertise their capabilities and the master dispatches tasks to a node that can actually run them.

## Requirements on a worker PC
- Node.js installed
- This repo cloned (`git clone https://github.com/dotcodotza/computera-ops`)
- `npm install`
- Kilo and/or Ollama installed and running (optional, but a worker with neither only relays)

## Environment (.env or shell)
```
NODE_ROLE=worker
MASTER_URL=http://<master-lan-ip>:3000   # or the Cloudflare tunnel URL for internet workers
# (PORT must match the port the tunnel fronts — `npm run tunnel` reads PORT)
FLEET_TOKEN=<same token as master, if set>
KILO_URL=http://127.0.0.1:7777
OLLAMA_URL=http://127.0.0.1:11434
```

## Start
```
npm start
```
The worker probes its own engines at boot, joins the roster, and heartbeats. It appears in the master dashboard under Fleet.

## Capabilities
- `kilo` — worker advertises Kilo
- `ollama` — worker advertises Ollama (with model list)
- `any` — least-loaded online worker with either

## Management
- Master dashboard: `/dashboard` shows workers, heartbeats, dispatch.
- `GET /api/fleet/workers`, `POST /api/fleet/dispatch/:taskId`.
- If a worker misses heartbeats, master promotes another node.

## Remote engines through the master
`POST/GET /proxy/kilo/*` and `/proxy/ollama/*` on the master forward to that
node's engines without opening 7777/11434 to the internet.

- Both routes require `X-Fleet-Token: $FLEET_TOKEN` when a token is configured;
  without a token they only accept loopback requests, so a public tunnel can
  never be used as an open relay.
- Request and response bodies are streamed (SSE/NDJSON pass through unbuffered).
- Failures answer 502 and a timeout answers 504, so callers can retry instead of
  hanging.

```bash
curl -H "X-Fleet-Token: $FLEET_TOKEN" https://<master>/proxy/kilo/global/health
curl -H "X-Fleet-Token: $FLEET_TOKEN" https://<master>/proxy/ollama/api/tags
```

## Tunnels
`npm run tunnel` starts a Cloudflare quick tunnel against `PORT` and writes the
resulting URL into `PUBLIC_URL`, which is what the daily link and the roster
advertise. Quick-tunnel hostnames change every time; for a stable address create
a named tunnel (`cloudflared tunnel create ops`, then point its config at
`http://127.0.0.1:<PORT>`) and set `PUBLIC_URL` to that hostname by hand.

## Troubleshooting
- Ensure `MASTER_URL` reachable (firewall/LAN/tunnel).
- Match `FLEET_TOKEN` exactly.
- Kilo/Ollama must listen on the configured ports.
- Check `GET /api/health` (engines, tunnel, active Kilo runs) and
  `GET /api/metrics` (worker circuit state, request/error counts).
- A worker that keeps failing enters a cooldown and is skipped until it expires;
  `fleet_events` records `circuit_open` / `dispatch_skipped`.
