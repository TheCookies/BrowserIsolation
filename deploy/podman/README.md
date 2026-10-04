# Podman deploy

**Simple path (recommended):** extract and run the installer from the published image — see [docs/SETUP_GHCR_ALMA.md](../../docs/SETUP_GHCR_ALMA.md).

```bash
sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME
sudo podman pull ghcr.io/thecookies/browserisolation:latest
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest \
  /deploy/install.sh | sudo bash
```

| File | Purpose |
| --- | --- |
| `install.sh` | One-shot host installer (also baked into the image at `/deploy/install.sh`) |
| `browser-isolation.container` | Orchestrator Quadlet (written by installer) |
| `browser-isolation-worker.container` | Extra browser-host Quadlet |
| `rbi-browsers.network` / `rbi-data.volume` | Network + data volume |
