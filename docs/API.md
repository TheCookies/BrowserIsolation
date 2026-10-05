# API reference

Two HTTP surfaces:

1. **Portal** (orchestrator) — cookies + CSRF for browsers; used by the SPA  
2. **Worker agent** — Bearer token; used only by the orchestrator  

Base URL examples assume the portal on `http://localhost:8080`.

---

## Conventions (portal)

| Topic | Rule |
| --- | --- |
| Auth | Cookie `rbi_session` → `request.authUser` |
| CSRF | Header `X-CSRF-Token` on `POST`/`PUT`/`PATCH`/`DELETE` under `/api/*` |
| CSRF exempt | `POST /api/auth/saml/acs` only |
| Errors | JSON `{ "error": "<code>" }` with appropriate HTTP status |
| Health | `GET /api/health` → `{ "ok": true }` (no auth) |

CSRF sources:

- Logged out: `GET /api/auth/csrf` sets cookie `rbi_csrf` and returns the token  
- Logged in: token is on the portal session; also returned from `GET /api/me` as `csrfToken`

---

## Auth

| Method | Path | Auth | CSRF | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/api/auth/csrf` | No | — | Issue CSRF token |
| GET | `/api/auth/methods` | No | — | `{ local, saml, … }` for login UI |
| POST | `/api/auth/login` | No | Yes | Local login `{ username, password }` |
| GET | `/api/auth/saml/login` | No | — | Redirect to IdP |
| POST | `/api/auth/saml/acs` | No | Exempt | SAML assertion consumer |
| GET | `/saml/metadata` | No | — | SP metadata XML |
| POST | `/api/auth/logout` | Yes | Yes | End portal session; destroy browser |
| GET | `/api/me` | Yes | — | Current user + preferences + CSRF |

---

## User sessions (isolated browsers)

| Method | Path | Auth | CSRF | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/api/browsers` | Yes | — | Enabled browser catalog for the dashboard |
| GET | `/api/sessions/mine` | Yes | — | Current user’s browser session or empty |
| POST | `/api/sessions` | Yes | Yes | Launch or reconnect `{ browser }` |
| GET | `/api/sessions/:sessionId` | Yes | — | Metadata (ACL) |
| POST | `/api/sessions/:sessionId/access` | Yes | Yes | Neko creds + `wsPath` + ICE |
| DELETE | `/api/sessions/mine` | Yes | Yes | Destroy own container |

### Access response (shape)

Used by the viewer after launch or admin join:

```json
{
  "session": { "id": "…", "owner": "…", "browser": "google-chrome", "…": "…" },
  "wsPath": "/session/<id>/view/ws",
  "username": "rbi",
  "password": "<neko-admin-password>",
  "iceServers": [],
  "allowClipboard": false,
  "allowDownloads": false
}
```

WebSocket URL (same origin): `{wsPath}?username=rbi&password=…` (see `web/src/viewer/`).

---

## Preferences

| Method | Path | Auth | CSRF | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/api/preferences` | Yes | — | Persist-profile flags |
| PUT | `/api/preferences` | Yes | Yes | `{ "persistProfile": boolean }` |

Applies on the **next** launch. See [USER_IDENTITY.md](USER_IDENTITY.md).

---

## Admin

All routes require `role === "admin"`.

### Sessions & audit

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/sessions` | — | All sessions + viewer/CPU/memory where available |
| POST | `/api/admin/sessions/:sessionId/join` | Yes | Issue access (audited) |
| DELETE | `/api/admin/sessions/:sessionId` | Yes | Terminate |
| GET | `/api/admin/audit` | — | Recent audit events |

### Settings

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/settings` | — | Field definitions + current values |
| PUT | `/api/admin/settings` | Yes | Patch overrides |

### Browsers

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/browsers` | — | Full Neko catalog + enabled flags |
| PUT | `/api/admin/browsers` | Yes | Set enabled browser ids |
| POST | `/api/admin/browsers/pull` | Yes | Pull images on workers |
| POST | `/api/admin/browsers/pull/stream` | Yes | SSE stream of pull progress (admin Pull modal) |

### Users (local only)

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | — | List |
| POST | `/api/admin/users` | Yes | Create |
| PATCH | `/api/admin/users/:username` | Yes | Role / password |
| DELETE | `/api/admin/users/:username` | Yes | Delete |

SAML users are not stored in `local_users`.

### Profile volumes

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/profile-volumes` | — | Volumes across workers |
| DELETE | `/api/admin/profile-volumes` | Yes | Body: `workerId`, `volumeName` |

### Workers

| Method | Path | CSRF | Purpose |
| --- | --- | --- | --- |
| GET | `/api/admin/workers` | — | Registry + online state |
| POST | `/api/admin/workers` | Yes | Register remote worker |
| PATCH | `/api/admin/workers/:workerId` | Yes | Enable / disable |
| DELETE | `/api/admin/workers/:workerId` | Yes | Remove remote |
| GET | `/api/admin/workers/:workerId/status` | — | Host metrics |

---

## Session proxy (not under `/api`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| ALL | `/session/:sessionId/view` | Portal cookie + ACL | Proxy to Neko root |
| ALL | `/session/:sessionId/view/*` | Portal cookie + ACL | Proxy; prefix stripped |
| WebSocket | `/session/:sessionId/view/…` | Cookie + ACL | Signaling; counts viewers |

Remote workers: orchestrator forwards to `http://worker/v1/proxy/:containerId/…` with `Authorization: Bearer`.

---

## Worker agent (`/v1`)

Default listen: `WORKER_PORT=8090`.  
Auth: `Authorization: Bearer <WORKER_TOKEN>` except health.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | No | `{ ok, id }` |
| GET | `/v1/status` | Yes | Sessions, `publicIp`, port range |
| GET | `/v1/host` | Yes | CPU / memory / disk / network |
| GET | `/v1/volumes` | Yes | Profile volumes |
| DELETE | `/v1/volumes/:volumeName` | Yes | Delete volume |
| GET | `/v1/browsers` | Yes | Managed containers |
| POST | `/v1/browsers` | Yes | Create Neko container |
| GET | `/v1/browsers/:containerId` | Yes | Inspect |
| GET | `/v1/browsers/:containerId/stats` | Yes | Stats |
| GET | `/v1/browsers/:containerId/logs` | Yes | Logs (`?tail=`) |
| DELETE | `/v1/browsers/:containerId` | Yes | Remove |
| POST | `/v1/images/pull` | Yes | `{ images: string[] }` |
| ALL | `/v1/proxy/:containerId` | Yes | Proxy to Neko `:8080` |
| ALL | `/v1/proxy/:containerId/*` | Yes | Same |

Do **not** expose the agent port to the public internet.

---

## SPA routes (frontend)

| Path | Who | Page |
| --- | --- | --- |
| `/login` | Anonymous | Login |
| `/` | User | Dashboard / launch |
| `/session/:sessionId` | User / admin | Viewer |
| `/admin/sessions` | Admin | Live sessions |
| `/admin/workers` | Admin | Workers |
| `/admin/storage` | Admin | Profile volumes |
| `/admin/users` | Admin | Local users |
| `/admin/browsers` | Admin | Catalog |
| `/admin/settings` | Admin | Settings |
| `/admin/audit` | Admin | Audit log |

---

## Source of truth

Route registration: `orchestrator/src/app.ts`  
Handlers: `orchestrator/src/routes/*.ts`, `proxy.ts`, `worker-agent/app.ts`  
Client: `web/src/api.ts`
