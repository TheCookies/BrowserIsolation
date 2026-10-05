# Podman deploy (Alma / RHEL 10)

Two blank-box scripts with credentials baked in. Copy the `.sh` file onto the host and run it as root.

## Orchestrator

```bash
sudo bash install-orchestrator.sh
```

- Installs Podman, logs into GHCR, pulls the image
- Creates `/etc/browser-isolation/.env` (first run)
- Starts `browser-isolation` with host network + Podman socket
- Default first login: `admin` / `BrowserIsolation-Admin1` (also in `/etc/browser-isolation/admin-password.txt`)

Update later: run the same script again (keeps `.env`).

## Worker

```bash
sudo bash install-worker.sh
# Prompt: Orchestrator host or URL  →  e.g. 192.168.1.96
```

Or non-interactive:

```bash
ORCHESTRATOR=192.168.1.96 sudo -E bash install-worker.sh
```

- Installs Podman, fixes `podman.socket`, pulls app + Neko images
- Enrolls with the orchestrator (shared enroll token)
- Starts `browser-isolation-worker` with host network + Podman socket

## From the published image

```bash
# orchestrator
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-orchestrator.sh | sudo bash

# worker
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
```

| File | Purpose |
| --- | --- |
| `install-orchestrator.sh` | Blank-box orchestrator install/update |
| `install-worker.sh` | Blank-box worker install/update |
| `install.sh` | Alias → `install-orchestrator.sh` |
| `entrypoint.sh` | Container entrypoint (baked into image) |
| `run.sh` | Older host helper (prefer install-orchestrator.sh) |
