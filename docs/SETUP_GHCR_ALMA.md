# Step-by-step: Publish image + run on Alma Linux

This is the exact checklist. Do the sections in order.

**Big idea (read once):**

1. Your **code** lives on GitHub (`TheCookies/BrowserIsolation`).
2. A GitHub Action **builds a container image** and stores it in **GHCR** (GitHub Container Registry).
3. Your Alma Linux box does **not** `git pull` the app to run it. It runs:

   ```bash
   podman pull ghcr.io/thecookies/browserisolation:latest
   ```

4. Because the package is **private**, Alma must `podman login ghcr.io` with a Personal Access Token first.

---

## Before you start

You need:

- Access to the private GitHub repo `TheCookies/BrowserIsolation`
- Ability to push to `main` (or merge a PR into `main`)
- An Alma Linux machine with sudo
- This machine’s public/LAN IP that clients will use for the portal and WebRTC

On your Windows PC (where you develop), make sure the Podman/GHCR files are committed and pushed. At minimum these should exist on GitHub `main`:

- `.github/workflows/publish-image.yml`
- `deploy/podman/`
- `docs/SETUP_GHCR_ALMA.md` (this file)

If they are only on your laptop and not on GitHub yet, push them first:

```powershell
cd C:\Users\tyson\OneDrive\Documents\dev\StellarCreative\BrowserIsolation
git status
git add .github/workflows/publish-image.yml deploy/podman docs/PODMAN.md docs/SETUP_GHCR_ALMA.md docker-compose.yml README.md docs/DEPLOYMENT.md docs/README.md docs/WORKERS.md .env.example scripts/build-docs-site.mjs docs/site
git commit -m "Add Podman GHCR publish workflow and Alma deploy guide"
git push origin main
```

---

# Part 1 — Publish the image from GitHub (do this on GitHub.com)

## Step 1. Confirm Actions can write packages

1. Open https://github.com/TheCookies/BrowserIsolation
2. Click **Settings**
3. Left sidebar → **Actions** → **General**
4. Scroll to **Workflow permissions**
5. Select **Read and write permissions**
6. Check **Allow GitHub Actions to create and approve pull requests** only if you want that; it is not required for publishing
7. Click **Save**

## Step 2. Run (or wait for) the Publish image workflow

### Option A — You just pushed to `main`

1. Click **Actions**
2. In the left list, click **Publish image**
3. Open the newest run
4. Wait until every step is green (first build can take several minutes)

### Option B — Files are already on `main`, but no run happened

1. Click **Actions**
2. Click **Publish image**
3. Click **Run workflow** (right side)
4. Branch: `main` → **Run workflow**
5. Wait for green

If it fails:

- Open the failed step log and read the error
- Most common fix: Step 1 workflow permissions were still “read only”
- Another common issue: Dockerfile build error — fix code and push again

## Step 3. Confirm the package exists

1. Go back to the repo home: https://github.com/TheCookies/BrowserIsolation
2. On the right sidebar, look for **Packages**
3. Click **browserisolation** (name may be `browserisolation`)
4. You should see tags such as:
   - `latest`
   - a short commit SHA (example: `a1b2c3d`)
5. The pull name you will use is:

   ```text
   ghcr.io/thecookies/browserisolation:latest
   ```

6. Click **Package settings** (right side / gear)
7. Confirm **Visibility** is **Private**
8. Optional but helpful: **Manage Actions access** → ensure `TheCookies/BrowserIsolation` can write to this package

You are done publishing. GitHub will rebuild and update `:latest` every time you push to `main`.

## Step 4. Create a token so Alma can pull the private image

Alma is not GitHub Actions. It needs its own login.

1. Open https://github.com/settings/tokens
   - Or: GitHub profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Click **Generate new token (classic)**
3. Note: `browser-isolation-pull` (any name is fine)
4. Expiration: choose what you are comfortable with (90 days is fine to start)
5. Scopes: check **only**
   - `read:packages`
6. Click **Generate token**
7. **Copy the token now** (starts with `ghp_...`). You will not see it again.
8. Keep it ready for Part 2. Do not put it in git.

If your account uses SSO for the org, click **Authorize** next to the token for `TheCookies` after creating it.

---

# Part 2 — Alma Linux box: pull and auto-start

Do all of this **on the Alma Linux machine** (SSH in).

## Step 5. Install Podman

```bash
sudo dnf install -y podman
podman --version
```

Alma 8/9 usually has Podman in the default repos. If `dnf` cannot find it, enable the normal AppStream/BaseOS repos first.

## Step 6. Enable the rootful Podman API socket

The app creates browser containers through this socket.

```bash
sudo systemctl enable --now podman.socket
sudo systemctl status podman.socket --no-pager
sudo ls -l /run/podman/podman.sock
```

You should see the socket file exist and the unit active.

## Step 7. Log in to GHCR (private pull)

Replace `YOUR_GITHUB_USERNAME` with the GitHub user that owns the token (often `TheCookies` or your personal user). Paste the token when asked, or use the one-liner.

```bash
# Interactive:
sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME

# Or one-liner (token not left in shell history if you are careful):
read -s GHCR_TOKEN
echo "$GHCR_TOKEN" | sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
unset GHCR_TOKEN
```

Expected output:

```text
Login Succeeded!
```

## Step 8. Test that the pull works

```bash
sudo podman pull ghcr.io/thecookies/browserisolation:latest
sudo podman images | grep browserisolation
```

If this fails with `unauthorized` / `denied`:

- Token missing `read:packages`
- Wrong username
- Org SSO not authorized on the token
- Package never published (Part 1 not green yet)

Do **not** continue until this pull succeeds.

## Step 9. Get the deploy files onto Alma

You need the Quadlet unit files from the repo. Easiest options:

### Option A — clone the private repo (needs git credentials)

```bash
sudo dnf install -y git
cd /opt
sudo git clone https://github.com/TheCookies/BrowserIsolation.git
cd /opt/BrowserIsolation
```

Use a GitHub PAT with `repo` scope for clone if prompted (can be a different token than the packages token).

### Option B — copy only the deploy folder from your PC

From Windows (PowerShell), using `scp`:

```powershell
scp -r deploy/podman .env.example user@ALMA_IP:/tmp/browser-isolation-deploy/
```

Then on Alma:

```bash
sudo mkdir -p /opt/BrowserIsolation
sudo cp -r /tmp/browser-isolation-deploy/* /opt/BrowserIsolation/
```

## Step 10. Create the env file

```bash
sudo mkdir -p /etc/browser-isolation
sudo cp /opt/BrowserIsolation/.env.example /etc/browser-isolation/browser-isolation.env
# If you only copied deploy files, create the env file manually from the repo's .env.example
sudo chmod 600 /etc/browser-isolation/browser-isolation.env
sudo nano /etc/browser-isolation/browser-isolation.env
```

Edit at least these:

```bash
PUBLIC_IP=YOUR.ALMA.IP.HERE
AUTH_USERS=admin:CHANGE_ME:admin
COOKIE_SECURE=false
TRUST_PROXY=false
LOCAL_WORKER_ENABLED=true
DOCKER_SOCKET=/var/run/docker.sock
WEBRTC_PORT_RANGE=52000-52099
PORT=8080
```

Notes:

- Set `PUBLIC_IP` to the IP clients use to reach this Alma box.
- Change the admin password.
- Later, when you put HTTPS in front, set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- Leave `DOCKER_SOCKET=/var/run/docker.sock` — the Quadlet mounts Podman’s socket there inside the container.

Save and exit nano (`Ctrl+O`, Enter, `Ctrl+X`).

## Step 11. Install the systemd Quadlet units

```bash
sudo mkdir -p /etc/containers/systemd
sudo cp /opt/BrowserIsolation/deploy/podman/browser-isolation.container \
        /opt/BrowserIsolation/deploy/podman/rbi-browsers.network \
        /opt/BrowserIsolation/deploy/podman/rbi-data.volume \
        /etc/containers/systemd/

sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation.service
```

What this does:

- On start (including every reboot), Podman **pulls** `ghcr.io/thecookies/browserisolation:latest`
- Then starts the orchestrator container
- Restarts it if it crashes
- Keeps SQLite on the `rbi-data` volume

## Step 12. Verify it is running

```bash
sudo systemctl status browser-isolation.service --no-pager
sudo podman ps
curl -sS http://127.0.0.1:8080/api/health
```

You want:

- service `active (running)`
- a container named like `browser-isolation`
- health JSON / OK response from curl

Open in a browser:

```text
http://YOUR.ALMA.IP.HERE:8080
```

## Step 13. Open firewall ports (Alma firewalld)

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/udp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

If this host is only reachable on a private network, still open those ports on that interface / security group.

---

# Day-2 operations

## After you push new code to `main`

1. Wait for **Actions → Publish image** to go green.
2. On Alma, either reboot, or run:

   ```bash
   sudo systemctl restart browser-isolation.service
   ```

That pulls the new `:latest` and restarts the app. Data in `/data` (SQLite) survives because it is on the `rbi-data` volume.

## Check which image is running

```bash
sudo podman inspect browser-isolation --format '{{.ImageName}} {{.Image}}'
sudo podman images ghcr.io/thecookies/browserisolation
```

## View logs

```bash
sudo journalctl -u browser-isolation.service -f
# or
sudo podman logs -f browser-isolation
```

## Log in again if the token expires

```bash
read -s GHCR_TOKEN
echo "$GHCR_TOKEN" | sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
unset GHCR_TOKEN
sudo systemctl restart browser-isolation.service
```

---

# Extra worker hosts later (optional)

On a **second** Alma box that should only run browsers:

1. Repeat Steps 5–8 (Podman, socket, login, pull test).
2. Create `/etc/browser-isolation/browser-isolation.env` with:

```bash
WORKER_ID=edge1
WORKER_TOKEN=long-random-secret
WORKER_PORT=8090
PUBLIC_IP=SECOND.HOST.IP
WEBRTC_PORT_RANGE=52000-52099
DOCKER_SOCKET=/var/run/docker.sock
```

3. Install the **worker** unit only (not the orchestrator unit):

```bash
sudo cp /opt/BrowserIsolation/deploy/podman/browser-isolation-worker.container \
        /opt/BrowserIsolation/deploy/podman/rbi-browsers.network \
        /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation-worker.service
```

4. In the portal Admin → Workers, add:

- id: `edge1`
- URL: `http://SECOND.HOST.IP:8090`
- public IP: `SECOND.HOST.IP`
- token: same as `WORKER_TOKEN`

Do **not** expose port `8090` to the public internet; only the orchestrator host should reach it.

---

# Quick troubleshooting

| Problem | Fix |
| --- | --- |
| Actions workflow missing | Files not pushed to `main` yet |
| Package not listed | Wait for first green **Publish image** run |
| `podman pull` denied | Recreate PAT with `read:packages`, re-login with `sudo` |
| Service fails at start | `journalctl -u browser-isolation.service -xe` |
| Portal up, browsers fail | `podman.socket` down, or `PUBLIC_IP` wrong |
| Remote video black | Firewall missing UDP/TCP `52000-52099` |
| SELinux denials on RHEL/Alma | Check `sudo ausearch -m avc -ts recent`; often needs socket/volume labels — start by confirming `podman.socket` is rootful and unit uses `/run/podman/podman.sock` |

---

# One-page command summary (Alma)

```bash
sudo dnf install -y podman git
sudo systemctl enable --now podman.socket
echo "$GHCR_TOKEN" | sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
sudo podman pull ghcr.io/thecookies/browserisolation:latest

sudo mkdir -p /etc/browser-isolation /etc/containers/systemd /opt
# get repo files into /opt/BrowserIsolation first
sudo cp /opt/BrowserIsolation/.env.example /etc/browser-isolation/browser-isolation.env
sudo nano /etc/browser-isolation/browser-isolation.env   # set PUBLIC_IP, passwords

sudo cp /opt/BrowserIsolation/deploy/podman/browser-isolation.container \
        /opt/BrowserIsolation/deploy/podman/rbi-browsers.network \
        /opt/BrowserIsolation/deploy/podman/rbi-data.volume \
        /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-isolation.service

sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/tcp
sudo firewall-cmd --permanent --add-port=52000-52099/udp
sudo firewall-cmd --reload

curl -sS http://127.0.0.1:8080/api/health
```

Related: [PODMAN.md](PODMAN.md) (more background), [DEPLOYMENT.md](DEPLOYMENT.md) (TLS / firewall details).
