# Development guide

How to work on this repo day to day.

## Prerequisites

- Node.js **26+**
- npm (workspaces; root `package-lock.json`)
- Docker Engine (required to launch real browsers; unit tests mock most of it)

## First-time setup

```bash
cd /path/to/BrowserIsolation
cp .env.example .env
# PUBLIC_IP=127.0.0.1 is fine for same-machine viewer testing
npm install
```

Create the Docker network if you are not using Compose (Compose creates `rbi-browsers`):

```bash
docker network create rbi-browsers || true
```

Optional: pre-pull Neko images so the first launch is fast:

```bash
docker compose --profile prepull pull
```

## Daily commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API on `:8080` + Vite on `:5173` |
| `npm test` | Orchestrator unit tests (`tsx --test`) |
| `npm run build` | Build web then orchestrator |
| `npm start` | Run built orchestrator (serves `web/dist` when `NODE_ENV=production`) |
| `npm run dev -w orchestrator` | API only |
| `npm run dev -w web` | UI only |
| `npm run start:worker -w orchestrator` | Worker agent (needs `WORKER_TOKEN`) |

Open the UI at **http://localhost:5173** during `npm run dev`. Vite proxies `/api` and `/session/:id/view/*` to the API; the SPA shell for `/session/:id` stays on Vite (see `web/vite.config.ts`).

## Environment tips

- Keep `.env` at the **repo root**. Both portal and worker load it via `env-file.ts`.
- `COOKIE_SECURE=false` for local HTTP.
- Set `PUBLIC_IP` to your LAN IP if you open the portal from another device.
- First boot seeds `admin` / `user` from `AUTH_USERS` only when `local_users` is empty. After that, use **Admin → Users**.

## Project map for common tasks

| You want to… | Start here |
| --- | --- |
| Add an API route | `orchestrator/src/routes/`, register in `app.ts` |
| Change launch / destroy behavior | `browser-sessions.ts`, `docker/container-runtime.ts` |
| Change ACL | `access.ts`, `proxy.ts` |
| Add admin UI page | `web/src/pages/admin/`, route in `App.tsx`, API in `api.ts` |
| Change viewer / WebRTC client | `web/src/viewer/` |
| Add config knob | `.env.example`, `config.ts`, optionally `settings-fields.ts` |
| Touch identity / profiles | `auth/identity.ts`, [USER_IDENTITY.md](USER_IDENTITY.md) |
| Touch multi-host | `workers/*`, [WORKERS.md](WORKERS.md) |
| Change browser catalog | `neko-browsers.ts`, policies under `neko-policies/` |
| Change SQLite schema | `db.ts` (+ migration helpers in the same file) |

## Testing

```bash
# Fast unit suite (default)
npm test

# Single file
npm test -w orchestrator -- test/auth.test.ts

# Real Docker + Neko (slow; needs images and socket)
RBI_INTEGRATION=1 npm test -w orchestrator -- test/integration.test.ts
```

Tests use Node’s built-in test runner via `tsx`. Helpers live in `orchestrator/test/helpers.ts` (in-memory DB, mock placement, etc.).

There is no automated frontend test suite yet; verify UI changes manually against `npm run dev`.

### What the important tests cover

| File | Focus |
| --- | --- |
| `auth.test.ts` | Cookies, CSRF, login/logout |
| `access-control.test.ts` | Session ownership vs admin |
| `browser-sessions.test.ts` | Launch / access with mocked workers |
| `lifecycle.test.ts` | Reconcile + reaper |
| `workers.test.ts` | Placement and online detection |
| `saml.test.ts` | SAML helpers / profile mapping |
| `settings.test.ts` | Admin overrides |
| `integration.test.ts` | Opt-in real container path |

## Debugging tips

**Browser won’t stream**

1. Confirm `PUBLIC_IP` is reachable from the client on the WebRTC port range (UDP **and** TCP).
2. Check orchestrator logs for container create / Neko readiness failures.
3. In the browser, inspect WebRTC ICE failures (candidates pointing at the wrong IP).

**403 `csrf_failed`**

- Mutating `/api/*` calls need `X-CSRF-Token`.
- Logged out: call `GET /api/auth/csrf` first.
- Logged in: use `csrfToken` from `GET /api/me` (the SPA does this in `api.ts`).

**Launch returns an error about ports**

- Pool exhausted → widen `WEBRTC_PORT_RANGE` and publish those ports (Compose worker service publishes `52000-52099` by default).

**Admin UI missing a feature that the API has**

- Wire `web/src/api.ts` + a page under `pages/admin/`. Admin is role-gated in both SPA and API.

## Code style

- TypeScript throughout; orchestrator compiles with `tsc`, web with Vite + `tsc --noEmit`.
- Prefer small focused modules next to existing patterns.
- Do not commit `.env`, `data/*.sqlite*`, or `node_modules` / `dist` (see `.gitignore`).
- Keep PRs scoped; match naming and error codes already used in routes (`csrf_failed`, `not_found`, …).

## Production build check

Before shipping a change that affects packaging:

```bash
npm run build
NODE_ENV=production npm start
# or
docker compose up --build
```

The Dockerfile multi-stage build runs `npm ci`, builds both workspaces, prunes dev deps, and defaults `CMD` to the portal (`dist/index.js`). Workers override the command to `dist/worker-main.js`.
