# Quickstart

Use **Podman**. The published image, host networking, and the VM installer are built for it. Docker is only for a Windows or Mac laptop that already has Docker Desktop — skip it on a server.

## Fresh Linux VM

One command. It installs Podman, pulls the app, starts the portal, opens the local firewall, and downloads Chrome, Firefox, and Brave so the first **Launch** is not a wait.

```bash
curl -fsSL https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main/quickstart.sh | sudo bash
```

That URL works after this file is on the `main` branch. Alma, RHEL, Debian, and Ubuntu are fine. The script prints the URL and the admin password when it finishes.

**The GitHub repo being public is not enough.** The container image is a separate GHCR package and starts **private**. One-time:

1. Open the repo on GitHub → right sidebar **Packages** → **browserisolation**
2. **Package settings** → **Change visibility** → **Public**
3. On the VM, drop any leftover GHCR login, then re-run the curl command:

```bash
sudo podman logout ghcr.io
curl -fsSL https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main/quickstart.sh | sudo bash
```

A `403 Forbidden` on `ghcr.io` is almost always a private package or a leftover/revoked login, not the repo visibility.

| | |
| --- | --- |
| URL | `http://THIS_VM_IP:8080` |
| User | `admin` |
| Password | printed at the end, also in `/etc/browser-isolation/admin-password.txt` |

From another machine, allow **TCP 8080** and **TCP + UDP 52000–52099**. A cloud security group is separate from the firewall rules the script adds on the VM.

Run the same command again later to pull a newer image and recreate the container. An existing `/etc/browser-isolation/.env` is kept.

## Laptop (Docker Desktop)

This is the slower path. From a clone of the repo:

```powershell
Copy-Item .env.example .env
```

Add this line to `.env`:

```text
CONTAINER_SOCKET=/var/run/docker.sock
```

Leave `PUBLIC_IP=127.0.0.1` if you only open the portal on this computer. Then:

```powershell
docker compose up --build -d
```

Open **http://localhost:8080**. First-boot login is `admin` / `admin`. The first **Launch** still downloads the browser image.

To reach it from another device, set `PUBLIC_IP` to this machine’s LAN address, start Compose again, and allow TCP `8080` plus TCP and UDP `52000`–`52099`.

## After it is up

Sign in, pick a browser, click **Launch**. **Disconnect** or **Log out** destroys that container.

| Goal | Doc |
| --- | --- |
| Alma details, workers, GHCR | [docs/SETUP_GHCR_ALMA.md](docs/SETUP_GHCR_ALMA.md) |
| Settings | [`.env.example`](.env.example) |
| Code changes (Node.js 26+) | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| TLS and more than one host | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
