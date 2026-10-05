# Multi-host browser workers

The portal (orchestrator) schedules isolated browser containers onto one or more **worker** hosts so load is not stuck on a single machine.

## Roles

| Role | Runs | Needs |
| --- | --- | --- |
| Orchestrator | Portal UI, auth, SQLite, session proxy | Reachability to each worker agent URL |
| Worker | Podman/Docker + Neko containers + WebRTC ports | Client-reachable `PUBLIC_IP` and open `WEBRTC_PORT_RANGE` |

Single-node installs keep `LOCAL_WORKER_ENABLED=true` (default): the orchestrator is also worker `local`.

## Networking model

```text
User browser --HTTPS--> Orchestrator --HTTP/WS--> Worker agent --HTTP/WS--> Neko container
User browser --WebRTC UDP/TCP--> Worker PUBLIC_IP:webrtcPort
```

- Signaling and `/session/*/view` stay on the portal (cookie ACL).  
- Media goes directly to the worker that owns the session.  
- Do **not** expose the worker agent port to the public internet; restrict it to the orchestrator (or a private management network).

## Worker agent

| Item | Value |
| --- | --- |
| Entry | `orchestrator` → `npm run start:worker` / Compose profile `worker` |
| Listen | `WORKER_PORT` (default `8090`) |
| Auth | `Authorization: Bearer <WORKER_TOKEN>` on `/v1/*` except `/v1/health` |

Required env on each browser host:

| Variable | Purpose |
| --- | --- |
| `WORKER_TOKEN` | Shared secret with the orchestrator |
| `WORKER_ID` | Stable id shown in Admin (e.g. `edge-1`) |
| `PUBLIC_IP` | ICE / NAT1TO1 address clients use for WebRTC to **this** host |
| `WEBRTC_PORT_RANGE` | Mux ports published on this host |
| Docker socket | Create/destroy Neko containers |
| `neko-policies` | Compose mounts the repo policies directory read-only |

Agent implementation: `orchestrator/src/worker-main.ts` + `worker-agent/app.ts`.  
API inventory: [API.md](API.md#worker-agent-v1).

## Compose on a browser host

Prefer Quadlet on production hosts: [PODMAN.md](PODMAN.md) Part C.

```bash
# In .env on that host:
WORKER_ID=edge1
WORKER_TOKEN=replace-me-with-a-long-secret
PUBLIC_IP=10.0.0.5          # client-reachable
WORKER_PORT=8090
WEBRTC_PORT_RANGE=52000-52099
# Align published ports in docker-compose.yml if you change the range

podman compose --profile worker up -d worker
# Docker: CONTAINER_SOCKET=/var/run/docker.sock docker compose --profile worker up -d worker
```

The `worker` service publishes `52000-52099` UDP+TCP by default. Edit the Compose port mappings if your range differs.

## Self-enrollment (recommended)

On a new Alma/RHEL worker host, run the bootstrap script. It asks **only** for the orchestrator host/IP, then installs Podman, logs into GHCR, pulls images, starts the worker agent, and registers itself as **Pending**.

```bash
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
# Prompt: Orchestrator host or URL  →  e.g. 10.0.0.2  or  http://rbi.example.com:8080
```

Orchestrator requirement: set the same enroll secret as the script:

```bash
WORKER_ENROLL_TOKEN=rbi_enroll_k9m2Vx7Qp4Hs8nWc3YfL6tZa1Bd0EgR5
```

(Fresh installs via `deploy/podman/install.sh` / first-boot entrypoint already include this value.)

That same value is the **worker agent Bearer token** for every host. Enroll registers URL/IP/id only — it does **not** mint a per-worker random secret (those used to desync after delete/reinstall).

Then open **Admin → Workers** and click **Authorize**. Use **Deauthorize** to stop scheduling without deleting the row.

| Status | Meaning |
| --- | --- |
| Pending | Enrolled, not yet authorized (`enabled=false`, never seen) |
| Online / Offline | Authorized; heartbeat within / outside ~45s |
| Deauthorized | Previously seen, then disabled |

Re-running `install-worker.sh` refreshes URL/IP, rewrites the shared agent token into `.env`, and the worker **auto-enrolls again on startup**. Authorize state is preserved when the worker id matches.

API: `POST /api/workers/enroll` with `Authorization: Bearer <WORKER_ENROLL_TOKEN>`.

## Manual / env registration (deprecated fallback)

**Bootstrap via env** (orchestrator host):

```bash
WORKERS=edge1|http://10.0.0.5:8090|10.0.0.5|replace-me-with-a-long-secret
LOCAL_WORKER_ENABLED=false   # optional: control-plane-only portal
```

**Or Admin → Workers → Add worker** with the same fields (`id`, agent URL, public IP, token). This form is deprecated in favor of `install-worker.sh` and will be removed in a later version.

The orchestrator polls `GET /v1/status` every **15s**. Workers with a fresh heartbeat (within ~45s) show as **online**.

## Placement rules

Implemented in `workers/scheduler.ts` + `workers/placement.ts`:

1. Consider enabled workers that are **online**.  
2. Prefer the worker recorded in `profile_placements` when the user has a persistent profile for that browser (volumes are local to the host).  
3. Otherwise pick the lowest `activeSessions` (stable id tie-break).

Persistent profiles **stick** to the worker that first created the volume. Deleting the volume via Admin → Storage clears that placement.

## Firewall checklist

| Path | Allow |
| --- | --- |
| Clients → portal `443`/`8080` | TCP |
| Clients → each worker `WEBRTC_PORT_RANGE` | UDP + TCP |
| Orchestrator → each worker `WORKER_PORT` | TCP (private) |
| Public → worker agent | **Deny** |

## Operational tips

- Each host needs its **own** free WebRTC port range large enough for peak concurrent sessions on that host.  
- Image pulls: **Admin → Browsers → Pull latest** fans out to workers.  
- Host metrics: **Admin → Workers → status** (`GET /api/admin/workers/:id/status`).  
- If a worker disappears, existing sessions on it become unreachable until the container host returns; the reaper still applies idle/max-age rules from the portal’s point of view (viewer count drops when the proxy cannot stay up).

## Related code

| Path | Role |
| --- | --- |
| `orchestrator/src/workers/store.ts` | SQLite `workers` + `profile_placements` |
| `orchestrator/src/workers/client.ts` | HTTP client to `/v1` |
| `orchestrator/src/workers/placement.ts` | Create/remove/proxy abstraction |
| `orchestrator/src/workers/scheduler.ts` | Pick + poller + online TTL |
| `docker-compose.yml` / `deploy/podman/` | `worker` profile or worker Quadlet |
