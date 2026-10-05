# Deployment

How to run Browser Isolation in production (or anything beyond a laptop).

**Production recommendation:** Podman + GHCR image + self-bootstrapping `podman run --network=host` (host-mounted `/config/.env`).

- Exact Alma Linux checklist: **[SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md)**
- Background / reference: **[PODMAN.md](PODMAN.md)**

## Recommended topology

**Single host (default)**

- One orchestrator service (`LOCAL_WORKER_ENABLED=true`)  
- Container engine socket mounted (Podman or Docker); WebRTC ports published on the host (or DNAT)  
- Optional reverse proxy for TLS on `443`

**Split control / data plane**

- Portal host: orchestrator only (`LOCAL_WORKER_ENABLED=false`)  
- One or more browser hosts: worker profile / worker Quadlet  
- Clients → portal (HTTPS); clients → each worker `PUBLIC_IP` for WebRTC  
- Orchestrator → worker agents on a private network  

See [WORKERS.md](WORKERS.md).

---

## Podman + GHCR (recommended)

1. Push to `main` so Actions publishes `ghcr.io/thecookies/browserisolation:latest`.  
2. On the host: enable `podman.socket`, `podman login --authfile /etc/containers/auth.json`, then `podman run --network=host` with `/config`, data, and socket mounts.  

Full steps: [SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md) · [PODMAN.md](PODMAN.md).

---

## Compose quick deploy

```bash
cp .env.example .env
# Edit: PUBLIC_IP, COOKIE_SECURE, TRUST_PROXY, AUTH_USERS (first boot only), etc.

# Podman (default): API socket at /run/podman/podman.sock
podman compose up -d --build

# Docker Engine:
# CONTAINER_SOCKET=/var/run/docker.sock docker compose up -d --build
```

Healthcheck hits `GET /api/health` inside the container.

Data persists on volume `rbi-data` → `/data/rbi.sqlite`.
---

## Firewall / security groups

| Port | Protocol | Who needs it | Purpose |
| --- | --- | --- | --- |
| `PORT` (8080) or `80`/`443` on proxy | TCP | Clients | Portal UI, API, signaling proxy |
| Every port in `WEBRTC_PORT_RANGE` | **UDP and TCP** | Clients | Per-session WebRTC mux |
| `WORKER_PORT` (8090) | TCP | **Orchestrator only** | Worker agent API |

Clients must reach `PUBLIC_IP` on the WebRTC ports. TLS on the portal does **not** encrypt the WebRTC media path by itself; use a private network or TURN as needed.

---

## Reverse proxy with TLS

Terminate TLS in front of the orchestrator. Set:

```bash
COOKIE_SECURE=true
TRUST_PROXY=true
PUBLIC_BASE_URL=https://rbi.example.com   # required for SAML
PUBLIC_IP=<client-reachable host IP>
```

### Caddy

```caddy
rbi.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

### Nginx

WebSocket upgrade is required for `/session/*/view/ws`:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 443 ssl http2;
  server_name rbi.example.com;

  ssl_certificate     /etc/ssl/certs/rbi.fullchain.pem;
  ssl_certificate_key /etc/ssl/private/rbi.key;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
  }
}
```

Keep publishing (or DNATing) the WebRTC UDP/TCP range on the browser host(s).

---

## WebRTC and NAT

| Setting | Guidance |
| --- | --- |
| `PUBLIC_IP` | Address clients use in ICE candidates (host public IP or LAN IP) |
| `WEBRTC_ICELITE=true` | Default; matches single published mux port |
| `ICE_SERVERS_*` | JSON arrays of `RTCIceServer`; set when you add TURN |
| TURN | Requires `WEBRTC_ICELITE=false` and real TURN credentials |

If users are behind strict NAT and direct UDP fails, deploy TURN and configure both frontend and backend ICE server lists (see `.env.example`).

---

## Capacity knobs

| Variable | Effect |
| --- | --- |
| `WEBRTC_PORT_RANGE` | Hard cap on concurrent sessions per host (one port each) |
| `BROWSER_CPUS` / `BROWSER_MEMORY` | Per-container limits (use ≥3 CPUs for video-heavy sites) |
| `BROWSER_SHM_SIZE` | `/dev/shm` for Chromium-family browsers |
| `IDLE_TIMEOUT_MINUTES` | Destroy when no viewers |
| `MAX_SESSION_HOURS` | Hard lifetime |
| `DESKTOP_SCREEN` | Cold-start capture; viewer then sends `screen/set` |

Admin → Settings can override most of these without redeploying (except infrastructure keys).

---

## Security checklist

- [ ] Change default `admin` / `user` passwords (or delete seed users) after first login  
- [ ] `COOKIE_SECURE=true` and HTTPS in production  
- [ ] `TRUST_PROXY=true` only behind a proxy you control  
- [ ] Keep `ALLOW_CLIPBOARD` / `ALLOW_DOWNLOADS` off unless required  
- [ ] Do not expose Docker socket or worker agent ports publicly  
- [ ] Restrict who has `admin` role; prefer SAML + `SAML_ADMIN_GROUP` when using SSO  
- [ ] Rotate `WORKER_TOKEN` if it leaks; treat it like a cluster secret  
- [ ] Back up `/data/rbi.sqlite` (and decide whether profile volumes are in scope)

---

## SAML / SSO

Configure in **Admin → Settings → SSO / SAML** or via `.env`. You need at least:

- `SAML_ENABLED=true`
- `PUBLIC_BASE_URL`
- `SAML_ENTRY_POINT`
- `SAML_IDP_CERT`

SP metadata: `https://<portal>/saml/metadata`  
ACS: `https://<portal>/api/auth/saml/acs`

Details: [USER_IDENTITY.md](USER_IDENTITY.md).

---

## Upgrades

**GHCR host (`podman run`)**

```bash
sudo podman pull --authfile /etc/containers/auth.json ghcr.io/thecookies/browserisolation:latest
sudo podman rm -f browser-isolation
# re-run the same podman run (or sudo bash deploy/podman/run.sh --no-pull)
```

**Compose from a git checkout**

```bash
git pull
podman compose pull
podman compose up -d --build
```

On start the orchestrator:

1. Applies SQLite migrations in `db.ts`  
2. Hydrates settings from `app_settings`  
3. Reconciles managed containers with `browser_sessions`  
4. Starts the reaper and worker poller  

Neko image tags: set `NEKO_IMAGE_TAG` or use **Admin → Browsers → Pull latest**.

---

## Observability

- Orchestrator logs: Fastify JSON logs (cookies redacted)  
- Health: `GET /api/health`  
- Admin → Sessions / Workers for live counts and host metrics  
- Audit: Admin → Audit (actions configurable via settings)

There is no separate metrics exporter yet; scrape logs or poll admin APIs if you need external monitoring.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Black / stuck stream | Wrong `PUBLIC_IP`, firewall blocking WebRTC UDP/TCP, ICE lite vs TURN mismatch |
| Works on server, not remote client | `PUBLIC_IP=127.0.0.1` |
| Login cookie lost | `COOKIE_SECURE=true` on HTTP, or proxy not forwarding proto |
| First launch slow | Image not pulled; run prepull profile |
| `webrtc_port_pool_exhausted` | Too many sessions for range; widen range + publish ports |
| Worker always offline | Orchestrator cannot reach agent URL; token mismatch; firewall |
| Profile “lost” after SSO | Different `subjectId` (`local:` vs `saml:`) — see USER_IDENTITY.md |
