# Podman + GitHub Container Registry (GHCR)

**Start here (super simple Alma deploy):** **[SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md)**  
`podman login` → `podman pull` → pipe `/deploy/install.sh` into `bash`. No git clone on the server.

Run Browser Isolation with **Podman** instead of Docker, publish the app image from GitHub Actions to a **private** GHCR package, and auto-pull `:latest` on a remote host at boot.

Your private GitHub **code** repo is not a container registry. Pulls use:

```text
ghcr.io/thecookies/browserisolation:latest
```

The orchestrator still talks to a Docker-compatible API (dockerode). On Podman that is the **rootful** `podman.socket`, mounted into the container as `/var/run/docker.sock`.

---

## What you will end up with

| Piece | Role |
| --- | --- |
| GitHub Actions workflow | Builds [`Dockerfile`](../Dockerfile) on every push to `main` and pushes `:latest` + short SHA tags |
| GHCR package | Private image store for the remote host |
| Remote host Quadlet unit | On boot: pull `:latest`, start orchestrator (local worker enabled) |
| Extra hosts (later) | Same image, **worker** Quadlet only — no orchestrator |

---

## Part A — Publish the image to GHCR (first time)

### 1. Push the workflow

The workflow lives at [`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml). Merge it to `main` (or push `main` if you are already on it).

It uses the built-in `GITHUB_TOKEN` with `packages: write`. You do **not** need to create a secret just to publish from this repo.

### 2. Watch the Action

1. Open the repo on GitHub → **Actions**.
2. Select **Publish image**.
3. Open the latest run and wait until it is green.

If it fails on permissions, check **Settings → Actions → General → Workflow permissions** and allow read/write for `GITHUB_TOKEN` (or keep the workflow’s explicit `packages: write`).

### 3. Find the package

1. Open the repo → right sidebar **Packages**, or your org/user → **Packages**.
2. Open **browserisolation** (name may appear as `browserisolation`).
3. Confirm the image URI is `ghcr.io/thecookies/browserisolation`.
4. Under package settings, keep visibility **Private** (default for private repos).

Optional but useful: under package **Package settings → Manage Actions access**, ensure this repository has a role that can write (the publishing workflow needs that once; pull from a remote uses a PAT — next step).

### 4. Create a pull token for the remote host

The remote machine is not GitHub Actions, so it needs credentials to pull a private package.

1. GitHub → profile → **Settings → Developer settings → Personal access tokens**.
2. Create a **classic** token with at least:
   - `read:packages`
3. Copy the token once. Store it only on the remote host (or a secret manager). Do not commit it.

Fine-grained tokens can work if granted **read** access to the package (and the repo if your org requires it). Classic `read:packages` is the simplest first path.

---

## Part B — Remote host (orchestrator + local worker)

Use the image-baked installer. Full Alma checklist: [SETUP_GHCR_ALMA.md](SETUP_GHCR_ALMA.md).

```bash
sudo dnf install -y podman          # or apt install podman
sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME
sudo podman pull ghcr.io/thecookies/browserisolation:latest
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest \
  /deploy/install.sh | sudo bash
```

That writes the env file, Quadlet units (`Pull=always`), opens firewalld ports when present, and starts `browser-isolation.service`.

After a new GHCR publish:

```bash
sudo systemctl restart browser-isolation.service
```

---

## Part C — Extra worker hosts (later)

Do **not** install `browser-isolation.container` on these machines.

1. Same Podman + `podman.socket` + `podman login ghcr.io` steps as Part B.
2. Env file with at least:

```bash
WORKER_ID=edge1
WORKER_TOKEN=long-random-secret
WORKER_PORT=8090
PUBLIC_IP=10.0.0.5
WEBRTC_PORT_RANGE=52000-52099
DOCKER_SOCKET=/var/run/docker.sock
```

3. Install the worker unit + network (no data volume required):

```bash
sudo cp deploy/podman/browser-isolation-worker.container \
        deploy/podman/rbi-browsers.network \
        /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation-worker.service
```

4. Register the worker on the portal: **Admin → Workers**, or set `WORKERS=` on the orchestrator host. Details: [WORKERS.md](WORKERS.md).

---

## Compose alternative (laptop / quick test)

Quadlet is the recommended production path. For a quick stack from a git checkout:

```bash
cp .env.example .env
# edit PUBLIC_IP, etc.

# Podman (default socket path in compose)
podman compose up -d --build

# Docker Engine instead of Podman:
# CONTAINER_SOCKET=/var/run/docker.sock docker compose up -d --build
```

[`docker-compose.yml`](../docker-compose.yml) defaults `CONTAINER_SOCKET` to `/run/podman/podman.sock` and still supports `build:` for local images.

Worker-only:

```bash
podman compose --profile worker up -d worker
```

---

## Troubleshooting

| Symptom | Likely fix |
| --- | --- |
| `denied` / `unauthorized` on pull | `podman login ghcr.io` with a token that has `read:packages`; use `sudo` if the service runs rootful |
| Package not found after first Action | Wait for a green **Publish image** run; check org package visibility |
| Orchestrator up but cannot create browsers | `podman.socket` not running; socket not mounted; SELinux denying socket (`sudo setsebool -P container_manage_cgroup on` on some RHEL setups) |
| WebRTC fails remotely | Wrong `PUBLIC_IP`; firewall blocking `52000-52099` UDP/TCP |
| Unit starts with old image | Confirm `Pull=always` in the `.container` file; `systemctl restart browser-isolation.service` |

---

## Related files

| Path | Purpose |
| --- | --- |
| [`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml) | CI build/push to GHCR |
| [`deploy/podman/`](../deploy/podman/) | Quadlet units |
| [`docker-compose.yml`](../docker-compose.yml) | Compose for Podman/Docker |
| [DEPLOYMENT.md](DEPLOYMENT.md) | TLS, firewall, capacity |
| [WORKERS.md](WORKERS.md) | Multi-host workers |
