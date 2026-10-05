# Multi-host browser workers

The portal (orchestrator) schedules isolated browser containers onto one or more **worker** hosts so load is not stuck on a single machine.

## Roles

| Role | Runs | Needs |
| --- | --- | --- |
| Orchestrator | Portal UI, auth, SQLite, session proxy | Reachability to each worker agent URL |
| Worker | Same image, `RBI_ROLE=worker` + Podman/Docker + Neko + WebRTC ports | Client-reachable `PUBLIC_IP` and open `WEBRTC_PORT_RANGE` |

Single-node installs keep `LOCAL_WORKER_ENABLED=true` (default): the orchestrator is also worker `local`.

## Networking model

```text
User browser --HTTPS--> Orchestrator --HTTP/WS--> Worker agent --HTTP/WS--> Neko container
User browser --WebRTC UDP/TCP--> Worker PUBLIC_IP:webrtcPort
```

- Signaling and `/session/*/view` stay on the portal (cookie ACL).  
- Media goes directly to the worker that owns the session.  
- Do **not** expose the worker agent port to the public internet; restrict it to the orchestrator (or a private management network).  
  (Alma `install-worker.sh` may open `8090/tcp` on the host firewall for private LAN reachability — still keep it off the public internet.)

## Worker agent

| Item | Value |
| --- | --- |
| Entry | `RBI_ROLE=worker` → `dist/worker-main.js` (Compose profile `worker`, or `npm run start:worker`) |
| Listen | `WORKER_PORT` (default `8090`) |
| Auth | `Authorization: Bearer <token>` on `/v1/*` except `/v1/health` |

Required env on each browser host:

| Variable | Purpose |
| --- | --- |
| `RBI_ROLE` | Must be `worker` for the agent entrypoint |
| `WORKER_ENROLL_TOKEN` | Shared enroll + agent Bearer for this deployment (preferred) |
| `WORKER_TOKEN` | Legacy fallback if enroll token unset |
| `WORKER_ID` | Stable id shown in Admin (installer derives from hostname) |
| `ORCHESTRATOR_URL` | Portal base URL used for enroll (e.g. `http://10.0.0.2:8080`) |
| `WORKER_BASE_URL` | How the portal reaches this agent (installer sets from host IP + port) |
| `PUBLIC_IP` | ICE / NAT1TO1 address clients use for WebRTC to **this** host |
| `WEBRTC_PORT_RANGE` | Mux ports on this host |
| `BROWSER_NETWORK_MODE` | Use `host` on Alma installers |
| `DOCKER_SOCKET` | `/run/podman/podman.sock` on Alma |
| Policies | Baked into the image under `orchestrator/neko-policies/` |

Agent implementation: `orchestrator/src/worker-main.ts` + `worker-agent/app.ts`.  
API inventory: [API.md](API.md#worker-agent-v1).

## Self-enrollment (recommended)

On a new Alma/RHEL worker host:

```bash
sudo bash deploy/podman/install-worker.sh
# Prompt: Orchestrator host or URL  →  e.g. 10.0.0.2  or  http://rbi.example.com:8080

# Non-interactive:
ORCHESTRATOR=10.0.0.2 sudo -E bash deploy/podman/install-worker.sh

# From GHCR:
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
```

The installer:

1. Installs Podman, fixes `podman.socket`, logs into GHCR, pulls the **app** image  
2. Writes `/etc/browser-isolation/.env` for the worker role  
3. Starts `browser-isolation-worker` (host network + socket)  
4. Calls `POST /api/workers/enroll` → status **Pending**  
5. Does **not** pull Neko browser images

Orchestrator requirement: same enroll secret in portal `.env`:

```bash
WORKER_ENROLL_TOKEN=…   # install-orchestrator / entrypoint write this on first boot
```

That same value is the **worker agent Bearer token** for every host. Enroll registers URL/IP/id only — it does **not** mint a per-worker random secret.

Then open **Admin → Workers** and click **Authorize**. After authorize, the orchestrator pulls **enabled** Neko images onto that host. Use **Deauthorize** to stop scheduling without deleting the row.

| Status | Meaning |
| --- | --- |
| Pending | Enrolled, not yet authorized (`enabled=false`, never seen) |
| Online / Offline | Authorized; heartbeat within / outside ~45s |
| Deauthorized | Previously seen, then disabled |

Re-running `install-worker.sh` refreshes URL/IP and the worker **auto-enrolls again on startup**. Prior authorization is remembered in `worker_grants` (even if the worker row was removed), so you should not need to click Authorize again unless an admin previously Deauthorized that worker id.

API: `POST /api/workers/enroll` with `Authorization: Bearer <WORKER_ENROLL_TOKEN>` (CSRF exempt).

## Compose on a browser host (laptop / lab)

Prefer Alma install scripts in production. For Compose:

```bash
# In .env on that host:
WORKER_ID=edge1
WORKER_TOKEN=replace-me-with-a-long-secret   # or WORKER_ENROLL_TOKEN=
PUBLIC_IP=10.0.0.5          # client-reachable
WORKER_PORT=8090
WEBRTC_PORT_RANGE=52000-52099
# Align published ports in docker-compose.yml if you change the range

podman compose --profile worker up -d worker
# Docker: CONTAINER_SOCKET=/var/run/docker.sock docker compose --profile worker up -d worker
```

The `worker` service publishes `52000-52099` UDP+TCP by default.

## Manual / env registration (deprecated fallback)

**Bootstrap via env** (orchestrator host):

```bash
WORKERS=edge1|http://10.0.0.5:8090|10.0.0.5|replace-me-with-a-long-secret
LOCAL_WORKER_ENABLED=false   # optional: control-plane-only portal
```

**Or Admin → Workers → Add worker** with the same fields (`id`, agent URL, public IP, token). Prefer `install-worker.sh`; the form is kept as a fallback.

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
- Image pulls: **Admin → Browsers → Pull latest** fans out to authorized workers; authorize also triggers pulls of enabled browsers.  
- Host metrics: **Admin → Workers → status** (`GET /api/admin/workers/:id/status`).  
- If a worker disappears, existing sessions on it become unreachable until the container host returns; the reaper still applies idle/max-age rules from the portal’s point of view (viewer count drops when the proxy cannot stay up).

## Related code

| Path | Role |
| --- | --- |
| `orchestrator/src/workers/store.ts` | SQLite `workers` + `profile_placements` + `worker_grants` |
| `orchestrator/src/workers/client.ts` | HTTP client to `/v1` |
| `orchestrator/src/workers/placement.ts` | Create/remove/proxy abstraction |
| `orchestrator/src/workers/scheduler.ts` | Pick + poller + online TTL |
| `deploy/podman/install-worker.sh` | Canonical Alma worker bootstrap |
| `docker-compose.yml` | Compose `worker` profile for labs |
