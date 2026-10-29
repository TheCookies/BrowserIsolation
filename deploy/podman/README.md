# Podman deploy (Alma / RHEL 10)

Two blank-box scripts. Copy the `.sh` file onto the host and run it as root (or pipe it from the published image).

**Full walkthrough:** [docs/SETUP_GHCR_ALMA.md](../../docs/SETUP_GHCR_ALMA.md) · [docs/PODMAN.md](../../docs/PODMAN.md)

## How it fits together

```text
install-orchestrator.sh
  → Podman + GHCR login + pull app image
  → /etc/browser-isolation/.env (once)
  → podman run --network=host --privileged
       -v /etc/browser-isolation:/config
       -v /var/lib/browser-isolation:/var/lib/browser-isolation
       -v /var/lib/browser-isolation/data:/data
       -v /run/podman/podman.sock:/run/podman/podman.sock
       -e RBI_ROLE=orchestrator
  → entrypoint.sh → dist/index.js

install-worker.sh
  → same Podman/GHCR setup
  → worker .env (ORCHESTRATOR_URL, WORKER_ID, enroll token, host network)
  → podman run … -e RBI_ROLE=worker
  → entrypoint.sh → dist/worker-main.js
  → POST /api/workers/enroll  → Admin Authorize → orchestrator pulls Neko images
```

## Orchestrator

```bash
sudo bash install-orchestrator.sh
```

- Installs Podman, logs into GHCR, pulls the app image  
- Creates `/etc/browser-isolation/.env` (first run) with `BROWSER_NETWORK_MODE=host` and `DOCKER_SOCKET=/run/podman/podman.sock`  
- Starts `browser-isolation` with host network + Podman socket  
- Default first login: `admin` / `BrowserIsolation-Admin1` (also in `/etc/browser-isolation/admin-password.txt`)  

Update later: the installer enables `browser-isolation-update.timer` (every 5 minutes). Push to `main`, wait for **Publish image**, and the host pulls `:latest` and recreates the container. `.env` is kept. Force it with `sudo systemctl start browser-isolation-update.service`.

## Worker

```bash
sudo bash install-worker.sh
# Prompt: Orchestrator host or URL  →  e.g. 192.168.1.96
```

Or non-interactive:

```bash
ORCHESTRATOR=192.168.1.96 sudo -E bash install-worker.sh
```

- Installs Podman, fixes `podman.socket`, pulls the **app** image  
- Does **not** pull Neko browser images (orchestrator pulls after Authorize)  
- Enrolls with the orchestrator (shared enroll token)  
- Starts `browser-isolation-worker` with host network + Podman socket  

Update an existing worker (keeps `/etc/browser-isolation/.env`, no orchestrator prompt):

```bash
sudo bash update-worker.sh
# or: sudo bash update-worker.sh --no-pull
```

## From the published image

```bash
# orchestrator
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-orchestrator.sh | sudo bash

# worker install
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash

# worker update
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/update-worker.sh | sudo bash
```

## Files in this directory

| File | Purpose |
| --- | --- |
| `install-orchestrator.sh` | Blank-box orchestrator install/update |
| `install-worker.sh` | Blank-box worker install |
| `auto-update.sh` | Host updater + `--install-timer` (GHCR `:latest` every 5 minutes) |
| `update-worker.sh` | Pull latest + recreate worker (keeps `.env`) |
| `install.sh` | Alias → `install-orchestrator.sh` |
| `entrypoint.sh` | Container entrypoint (baked into image; respects `RBI_ROLE`) |
| `run.sh` | Older host helper (prefer `install-orchestrator.sh`) |
| `browser-isolation.container` | Optional/legacy Quadlet unit |
| `browser-isolation-worker.container` | Optional/legacy worker Quadlet |
| `rbi-browsers.network` / `rbi-data.volume` | Quadlet helpers |

Prefer the install scripts over Quadlet/`run.sh` for new hosts.
