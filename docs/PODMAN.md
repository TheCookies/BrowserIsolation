# Podman + GitHub Container Registry (GHCR)

**Start here (Alma blank-box):** **[SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md)**  
**Installer index:** **[../deploy/podman/README.md](../deploy/podman/README.md)**

Run Browser Isolation with **Podman**, publish the app image from GitHub Actions to GHCR, and re-run the install script (or recreate the container) to pick up `:latest`.

Your private GitHub **code** repo is not a container registry. Pulls use:

```text
ghcr.io/thecookies/browserisolation:latest
```

The orchestrator still talks to a Docker-compatible API (dockerode). On Podman that is the **rootful** `podman.socket`. Production installers mount it at the **same path inside the container**:

```text
/run/podman/podman.sock  →  DOCKER_SOCKET=/run/podman/podman.sock
```

---

## What you will end up with

| Piece | Role |
| --- | --- |
| GitHub Actions workflow | Builds [`Dockerfile`](../Dockerfile) on every push to `main` and pushes `:latest` + short SHA tags |
| GHCR package | Image store for remote hosts (make it **Public** for `curl | sudo bash`) |
| Install scripts | `install-orchestrator.sh` / `install-worker.sh` (canonical Alma path) |
| Container entrypoint | Create-once `/config/.env` if missing, then start portal or worker via `RBI_ROLE` |
| Host mounts | `/config`, `/var/lib/browser-isolation` (SQLite + profiles), `podman.sock`; `--network=host` |
| Extra hosts | Same image with `RBI_ROLE=worker` + enroll |

**Quadlet** (`.container` units under `deploy/podman/`) remains as an optional/legacy reference. Installers stop old Quadlet services when present. Prefer the install scripts for new hosts.

---

## Part A — Publish the image to GHCR (first time)

### 1. Push the workflow

The workflow lives at [`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml). Merge/push to `main`.

It uses the built-in `GITHUB_TOKEN` with `packages: write`. You do **not** need to create a secret just to publish from this repo.

Current action pins (Node 24–native runners):

| Action | Version |
| --- | --- |
| `actions/checkout` | v7 |
| `docker/login-action` | v4 |
| `docker/metadata-action` | v6 |
| `docker/setup-buildx-action` | v4 |
| `docker/build-push-action` | v7 |

Image build base: `node:26-bookworm-slim` (see [`Dockerfile`](../Dockerfile)).

### 2. Watch the Action

1. Open the repo on GitHub → **Actions**.
2. Select **Publish image**.
3. Open the latest run and wait until it is green.

If it fails on permissions, check **Settings → Actions → General → Workflow permissions** and allow read/write for `GITHUB_TOKEN`.

### 3. Find the package

1. Open the repo → right sidebar **Packages**, or your org/user → **Packages**.
2. Open **browserisolation**.
3. Confirm the image URI is `ghcr.io/thecookies/browserisolation`.
4. Set visibility **Public** if VMs should pull without a token (`Package settings` → `Change visibility`). A public GitHub **repo** does not make this package public.

### 4. Create a pull token (private packages only)

Install scripts pull anonymously when the package is public. For a private package:

1. GitHub → **Settings → Developer settings → Personal access tokens**.
2. Classic token with at least `read:packages`.
3. Pass it at install time: `GHCR_USER=… GHCR_TOKEN=… sudo -E bash install-orchestrator.sh`
4. Do not commit the token.

---

## Part B — Remote host (orchestrator + local worker)

Full Alma checklist: [SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md).

```bash
sudo bash deploy/podman/install-orchestrator.sh
# or pipe from the published image — see SETUP_GHCR_ALMA.md
```

The installer enables `browser-isolation-update.timer`. After a GHCR publish the host pulls `:latest` within about 5 minutes and recreates the container (keeps `/etc/browser-isolation/.env` and `/var/lib/browser-isolation`). Force it with `sudo systemctl start browser-isolation-update.service`.

---

## Part C — Extra worker hosts

```bash
sudo bash deploy/podman/install-worker.sh
# Prompt: Orchestrator host or URL
# Or: ORCHESTRATOR=10.0.0.2 sudo -E bash install-worker.sh
```

Then on the portal: **Admin → Workers → Authorize**. The orchestrator pulls enabled Neko images onto that host after authorize (the worker installer does **not** pre-pull browsers).

Details: [WORKERS.md](WORKERS.md).

### Legacy Quadlet (optional)

If you still want systemd Quadlet units instead of `podman run`:

```bash
sudo cp deploy/podman/browser-isolation-worker.container \
        deploy/podman/rbi-browsers.network \
        /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation-worker.service
```

Prefer aligning with the installer’s host-network + `/run/podman/podman.sock` conventions; older Quadlet samples may still mention `/var/run/docker.sock`.

---

## Compose alternative (laptop / quick test)

For a quick stack from a git checkout (not the Alma blank-box path):

```bash
cp .env.example .env
# edit PUBLIC_IP, etc.

# Podman (default socket path in compose)
podman compose up -d --build

# Docker Engine instead of Podman:
# CONTAINER_SOCKET=/var/run/docker.sock docker compose up -d --build
```

[`docker-compose.yml`](../docker-compose.yml) defaults `CONTAINER_SOCKET` to `/run/podman/podman.sock` and supports `build:` for local images. The container **entrypoint** still runs; Compose can override role/command for the worker profile.

Worker-only:

```bash
podman compose --profile worker up -d worker
```

---

## Troubleshooting

| Symptom | Likely fix |
| --- | --- |
| `denied` / `unauthorized` / `403` on `ghcr.io` | Make the **package** public (not just the repo), or `GHCR_USER` + `GHCR_TOKEN` with `read:packages`. Run `sudo podman logout ghcr.io` to drop a revoked login |
| Package not found after first Action | Wait for a green **Publish image** run; check org package visibility |
| Orchestrator up but cannot create browsers | `podman.socket` not running; socket not mounted at `/run/podman/podman.sock`; SELinux — installers use `--privileged` + `label=disable` |
| WebRTC fails remotely | Wrong `PUBLIC_IP`; firewall blocking `52000-52099` UDP/TCP; need `BROWSER_NETWORK_MODE=host` on Alma |
| Unit / container starts with old image | Re-run `install-orchestrator.sh` / `install-worker.sh` |

---

## Related files

| Path | Purpose |
| --- | --- |
| [`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml) | CI build/push to GHCR |
| [`deploy/podman/install-orchestrator.sh`](../deploy/podman/install-orchestrator.sh) | Canonical Alma portal install |
| [`deploy/podman/install-worker.sh`](../deploy/podman/install-worker.sh) | Canonical Alma worker install |
| [`deploy/podman/entrypoint.sh`](../deploy/podman/entrypoint.sh) | Image entrypoint (`RBI_ROLE`) |
| [`deploy/podman/*.container`](../deploy/podman/) | Optional Quadlet units |
| [`docker-compose.yml`](../docker-compose.yml) | Compose for Podman/Docker |
| [DEPLOYMENT.md](DEPLOYMENT.md) | TLS, firewall, capacity |
| [WORKERS.md](WORKERS.md) | Multi-host workers |
