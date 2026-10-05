# Super-simple deploy: GHCR + Alma Linux

The container is self-bootstrapping:

- Mount host `/etc/browser-isolation` → `/config`
- On first start, if `/config/.env` is missing, the container **creates it** (`PUBLIC_IP` from host `eth0`, random admin password printed in logs)
- If `.env` already exists, it is **never overwritten**
- SQLite lives on volume `rbi-data`
- Podman socket is mounted so browser containers can be created

Use `--network=host` so eth0/WebRTC ports are the real host network.

---

# Part 1 — GitHub (once, then automatic)

## 1. Push this repo to `main`

## 2. Allow Actions to write packages

1. https://github.com/TheCookies/BrowserIsolation → **Settings**
2. **Actions** → **General** → **Workflow permissions**
3. **Read and write permissions** → **Save**

## 3. Wait for green **Publish image**

**Actions** → **Publish image** → green (or **Run workflow** on `main`)

## 4. Create a pull token

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Check **`read:packages`**
3. Copy the `ghp_...` token

Image name:

```text
ghcr.io/thecookies/browserisolation:latest
```

---

# Part 2 — Alma Linux (entire install)

```bash
sudo dnf install -y podman
sudo systemctl enable --now podman.socket

# Persistent GHCR login (needed for private pulls)
mkdir -p /etc/containers /etc/browser-isolation
read -s GHCR_TOKEN
echo "$GHCR_TOKEN" | sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME \
  --authfile /etc/containers/auth.json --password-stdin
unset GHCR_TOKEN
sudo chmod 600 /etc/containers/auth.json

# Pull + run (self-creates /etc/browser-isolation/.env on first boot)
sudo podman pull --authfile /etc/containers/auth.json \
  ghcr.io/thecookies/browserisolation:latest

sudo podman run -d \
  --name browser-isolation \
  --restart=always \
  --network=host \
  --security-opt label=disable \
  -v /etc/browser-isolation:/config:Z \
  -v rbi-data:/data:Z \
  -v /run/podman/podman.sock:/var/run/docker.sock \
  -e DOCKER_SOCKET=/var/run/docker.sock \
  ghcr.io/thecookies/browserisolation:latest
```

Or use the helper from a checkout / scp:

```bash
sudo bash deploy/podman/run.sh
```

### First login password

```bash
sudo podman logs browser-isolation 2>&1 | grep -A2 "Portal admin password"
```

Open `http://YOUR_ETH0_IP:8080` — user `admin`, password from the logs.

Optional firewall:

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/udp
sudo firewall-cmd --reload
```

---

# Updates (keeps settings + database)

```bash
sudo podman pull --authfile /etc/containers/auth.json \
  ghcr.io/thecookies/browserisolation:latest
sudo podman rm -f browser-isolation
sudo bash /path/to/run.sh --no-pull
```

Or the same `podman run ...` command again after `podman rm -f browser-isolation`.

`/etc/browser-isolation/.env` and volume `rbi-data` stay.

To force a brand-new `.env` (new password / IP):

```bash
sudo rm /etc/browser-isolation/.env
sudo podman rm -f browser-isolation
# run the container again
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
| pull denied | `read:packages` token + `--authfile /etc/containers/auth.json` |
| no admin password in logs | `.env` already existed; see `/etc/browser-isolation/.env` (`AUTH_USERS=`) |
| `EACCES /var/run/docker.sock` | recreate with `--security-opt label=disable` (SELinux); ensure `podman.socket` is up |
| `websocket closed` / stuck on Connecting | Set `BROWSER_NETWORK_MODE=host` in `/etc/browser-isolation/.env` (Podman published ports often unreachable from Hyper-V Default Switch). Redeploy latest image, remove old `rbi-*` containers, retry. |
| wrong PUBLIC_IP | edit `/etc/browser-isolation/.env` or delete `.env` and recreate container |
| old image without entrypoint | wait for green **Publish image**, then `podman pull` again |

---

# Extra worker hosts later

On each new Alma worker host:

```bash
sudo bash install-worker.sh
# or from image:
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
```

Prompts only for the orchestrator host/IP. Configures Podman, GHCR login, image pulls, enroll, and starts the worker.

Orchestrator install (blank box):

```bash
sudo bash install-orchestrator.sh
```

See [deploy/podman/README.md](../deploy/podman/README.md).

---

Related: [PODMAN.md](PODMAN.md), [DEPLOYMENT.md](DEPLOYMENT.md).
