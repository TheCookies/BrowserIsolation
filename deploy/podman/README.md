# Podman Quadlet units

Copy these files onto a Linux host that runs **rootful Podman**. Full walkthrough: [docs/PODMAN.md](../../docs/PODMAN.md).

| File | Purpose |
| --- | --- |
| `browser-isolation.container` | Single-node orchestrator (`LOCAL_WORKER_ENABLED=true`) |
| `browser-isolation-worker.container` | Extra browser host only (no portal) |
| `rbi-browsers.network` | Shared Podman network for Neko containers |
| `rbi-data.volume` | Persistent SQLite volume (orchestrator host) |

```bash
sudo mkdir -p /etc/containers/systemd /etc/browser-isolation
sudo cp deploy/podman/*.container deploy/podman/*.network deploy/podman/*.volume \
  /etc/containers/systemd/
# Only install the worker unit on extra browser hosts — not both units on one host
# unless you intentionally run a second agent locally.

sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation.service   # or browser-isolation-worker.service
```

Quadlet turns `browser-isolation.container` into `browser-isolation.service`.
