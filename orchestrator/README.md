# Orchestrator

Fastify control plane for Browser Isolation: authentication, SQLite state, Neko container lifecycle, session proxy, admin APIs, and optional **worker agent**.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| Dev portal | `npm run dev -w orchestrator` | `tsx watch src/index.ts` |
| Dev worker | `npm run dev:worker -w orchestrator` | Watch worker agent |
| Build | `npm run build -w orchestrator` | `tsc` → `dist/` |
| Start portal | `npm run start -w orchestrator` | `node dist/index.js` |
| Start worker | `npm run start:worker -w orchestrator` | `node dist/worker-main.js` |
| Test | `npm test -w orchestrator` | Node test runner via `tsx` |

From the repo root, `npm run dev` / `npm test` / `npm start` already target this package appropriately.

## Entry points

| File | Role |
| --- | --- |
| `src/index.ts` | Portal: wire DB, workers, reaper, listen on `PORT` |
| `src/worker-main.ts` | Agent: Docker + `/v1` on `WORKER_PORT` |
| `src/app.ts` | Fastify app factory for the portal |
| `src/worker-agent/app.ts` | Fastify app factory for the agent |

## Source layout

```text
src/
  auth/           # Local + SAML + subjectId helpers
  docker/         # dockerode runtime, labels, policies, profiles
  routes/         # Portal HTTP handlers
  workers/        # Placement, poller, remote client, port pool (memory)
  worker-agent/   # Remote host API
  *.ts            # app, config, db, lifecycle, proxy, stores, …
neko-policies/    # Policy JSON trees injected into containers
test/             # Unit + optional integration tests
```

## Key flows

**Launch** — `routes/sessions.ts` → `browser-sessions.ts` → `workers/placement.ts` → local `docker/container-runtime.ts` or remote `workers/client.ts`.

**View** — SPA calls `POST …/access`, then opens WebSocket on `/session/:id/view/ws`. `proxy.ts` checks ACL (`access.ts`), tracks viewers (`viewer-tracker.ts`), and forwards to Neko (or worker `/v1/proxy/…`).

**Cleanup** — `lifecycle.ts` reaper + destroy paths in `browser-sessions.ts`; logout also destroys.

## Config

Loaded from the **repo-root** `.env` (see `env-file.ts` + `config.ts`). Admin overrides land in SQLite via `settings-store.ts` / `settings-fields.ts`.

Worker-only env: `WORKER_ID`, `WORKER_TOKEN`, `WORKER_PORT` (see [../docs/WORKERS.md](../docs/WORKERS.md)).

## Policies

`neko-policies/<chrome|brave|firefox>/`:

- `policies.json` — default (ephemeral) sessions  
- `policies.persist.json` — when the user opted into persistent profiles  

Catalog and image names: `src/neko-browsers.ts`.

## Tests

```bash
npm test -w orchestrator
RBI_INTEGRATION=1 npm test -w orchestrator -- test/integration.test.ts
```

Prefer injecting stores/runtimes in tests (see `test/helpers.ts`) rather than hitting a live Docker daemon.

## Further reading

- [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)  
- [../docs/API.md](../docs/API.md)  
- [../docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md)  
