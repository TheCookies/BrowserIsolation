# Podman deploy

**Recommended:** self-bootstrapping container — [docs/SETUP_GHCR_ALMA.md](../../docs/SETUP_GHCR_ALMA.md).

```bash
sudo systemctl enable --now podman.socket
sudo podman login ghcr.io -u USER --authfile /etc/containers/auth.json
sudo bash deploy/podman/run.sh
sudo podman logs browser-isolation | grep "Portal admin password"
```

| File | Purpose |
| --- | --- |
| `entrypoint.sh` | Baked into image as `/entrypoint.sh` — create-once `/config/.env`, start app |
| `run.sh` | Host helper: pull + `podman run --network=host` with the right mounts |
| `install.sh` / `*.container` | Legacy Quadlet path (optional; not required) |
