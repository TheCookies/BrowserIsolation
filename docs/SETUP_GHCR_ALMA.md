# Super-simple deploy: GHCR + Alma Linux

**Preferred path:** blank-box install scripts. They install Podman, log into GHCR, write `/etc/browser-isolation/.env` once, and start the container with host networking + the Podman socket.

| Role | Script |
| --- | --- |
| Portal + local worker | [`deploy/podman/install-orchestrator.sh`](../deploy/podman/install-orchestrator.sh) |
| Extra browser host | [`deploy/podman/install-worker.sh`](../deploy/podman/install-worker.sh) |

Index of helpers: [../deploy/podman/README.md](../deploy/podman/README.md).

### What the container expects

- Host `/etc/browser-isolation` → `/config` (`.env` lives here)
- Volume `rbi-data` → `/data` (SQLite)
- Host `/run/podman/podman.sock` → same path in the container (`DOCKER_SOCKET=/run/podman/podman.sock`)
- `--network=host` so eth0 / WebRTC ports are the real host network
- `--privileged` + `--security-opt label=disable` (installers set these so Podman-in-Podman works on Alma)

On first start, if `/config/.env` is missing, the **entrypoint** creates it (random admin password in logs). Installers usually create `.env` **before** first start with a known password instead.

---

# Part 1 — GitHub (once, then automatic)

## 1. Push this repo to `main`

## 2. Allow Actions to write packages

1. https://github.com/TheCookies/BrowserIsolation → **Settings**
2. **Actions** → **General** → **Workflow permissions**
3. **Read and write permissions** → **Save**

## 3. Wait for green **Publish image**

**Actions** → **Publish image** → green (or **Run workflow** on `main`)

Workflow: [`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml)  
Builds [`Dockerfile`](../Dockerfile) (`node:26-bookworm-slim`) and pushes `ghcr.io/thecookies/browserisolation:latest` plus a short SHA tag.

## 4. Create a pull token (only if you are **not** using the install scripts)

Install scripts for this deployment already contain GHCR credentials. For a manual/custom host:

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Check **`read:packages`**
3. Copy the `ghp_...` token

Image name:

```text
ghcr.io/thecookies/browserisolation:latest
```

---

# Part 2 — Alma Linux orchestrator (blank box)

## Recommended: install script

Copy `install-orchestrator.sh` onto the host (or pipe it from the image after a one-shot pull/login), then:

```bash
sudo bash install-orchestrator.sh
```

From GHCR (after the host can pull, or using credentials baked into the script):

```bash
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-orchestrator.sh | sudo bash
```

What it does:

1. Installs/enables Podman + `podman.socket`
2. Logs into GHCR and pulls `:latest`
3. Creates `/etc/browser-isolation/.env` on first run (`BROWSER_NETWORK_MODE=host`, `DOCKER_SOCKET=/run/podman/podman.sock`, enroll token, etc.)
4. Starts `browser-isolation` with `--network=host --privileged` and the socket mount above
5. Opens firewall ports `8080/tcp` and `52000-52099` tcp/udp when `firewall-cmd` exists

### First login

| | |
| --- | --- |
| URL | `http://YOUR_ETH0_IP:8080` |
| User | `admin` |
| Password | `BrowserIsolation-Admin1` (also written to `/etc/browser-isolation/admin-password.txt`) |

Re-running the script updates the image and recreates the container; it **keeps** an existing `.env`.

## Advanced: manual `podman run`

Only if you are not using the installer. Match these flags — older docs that mounted the socket as `/var/run/docker.sock` fight the entrypoint (which sets `DOCKER_SOCKET=/run/podman/podman.sock` in `/config/.env`).

```bash
sudo dnf install -y podman
sudo systemctl enable --now podman.socket

mkdir -p /etc/containers /etc/browser-isolation
# podman login ghcr.io … --authfile /etc/containers/auth.json

sudo podman pull --authfile /etc/containers/auth.json \
  ghcr.io/thecookies/browserisolation:latest

sudo podman run -d \
  --name browser-isolation \
  --restart=always \
  --network=host \
  --privileged \
  --security-opt label=disable \
  -v /etc/browser-isolation:/config:Z \
  -v rbi-data:/data:Z \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e DOCKER_SOCKET=/run/podman/podman.sock \
  -e RBI_ROLE=orchestrator \
  ghcr.io/thecookies/browserisolation:latest
```

If you did **not** pre-create `.env`, grab the random password from logs:

```bash
sudo podman logs browser-isolation 2>&1 | grep -A2 "Portal admin password"
```

Optional firewall (installers do this automatically):

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/udp
sudo firewall-cmd --reload
```

---

# Updates (keeps settings + database)

```bash
sudo bash install-orchestrator.sh
```

Or manually:

```bash
sudo podman pull --authfile /etc/containers/auth.json \
  ghcr.io/thecookies/browserisolation:latest
sudo podman rm -f browser-isolation
# re-run the same podman run / installer
```

`/etc/browser-isolation/.env` and volume `rbi-data` stay.

To force a brand-new `.env` (new password / IP):

```bash
sudo rm /etc/browser-isolation/.env /etc/browser-isolation/admin-password.txt
sudo podman rm -f browser-isolation
sudo bash install-orchestrator.sh
```

---

# Useful commands

```bash
sudo podman ps
sudo podman logs -f browser-isolation
curl -sS http://127.0.0.1:8080/api/health
sudo nano /etc/browser-isolation/.env   # edit settings, then:
sudo podman restart browser-isolation
```

---

# Troubleshooting

| Problem | Fix |
| --- | --- |
| pull denied | `read:packages` token + `--authfile /etc/containers/auth.json` (or re-run installer) |
| no admin password in logs | `.env` already existed; see `/etc/browser-isolation/.env` (`AUTH_USERS=`) or `admin-password.txt` |
| `EACCES` / socket errors | Recreate with `--privileged --security-opt label=disable`; socket must be `/run/podman/podman.sock` on **both** sides; ensure `podman.socket` is up |
| `websocket closed` / stuck on Connecting | Confirm `BROWSER_NETWORK_MODE=host` in `.env` (installer default). Remove stale `rbi-*` containers and retry |
| wrong `PUBLIC_IP` | Edit `/etc/browser-isolation/.env` or delete `.env` and recreate |
| old image | Wait for green **Publish image**, then re-run installer |

---

# Extra worker hosts

On each new Alma worker host:

```bash
sudo bash install-worker.sh
# Prompt: Orchestrator host or URL  →  e.g. 192.168.1.96
```

Or:

```bash
ORCHESTRATOR=192.168.1.96 sudo -E bash install-worker.sh
```

From the image:

```bash
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
```

The worker installer:

- Does **not** pull Neko browser images (the orchestrator pulls enabled browsers after **Admin → Workers → Authorize**)
- Enrolls with `WORKER_ENROLL_TOKEN` (shared with the orchestrator `.env`)
- Starts `browser-isolation-worker` with host network + Podman socket

See [WORKERS.md](WORKERS.md) and [deploy/podman/README.md](../deploy/podman/README.md).

---

Related: [PODMAN.md](PODMAN.md), [DEPLOYMENT.md](DEPLOYMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md).
