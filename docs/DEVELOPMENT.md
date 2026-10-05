# Development guide

How to work on this repo day to day.

## Prerequisites

- Node.js **26+**
- npm (workspaces; root `package-lock.json`)
- **Podman** or **Docker Engine** to launch real browsers (unit tests mock most of the container API)

## First-time setup

```bash
cd /path/to/BrowserIsolation
cp .env.example .env
# PUBLIC_IP=127.0.0.1 is fine for same-machine viewer testing
npm install
```

Create the browser network if you are not using Compose (Compose creates `rbi-browsers`):

```bash
podman network create rbi-browsers || true
# Docker Engine: docker network create rbi-browsers || true
```

Optional: pre-pull Neko images so the first launch is fast (there is no Compose `prepull` profile):

```bash
podman pull ghcr.io/m1k1o/neko/google-chrome:latest
podman pull ghcr.io/m1k1o/neko/firefox:latest
podman pull ghcr.io/m1k1o/neko/brave:latest
# Or after the portal is up: Admin → Browsers → Pull latest
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
| `npm run start:worker -w orchestrator` | Worker agent (needs enroll/`WORKER_TOKEN`) |
| `npm run docs` | Rebuild pretty HTML docs under `docs/site/` |
| `npm run docs:serve` | Rebuild + serve HTML docs on `:4173` |

Open the UI at **http://localhost:5173** during `npm run dev`. Vite proxies `/api` and `/session/*/view` → API; the SPA shell for `/session/:id` stays on Vite (see `web/vite.config.ts`).

## Environment tips

- Keep `.env` at the **repo root**. Both portal and worker load it via `env-file.ts`.
- On Alma containers, host-mounted **`/config/.env` overrides** the image/repo `.env` (see [ARCHITECTURE.md](ARCHITECTURE.md#configuration-layering)).
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
| Change branding / logo | `branding-store.ts`, `routes/branding.ts`, Admin → Settings |
| Change browser catalog | `neko-browsers.ts`, policies under `neko-policies/` |
| Change SQLite schema | `db.ts` (+ migration helpers in the same file) |
| Change Alma install / entrypoint | `deploy/podman/`, [SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md) |

## Testing

```bash
# Fast unit suite (default)
npm test

# Single file
npm test -w orchestrator -- test/auth.test.ts

# Real Podman/Docker + Neko (slow; needs images and socket)
RBI_INTEGRATION=1 npm test -w orchestrator -- test/integration.test.ts
```

Tests use Node’s built-in test runner via `tsx`. Helpers live in `orchestrator/test/helpers.ts` (in-memory DB, mock placement, etc.).

There is no automated frontend test suite yet; verify UI changes manually against `npm run dev`.

### What the important tests cover

| File | Focus |
| --- | --- |
| `config.test.ts` | Env parsing / defaults |
| `local-auth.test.ts` | Local user store |
| `session-store.test.ts` | Portal sessions |
| `auth.test.ts` | Cookies, CSRF, login/logout |
| `change-password.test.ts` | Local password change |
| `access-control.test.ts` | Session ownership vs admin |
| `browser-sessions.test.ts` | Launch / access with mocked workers |
| `geometry.test.ts` | Viewer geometry helpers |
| `admin.test.ts` / `admin-volumes.test.ts` | Admin APIs / profile volumes |
| `audit.test.ts` | Audit log |
| `lifecycle.test.ts` | Reconcile + reaper |
| `policy-tar.test.ts` | Policy injection packaging |
| `identity.test.ts` | `subjectId` / volume naming |
| `neko-browsers.test.ts` | Browser catalog |
| `settings.test.ts` | Admin overrides |
| `workers.test.ts` / `worker-auth.test.ts` | Placement, online detection, enroll auth |
| `host-metrics.test.ts` | Worker host stats |
| `saml.test.ts` | SAML helpers / profile mapping |
| `integration.test.ts` | Opt-in real container path |

## Debugging tips

**Browser won’t stream**

1. Confirm `PUBLIC_IP` is reachable from the client on the WebRTC port range (UDP **and** TCP).
2. Check orchestrator logs for container create / Neko readiness failures.
3. In the browser, inspect WebRTC ICE failures (candidates pointing at the wrong IP).
4. On Alma/Hyper-V style hosts, use `BROWSER_NETWORK_MODE=host` (installer default).

**403 `csrf_failed`**

- Mutating `/api/*` calls need `X-CSRF-Token`.
- Logged out: call `GET /api/auth/csrf` first.
- Logged in: use `csrfToken` from `GET /api/me` (the SPA does this in `api.ts`).
- Exempt: SAML ACS and `POST /api/workers/enroll`.

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
podman compose up --build
```

The Dockerfile multi-stage build runs `npm ci`, builds both workspaces, prunes dev deps, and sets **`ENTRYPOINT ["/entrypoint.sh"]`**. The entrypoint starts the portal (`dist/index.js`) by default, or the worker (`dist/worker-main.js`) when `RBI_ROLE=worker` (Compose worker profile / install-worker set this). Runtime image is `node:26-bookworm-slim`.
