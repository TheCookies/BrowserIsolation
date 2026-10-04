# Architecture

Browser Isolation is a **control plane** (portal + orchestrator) that starts **data-plane** Neko containers and streams their desktops to users over WebRTC.

```text
┌─────────────┐     HTTPS / WSS      ┌──────────────────┐
│ User browser│─────────────────────▶│  Orchestrator    │
│  (web SPA)  │                      │  + static UI     │
└──────┬──────┘                      │  SQLite, auth    │
       │                             └────────┬─────────┘
       │ WebRTC media                         │ Docker API
       │ (UDP/TCP mux ports)                  │ or worker /v1
       ▼                                      ▼
┌─────────────┐                      ┌──────────────────┐
│ PUBLIC_IP   │◀── ICE candidates ───│ Neko container    │
│ :52000+     │                      │ (Chrome/Firefox…)│
└─────────────┘                      └──────────────────┘
```

Signaling and the portal stay on the orchestrator. **Media** goes peer-to-peer (or via TURN) to the host that runs the container.

---

## Packages

### Orchestrator (`orchestrator/`)

Node 22 + **Fastify** service that:

- Authenticates users (local bcrypt and optional SAML)
- Stores portal sessions, browser sessions, settings, workers, audit in **SQLite** (`better-sqlite3`)
- Creates/destroys Neko containers via **dockerode** (local) or remote **worker agents**
- Reverse-proxies `/session/:id/view/*` (HTTP + WebSocket) to Neko after ACL checks
- Runs a background **reaper** and, on boot, **reconciles** DB rows with labeled containers
- Optionally runs as a **worker agent** (`worker-main.ts`) exposing `/v1/*`

Entry: `src/index.ts` (portal) · `src/worker-main.ts` (agent).

### Web (`web/`)

React 19 + Vite SPA:

- Login / dashboard / session viewer / admin console
- Typed API client (`api.ts`) with CSRF headers
- Custom Neko WebRTC client under `viewer/`

In production the orchestrator serves `web/dist`. In development Vite proxies API and view traffic to `:8080`.

### Neko containers

Official images `ghcr.io/m1k1o/neko/<browser>:<tag>`. Each session gets:

- A Docker container on network `rbi-browsers` (default)
- One host **WebRTC mux port** (UDP + TCP) from `WEBRTC_PORT_RANGE`
- Injected managed policies from `orchestrator/neko-policies/`
- Optional named volume for a persistent browser profile

---

## Request path: login → stream → disconnect

```mermaid
sequenceDiagram
  participant U as User
  participant SPA as web SPA
  participant O as Orchestrator
  participant W as Worker / local Docker
  participant N as Neko

  U->>SPA: Credentials or SSO
  SPA->>O: POST /api/auth/login (or SAML ACS)
  O-->>SPA: Set-Cookie rbi_session

  U->>SPA: Launch browser
  SPA->>O: POST /api/sessions + CSRF
  O->>W: Create container + allocate port
  W->>N: Start Neko
  O-->>SPA: session id

  SPA->>O: POST /api/sessions/:id/access
  O-->>SPA: wsPath, Neko password, ICE servers
  SPA->>O: WSS /session/:id/view/ws
  O->>N: Proxied WebSocket
  Note over SPA,N: WebRTC media to PUBLIC_IP:webrtcPort

  U->>SPA: Disconnect
  SPA->>O: DELETE /api/sessions/mine
  O->>W: Remove container
```

Important invariants:

1. **One browser session per portal user** (`browser_sessions.owner_username` UNIQUE). Launch reconnects if the container is still up.
2. **ACL**: owner or admin (`access.ts`). Proxy uses the portal cookie, not CSRF.
3. **Viewer credentials** are Neko admin password + display name `rbi`, not the portal password.
4. **Logout** destroys the user’s browser container.

---

## Module map (orchestrator)

| Area | Files | Responsibility |
| --- | --- | --- |
| Bootstrap | `index.ts`, `config.ts`, `env-file.ts`, `db.ts` | Load `.env`, open SQLite, wire services |
| HTTP app | `app.ts`, `routes/*`, `proxy.ts` | Cookies, CSRF, routes, static SPA, Neko proxy |
| Auth | `auth/*` | Local users, SAML, `subjectId` / profile keys |
| Browser sessions | `browser-sessions.ts`, `browser-session-store.ts` | Launch, access, destroy |
| Docker | `docker/*` | Runtime, labels, policies, profile paths, security |
| Lifecycle | `lifecycle.ts`, `viewer-tracker.ts` | Reconcile, idle/max-age reaper |
| Workers | `workers/*`, `worker-agent/app.ts` | Placement, poller, remote client, agent API |
| Admin data | `settings-store.ts`, `audit-store.ts`, `user-preferences.ts` | Overrides, audit, persist flag |

---

## Module map (web)

| Area | Files | Responsibility |
| --- | --- | --- |
| Shell | `App.tsx`, `main.tsx`, `Shell.tsx` | Routes and session bootstrap |
| Pages | `pages/*` | Login, dashboard, session, admin tabs |
| API | `api.ts` | Fetch + CSRF + types |
| Viewer | `viewer/*` | WebRTC, signaling, keyboard, geometry |
| Files | `SessionFiles.tsx` | Optional Neko file transfer UI |

Admin routes under `/admin/*` require `me.role === "admin"` in the SPA; the API enforces the same.

---

## Data model (SQLite)

File: `DATABASE_PATH` (Compose: `/data/rbi.sqlite` on volume `rbi-data`).

| Table | Purpose |
| --- | --- |
| `portal_sessions` | Logged-in cookie sessions + CSRF token |
| `local_users` | Bcrypt accounts (seeded once from `AUTH_USERS`) |
| `user_preferences` | Persist-profile flag per `subject_id` |
| `app_settings` | Admin overrides of env-backed config |
| `browser_sessions` | Active isolated browsers (container ids, ports, Neko secrets) |
| `workers` | Local + remote worker registry |
| `profile_placements` | Sticky worker for persistent profiles |
| `audit_events` | Admin/user action log |

Schema and migrations: `orchestrator/src/db.ts`.

---

## Docker conventions

| Kind | Convention |
| --- | --- |
| Network | `BROWSER_NETWORK` (default `rbi-browsers`) |
| Container name | `rbi-{first 12 chars of session id}` |
| Labels | `rbi.managed=true`, `rbi.owner`, `rbi.session`, `rbi.browser`, `rbi.webrtc_port` |
| Profile volume | `rbi-profile-{32-hex}-{browserId}` + matching labels |
| Neko HTTP | Port `8080` on the browser network (proxied, not published to clients) |
| WebRTC | Host-published mux port per session |

On orchestrator start, containers with `rbi.managed=true` are reconciled against `browser_sessions`.

---

## Auth and security model

| Mechanism | Behavior |
| --- | --- |
| Portal cookie | `rbi_session`, httpOnly, SameSite=Lax, optional Secure |
| CSRF | Header `X-CSRF-Token` on mutating `/api/*` (SAML ACS exempt) |
| Roles | `user` \| `admin` — admin is the **role**, not the username string |
| Browser ACL | Owner or admin |
| Clipboard / downloads | Gated by `ALLOW_CLIPBOARD` / `ALLOW_DOWNLOADS` |
| Headers | CSP, `X-Frame-Options`, `nosniff`, `no-store` on API |

Identity ownership for profiles uses `subjectId` (`local:…` or `saml:…`). See [USER_IDENTITY.md](USER_IDENTITY.md).

---

## Workers and placement

- Default: orchestrator is also worker id `local` (`LOCAL_WORKER_ENABLED=true`).
- Remote agents: Bearer-authenticated `/v1/*` on `WORKER_PORT` (default 8090).
- Scheduler picks the online enabled worker with the lowest `activeSessions` (sticky id tie-break).
- Persistent profiles prefer the worker recorded in `profile_placements`.

Details: [WORKERS.md](WORKERS.md).

---

## Session lifecycle

| Phase | Behavior |
| --- | --- |
| Create | Place → allocate WebRTC port → create container → insert row |
| Activity | Proxy / access updates `last_activity_at`; connected viewers counted in memory |
| Idle reaper | No viewers + idle ≥ `IDLE_TIMEOUT_MINUTES` → destroy |
| Max age | Age ≥ `MAX_SESSION_HOURS` → destroy |
| Reconcile | Boot: adopt matches, drop stale rows, remove orphan managed containers |
| Destroy | Remove container via placement; delete SQLite row |

Implementation: `lifecycle.ts`, `browser-sessions.ts`.

---

## Configuration layering

```text
.env / process env  →  loadConfig()  →  Config object
                              ↑
                     app_settings (SQLite) hydrated on top
                     via settings-store (Admin → Settings)
```

Editable fields are declared in `settings-fields.ts`. Some keys are intentionally not overridable from the UI (bind address, DB path, Docker socket, network name, WebRTC port range).

---

## Related docs

- [DEVELOPMENT.md](DEVELOPMENT.md) — where to change code day to day  
- [API.md](API.md) — route inventory  
- [DEPLOYMENT.md](DEPLOYMENT.md) — how this maps to hosts and networks  
- [PLAN.md](PLAN.md) — product phases  
