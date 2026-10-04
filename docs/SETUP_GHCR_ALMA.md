# Super-simple deploy: GHCR + Alma Linux

You only need two things:

1. **GitHub** builds the image when you push to `main`
2. **Alma** logs into GHCR once, then runs a one-shot installer

No git clone on the server. No hand-copying Quadlet files.

---

# Part 1 — GitHub (once, then automatic)

## 1. Push this repo to `main`

From your Windows PC, commit and push the deploy files if you have not already.

## 2. Allow Actions to write packages

1. https://github.com/TheCookies/BrowserIsolation → **Settings**
2. **Actions** → **General** → **Workflow permissions**
3. Choose **Read and write permissions** → **Save**

## 3. Wait for the green build

1. **Actions** → **Publish image**
2. Wait until it is green  
   (or **Run workflow** on `main` if nothing ran)

## 4. Create a pull token

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Check **`read:packages`** only
3. Generate → **copy** the `ghp_...` token

Done on GitHub. Every future push to `main` updates  
`ghcr.io/thecookies/browserisolation:latest`.

---

# Part 2 — Alma Linux (the whole server install)

SSH into Alma and run this. That is the entire deploy.

```bash
# 0) install podman if needed
sudo dnf install -y podman

# 1) login to the private image registry (paste token when prompted)
sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME

# 2) pull the image
sudo podman pull ghcr.io/thecookies/browserisolation:latest

# 3) run the installer baked into the image
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest \
  /deploy/install.sh | sudo bash
```

The installer will ask for:

- **Public/LAN IP** (press Enter to accept the detected default)
- **Admin password** for the portal

It then:

- enables `podman.socket`
- writes `/etc/browser-isolation/browser-isolation.env`
- installs systemd auto-start with **`Pull=always`** (pulls `:latest` on every boot/restart)
- opens firewall ports `8080` and `52000-52099` if `firewalld` is running
- starts the service and checks `/api/health`

Open:

```text
http://YOUR_IP:8080
```

Login: `admin` / (password you typed)

---

## Non-interactive (optional)

```bash
sudo podman login ghcr.io -u YOUR_GITHUB_USERNAME
sudo podman pull ghcr.io/thecookies/browserisolation:latest

sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest \
  /deploy/install.sh | sudo env \
  PUBLIC_IP=1.2.3.4 \
  ADMIN_PASSWORD='choose-a-strong-password' \
  bash
```

---

## After you ship a new build

On your PC: push to `main` → wait for Actions green.

On Alma:

```bash
sudo systemctl restart browser-isolation.service
```

That pulls the new `:latest` and restarts. SQLite data stays on the volume.

---

## Useful commands

```bash
sudo systemctl status browser-isolation.service
sudo podman ps
sudo podman logs -f browser-isolation
sudo journalctl -u browser-isolation.service -f
curl -sS http://127.0.0.1:8080/api/health
```

---

## If pull says denied

- Token must include `read:packages`
- Login with `sudo` (rootful Podman stores its own credentials)
- First **Publish image** Action must have succeeded
- Org SSO: authorize the token for `TheCookies` if prompted

---

## Extra worker hosts later

Still simple, but a different unit. See [PODMAN.md](PODMAN.md) Part C, or say if you want a matching `install-worker.sh`.

---

## What you do NOT need on Alma

- Cloning this git repo
- Copying Quadlet files by hand
- Docker
- Node.js / npm
