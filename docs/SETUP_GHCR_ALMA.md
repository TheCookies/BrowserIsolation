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

The installer:

- Sets `PUBLIC_IP` from the current **eth0** IPv4 address automatically
- Asks once for the **admin password** (type it; the prompt reads from your keyboard even when the script is piped)

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

On Alma (either is fine):

```bash
# Fastest — pulls :latest and restarts; never touches your settings
sudo systemctl restart browser-isolation.service

# Or re-run the installer — it keeps /etc/browser-isolation/browser-isolation.env
sudo podman run --rm --entrypoint cat \
  ghcr.io/thecookies/browserisolation:latest \
  /deploy/install.sh | sudo bash
```

Settings are only written on **first** install. To force rewrite them: `FORCE_SETTINGS=1`.
SQLite data stays on the `rbi-data` volume either way.

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

## If `cat: /deploy/install.sh: No such file or directory`

Your Alma box has an **old** image (built before the installer was baked in), or Actions has not published the new build yet.

1. On GitHub → **Actions** → **Publish image** → confirm the newest run is **green**
2. On Alma, force a fresh pull and check the folder exists:

```bash
sudo podman pull ghcr.io/thecookies/browserisolation:latest
sudo podman run --rm --entrypoint ls \
  ghcr.io/thecookies/browserisolation:latest /deploy
```

You should see `install.sh`. Then re-run the installer pipe.

**Works right now without waiting for a new image** — copy just the installer from your PC:

```powershell
# On Windows (from the repo root)
scp deploy\podman\install.sh root@ALMA_IP:/tmp/install-rbi.sh
```

```bash
# On Alma
sudo bash /tmp/install-rbi.sh
```

---

## Extra worker hosts later

Still simple, but a different unit. See [PODMAN.md](PODMAN.md) Part C, or say if you want a matching `install-worker.sh`.

---

## What you do NOT need on Alma

- Cloning this git repo
- Copying Quadlet files by hand
- Docker
- Node.js / npm
