# Kilo harness check

Stage: draft · role: worker
Date: 2026-11-25

## Sprint runner

`dsh` — DeepSeek Harness headless (`dsh --profile headless --json`), one task per
process, no listening port, loopback by construction. Configured in `.env` as
`SPRINT_RUNNER=dsh`.

The runner exports the project-local harness home itself (`data/dsh-home`);
`DSH_HOME` must not be set in `.env` because dsh treats it as launch-only and
refuses to start otherwise.

- Profile: `headless`
- Harness home: `data/dsh-home`
- Cordis profile patch: `data/dsh-home/profiles/headless/cordis.patch.yml`
- Concurrency: one harness process at a time (`DSH_MAX_CONCURRENCY=1`)
- Per-step timeout: 10 h default (`DSH_STEP_TIMEOUT_MS`)
- Preview guardrail: this node's `/api/ping` is checked before and during a run;
  3 consecutive failures abort the run.

## Model route

Route `llm-pi-ai`, declared in `data/dsh-home/profiles/headless/cordis.patch.yml`,
is the sprint harness model route:

| Route | Provider | Model | Base URL | apiKeyEnv |
|---|---|---|---|---|
| `llm-pi-ai` | `kilocode` (Kilo Gateway) | `kilo-auto/free` | `https://ai-gateway.kilo.ai/api/v1` | `KILO_API_KEY` |
| `llm-pi-ai` | `ollama` (local fallback) | `computera-sprint` | `http://127.0.0.1:11434/v1` | `OLLAMA_API_KEY` |

The default agent model (`agent-default-model`) is `kilocode` / `kilo-auto/free` —
the Kilo Gateway free route, which needs no account key (`KILO_API_KEY=anonymous`
is accepted as a placeholder). The Ollama route is the fully local fallback; on
this node `SPRINT_OLLAMA_MODEL=qwen2.5-coder:1.5b` applies to the plain Ollama
sprint adapter.

Kilo's local server (`http://127.0.0.1:7777`, `KILO_URL`) is probed through
`/api/kilo/health` and `/api/kilo/models` on this node, but it exposes no
OpenAI-compatible model endpoint, so it is not itself a harness route without the
gateway key.

## Verification

```bash
dsh --version
curl -s -H "X-Fleet-Token: $FLEET_TOKEN" http://127.0.0.1:3000/api/automations/roles
curl -s http://127.0.0.1:3000/api/kilo/health
```

`/api/automations/roles` reports the active sprint runner (`dsh` when
`SPRINT_RUNNER=dsh`); `/api/kilo/health` reports whether the Kilo gateway is
reachable.

---

Date: 2026-11-25
Stage: draft · role: worker
