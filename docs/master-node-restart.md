# Master node restart runbook

Produced by sprint `edeefe69` on task "Write the master node restart runbook",
then reviewed and corrected against this repository.

## 1. Stop the node listening on port 3000

Find the PID, then stop that process tree:

```bash
netstat -ano | grep -E ':3000 .*LISTENING'
cmd //c "taskkill /PID <pid> /T /F"
```

## 2. Start it from the project folder with `.env` loaded

```bash
cd /c/Users/molel/computera-ops
set -a; . ./.env; set +a
NODE_ROLE=master node server.js >> logs/server-master.log 2>&1 &
```

`.env` holds `PORT`, `FLEET_TOKEN`, `PUBLIC_MODE`, `PUBLIC_URL`, the share settings
and `SPRINT_RUNNER`. `DSH_HOME` must not be in it; the runner exports the harness
home itself.

## 3. Start the tunnel

```bash
npm run tunnel
```

It waits for the quick-tunnel hostname, then rewrites `PUBLIC_URL` in `.env` and
`data/tunnel.json`. Start the tunnel **before** the node, because the node reads
`PUBLIC_URL` at boot.

## 4. Verify the node answers

```bash
curl -s http://127.0.0.1:3000/api/ping
curl -s -H "X-Fleet-Token: $FLEET_TOKEN" http://127.0.0.1:3000/api/fleet/workers
```

`/api/ping` is liveness only; `/api/fleet/workers` also reports today's host and
the roster.

## 5. Rotate today's link token

```bash
curl -s -X POST -H "X-Fleet-Token: $FLEET_TOKEN" http://127.0.0.1:3000/api/fleet/rotate
```

The response carries the new `link` (`<host>/dashboard?t=<token>`). Anyone with the
previous link must use the new one.

## 6. Join a worker

On the worker machine, create `.env`:

```
NODE_ROLE=worker
MASTER_URL=<master public or LAN URL>
FLEET_TOKEN=<same shared secret>
PUBLIC_URL=<this worker's reachable URL>
OLLAMA_URL=http://127.0.0.1:11434
KILO_URL=http://127.0.0.1:7777
```

then `npm install && npm start`. A worker without `PUBLIC_URL` registers as
`relay_only` and receives no dispatched tasks.

## After a restart

- `logs/server-master.log` should show `Fleet master as master: kilo + ollama`.
- `/api/automations/roles` reports the active sprint runner.
- Sprints left mid-step are re-queued at boot from their checkpoint.
