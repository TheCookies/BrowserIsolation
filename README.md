# Browser Isolation

Self-hosted **remote browser isolation (RBI)**. Users sign in to a portal, launch an isolated browser in a container (Podman or Docker), and interact with it through a custom WebRTC viewer in their own browser. Malicious pages stay inside the container; the user’s machine only sees a stream.

This repo is an npm workspaces monorepo:

| Package | Path | Role |
| --- | --- | --- |
| **orchestrator** | [`orchestrator/`](orchestrator/) | Fastify API, auth, SQLite, Docker lifecycle, session proxy, optional worker agent |
| **web** | [`web/`](web/) | React SPA (dashboard, viewer, admin) |

Isolated browsers are [Neko](https://neko.m1k1o.net/) containers (`ghcr.io/m1k1o/neko/*`).

Runtime: **Node.js 26+** (Docker image `node:26-bookworm-slim`).

---

## New here? Start with this

1. **[Quick start](#quick-start)** — get a stack running in minutes  
2. **Pretty HTML docs** — open [`docs/site/index.html`](docs/site/index.html) in a browser, or run `npm run docs:serve`  
3. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit together (roles, data flow, config)  
4. **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — local loop, tests, where to change code  
5. **[docs/API.md](docs/API.md)** — HTTP/WebSocket surface  
6. **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — production, TLS, firewall, multi-host  
7. **[docs/SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md)** — Alma blank-box install (GHCR + install scripts)  
8. **[docs/PLAN.md](docs/PLAN.md)** — what is built and what is next  

Full markdown index: **[docs/README.md](docs/README.md)**. Regenerate the HTML site after doc edits with `npm run docs`.

---

## What you get

- Local username/password auth (SQLite), with optional **SAML 2.0** SSO  
- One isolated browser session per user (Chrome, Firefox, Brave, and the rest of the Neko catalog)  
- Custom WebRTC viewer (signaling proxied through the portal; media to the host mux ports)  
- Admin: join/terminate sessions, users, browsers, settings, branding, profile volumes, workers, audit log  
- Idle reaper + max session lifetime; restart reconciliation of containers vs SQLite  
- Optional **multi-host workers** (self-enroll + Authorize) so browsers run on edge machines while one portal stays the control plane  
- Optional **persistent profiles** keyed by stable `subjectId` — see [docs/USER_IDENTITY.md](docs/USER_IDENTITY.md)

---

## Prerequisites

- **Podman** (recommended) with Compose, or **Docker** + Compose v2  
- Or **Node.js 26+** for local development and unit tests  
- Container engine socket access for the orchestrator (Compose mounts the Podman/Docker API socket)

Production remote hosts (Alma Linux step-by-step): **[docs/SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md)**.

---

## Quick start

```bash
cp .env.example .env
# Set PUBLIC_IP to this host's LAN or public address before launching browsers
# from other machines. Use 127.0.0.1 only for same-host testing.

podman compose up --build
# Docker Engine: CONTAINER_SOCKET=/var/run/docker.sock docker compose up --build
```

Open **http://localhost:8080**.

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin` | admin |
| `user` | `user` | user |

Sign in → pick a browser → **Launch**. The orchestrator starts a Neko container on the `rbi-browsers` network and proxies `/session/:id/view/*` after an ownership check (admins may open any session).

**Disconnect** on a session destroys your container. Portal **Log out** does the same. Admins use **Admin** to list sessions, **Join**, or **Terminate**; those actions are audited.

Alma production default password (install script) is different — see [SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md).

---

## Local development

```bash
npm install
npm test
npm run dev
```

| Process | Port | Notes |
| --- | --- | --- |
| API (`orchestrator`) | `8080` | Needs Podman/Docker for real launches |
| Vite UI (`web`) | `5173` | Proxies `/api` and `/session/*/view` → API |

Production-style single process (API serves built UI):

```bash
npm run build
NODE_ENV=production npm start
```

Details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Repository layout

```text
BrowserIsolation/
├── orchestrator/          # API, Docker runtime, worker agent, tests
│   ├── src/
│   ├── test/
│   └── neko-policies/     # Managed browser policies injected into Neko
├── web/                   # React + Vite SPA + WebRTC viewer
├── docs/                  # Architecture, API, deploy, plans
├── deploy/podman/         # Alma install scripts, entrypoint, optional Quadlet
├── data/                  # Local SQLite (gitignored)
├── docker-compose.yml
├── Dockerfile             # node:26 multi-stage; ENTRYPOINT entrypoint.sh
├── .env.example           # Every config knob documented here
└── package.json           # npm workspaces root (engines.node >=26)
```

---

## Configuration

Every variable is documented in [`.env.example`](.env.example).

Most operational settings can also be changed in **Admin → Settings** (stored in SQLite and layered on top of `.env`). Infrastructure keys such as `PORT`, `DATABASE_PATH`, `DOCKER_SOCKET`, `BROWSER_NETWORK`, `BROWSER_NETWORK_MODE`, and `WEBRTC_PORT_RANGE` stay read-only.

On Alma, the host file `/etc/browser-isolation/.env` is mounted at `/config/.env` and **wins** over any image defaults.

**Must-set for real use**

| Variable | Why |
| --- | --- |
| `PUBLIC_IP` | Advertised in WebRTC ICE candidates; clients must reach this address |
| `COOKIE_SECURE` / `TRUST_PROXY` | `true` behind HTTPS reverse proxy |
| `WORKER_ENROLL_TOKEN` | Shared enroll + agent Bearer when using remote browser hosts |
| `WORKER_TOKEN` / `WORKERS` | Legacy fallback only |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for firewall ports, TLS, TURN, and multi-host.

---

## Multi-host workers

One portal schedules Neko containers onto the local engine and/or remote **worker agents**. Signaling stays on the portal; WebRTC media goes to the worker’s `PUBLIC_IP`.

Guide: **[docs/WORKERS.md](docs/WORKERS.md)**. Alma install: **[docs/SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md)** · **[deploy/podman/README.md](deploy/podman/README.md)**.

```bash
# On a browser host:
sudo bash deploy/podman/install-worker.sh
# Then Admin → Workers → Authorize

# Lab / Compose alternative:
podman compose --profile worker up -d worker
```

---

## Docs map

| Doc | Contents |
| --- | --- |
| [docs/site/index.html](docs/site/index.html) | Pretty HTML docs (run `npm run docs:serve`) |
| [docs/README.md](docs/README.md) | Index of all documentation |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, roles, data flow, modules |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev setup, tests, coding map |
| [docs/API.md](docs/API.md) | Portal + worker HTTP APIs |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Compose, TLS, firewall, ops |
| [docs/SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md) | Alma blank-box GHCR deploy |
| [docs/PODMAN.md](docs/PODMAN.md) | GHCR publish + Podman reference |
| [deploy/podman/README.md](deploy/podman/README.md) | Install script index |
| [docs/WORKERS.md](docs/WORKERS.md) | Multi-host placement + enroll |
| [docs/USER_IDENTITY.md](docs/USER_IDENTITY.md) | `subjectId`, profiles, SAML |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and hardening |
| [docs/PLAN.md](docs/PLAN.md) | Product phases and roadmap |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [orchestrator/README.md](orchestrator/README.md) | Backend package guide |
| [web/README.md](web/README.md) | Frontend package guide |

---

## License / attribution

The WebRTC viewer includes Guacamole keyboard mapping under Apache 2.0 — see `web/src/viewer/LICENSE-APACHE-2.0` and `NOTICE`. Neko images are upstream projects; follow their licenses when redistributing.
