#!/usr/bin/env bash
# Browser Isolation — Alma/RHEL 10 orchestrator installer (blank-box ready)
#
# Drop this script on a fresh host and run:
#   sudo bash install-orchestrator.sh
#
# Or from GHCR after login is handled by this script:
#   curl -fsSL … | sudo bash
#   sudo podman run --rm --entrypoint cat \
#     ghcr.io/thecookies/browserisolation:latest /deploy/install-orchestrator.sh | sudo bash
#
# Re-run anytime to pull latest and recreate the container (keeps /etc/browser-isolation/.env).

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
NAME="browser-isolation"
CONFIG_DIR="/etc/browser-isolation"
ENV_FILE="${CONFIG_DIR}/.env"
AUTH_FILE="${AUTH_FILE:-/etc/containers/auth.json}"
HOST_STATE="${HOST_STATE:-/var/lib/browser-isolation}"
PORT="${PORT:-8080}"
WEBRTC_PORT_RANGE="${WEBRTC_PORT_RANGE:-52000-52099}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main}"

# Optional GHCR login. Public packages pull without credentials.
# Private package: GHCR_USER=YourGitHubUsername GHCR_TOKEN=ghp_... sudo -E bash install-orchestrator.sh
GHCR_USER="${GHCR_USER:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
WORKER_ENROLL_TOKEN="rbi_enroll_k9m2Vx7Qp4Hs8nWc3YfL6tZa1Bd0EgR5"
# First-boot portal login (only used when .env does not already exist).
ADMIN_PASSWORD="${ADMIN_PASSWORD:-BrowserIsolation-Admin1}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root (sudo)."; }

ghcr_pull() {
  mkdir -p "$(dirname "${AUTH_FILE}")" "${CONFIG_DIR}"
  if [[ -n "${GHCR_TOKEN}" ]]; then
    [[ -n "${GHCR_USER}" ]] || die "GHCR_TOKEN is set but GHCR_USER is empty"
    echo "==> Logging in to ghcr.io as ${GHCR_USER}"
    umask 077
    echo "${GHCR_TOKEN}" | podman login ghcr.io -u "${GHCR_USER}" \
      --authfile "${AUTH_FILE}" --password-stdin
    chmod 600 "${AUTH_FILE}"
    echo "==> Pulling ${IMAGE}"
    podman pull --authfile "${AUTH_FILE}" "${IMAGE}" \
      || die "failed to pull ${IMAGE} (check GHCR_USER / GHCR_TOKEN and package access)"
    return 0
  fi
  echo "==> Pulling ${IMAGE}"
  podman logout ghcr.io --authfile "${AUTH_FILE}" >/dev/null 2>&1 || true
  podman logout ghcr.io >/dev/null 2>&1 || true
  if podman pull "${IMAGE}"; then
    return 0
  fi
  cat >&2 <<'MSG'
ERROR: failed to pull the image without GHCR login.

A public GitHub repo does not make the container package public.
Make the package public:

  GitHub → Packages → browserisolation → Package settings → Change visibility → Public

Or pull with a classic PAT that has read:packages:

  GHCR_USER=YourGitHubUsername GHCR_TOKEN=ghp_... sudo -E bash install-orchestrator.sh
MSG
  exit 1
}

detect_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
    if [[ -z "${ip}" ]]; then
      ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
    fi
  fi
  if [[ -z "${ip}" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  echo "${ip:-127.0.0.1}"
}

env_get() {
  local key="$1"
  local file="$2"
  awk -F= -v k="${key}" '
    $0 ~ "^" k "=" {
      sub(/^[^=]*=/, "", $0)
      print $0
      exit
    }
  ' "${file}" 2>/dev/null || true
}

env_set() {
  local key="$1"
  local value="$2"
  local file="$3"
  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    awk -F= -v k="${key}" -v v="${value}" '
      BEGIN { done=0 }
      $1 == k && !done { print k "=" v; done=1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "${file}" > "${tmp}"
    mv "${tmp}" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

copy_volume_into() {
  local volume="$1"
  local dest="$2"
  mkdir -p "${dest}"
  podman run --rm --entrypoint cp \
    -v "${volume}:/from:ro" \
    -v "${dest}:/to:Z" \
    "${IMAGE}" -a /from/. /to/
}

ensure_host_state() {
  echo "==> Host data on ${HOST_STATE} (survives container recreate)"
  mkdir -p "${HOST_STATE}/data" "${HOST_STATE}/profiles"
  if [[ ! -f "${HOST_STATE}/data/rbi.sqlite" ]] && podman volume inspect rbi-data >/dev/null 2>&1; then
    echo "==> Copying existing named volume rbi-data to ${HOST_STATE}/data"
    copy_volume_into rbi-data "${HOST_STATE}/data" \
      || echo "WARN: could not copy rbi-data; ${HOST_STATE}/data may start empty"
  fi
  local vol key browser dest
  while IFS= read -r vol; do
    [[ "${vol}" =~ ^rbi-profile-([a-f0-9]{32})-(.+)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    browser="${BASH_REMATCH[2]}"
    dest="${HOST_STATE}/profiles/${key}/${browser}"
    if [[ -d "${dest}" ]] && [[ -n "$(ls -A "${dest}" 2>/dev/null || true)" ]]; then
      continue
    fi
    echo "==> Copying profile volume ${vol} to ${dest}"
    copy_volume_into "${vol}" "${dest}" \
      || echo "WARN: could not copy ${vol}"
  done < <(podman volume ls -q 2>/dev/null || true)
}

ensure_podman_socket() {
  echo "==> Enabling podman.socket"
  if [[ -d /run/podman/podman.sock ]]; then
    echo "WARN: /run/podman/podman.sock is a directory (bad prior mount); removing"
    rm -rf /run/podman/podman.sock
  fi
  systemctl enable --now podman.socket
  systemctl restart podman.socket
  sleep 1
  [[ -S /run/podman/podman.sock ]] || die "podman.socket missing — check: systemctl status podman.socket"
  if ! curl -fsS --max-time 3 --unix-socket /run/podman/podman.sock http://d/_ping >/dev/null 2>&1 \
    && ! curl -fsS --max-time 3 --unix-socket /run/podman/podman.sock http://d/v4.0.0/libpod/_ping >/dev/null 2>&1; then
    die "podman.socket not answering — check: systemctl status podman.socket"
  fi
  echo "    podman.socket OK"
}

free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  fi
  if command -v ss >/dev/null 2>&1; then
    local pids
    pids="$(ss -lptn "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u || true)"
    for pid in ${pids}; do
      kill -9 "${pid}" >/dev/null 2>&1 || true
    done
  fi
}

install_auto_update() {
  if [[ "${DISABLE_AUTO_UPDATE:-}" == "1" ]]; then
    echo "==> Skipping auto-update timer (DISABLE_AUTO_UPDATE=1)"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "WARN: systemd not found; auto-update timer not installed"
    return 0
  fi
  local tmp src=""
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [[ -n "${here}" && -f "${here}/auto-update.sh" ]]; then
    src="${here}/auto-update.sh"
  else
    tmp="$(mktemp)"
    if podman run --rm --entrypoint cat "${IMAGE}" /deploy/auto-update.sh > "${tmp}" 2>/dev/null \
      && grep -q "browser-isolation-update.timer" "${tmp}"; then
      src="${tmp}"
    elif curl -fsSL "${REPO_RAW}/deploy/podman/auto-update.sh" -o "${tmp}" 2>/dev/null \
      && grep -q "browser-isolation-update.timer" "${tmp}"; then
      src="${tmp}"
    else
      rm -f "${tmp}"
      echo "WARN: could not fetch auto-update.sh; timer not installed"
      return 0
    fi
  fi
  bash "${src}" --install-timer
  [[ -n "${tmp:-}" && -f "${tmp:-}" ]] && rm -f "${tmp}"
}

open_firewall_ports() {
  local ports=("$@")
  if ! command -v firewall-cmd >/dev/null 2>&1; then
    echo "==> Installing firewalld"
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y firewalld
    elif command -v yum >/dev/null 2>&1; then
      yum install -y firewalld
    else
      echo "WARN: firewall-cmd not available; skipping firewall rules"
      return 0
    fi
  fi
  systemctl enable --now firewalld >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet firewalld; then
    echo "WARN: firewalld not active; skipping firewall rules"
    return 0
  fi
  echo "==> Opening firewall ports: ${ports[*]}"
  local p
  for p in "${ports[@]}"; do
    firewall-cmd --permanent --add-port="${p}" >/dev/null || true
  done
  firewall-cmd --reload >/dev/null || true
}

need_root

echo "==> Browser Isolation orchestrator installer"
echo "    Image: ${IMAGE}"

if ! command -v podman >/dev/null 2>&1; then
  echo "==> Installing podman + curl"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y podman curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y podman curl
  else
    die "podman not found and no dnf/yum available"
  fi
fi
command -v curl >/dev/null 2>&1 || die "curl is required"

ensure_podman_socket

ghcr_pull
ensure_host_state

PUBLIC_IP="${PUBLIC_IP:-}"
EXISTING=0
if [[ -f "${ENV_FILE}" ]]; then
  EXISTING=1
  echo "==> Keeping existing ${ENV_FILE}"
  PUBLIC_IP="$(env_get PUBLIC_IP "${ENV_FILE}")"
  PUBLIC_IP="${PUBLIC_IP:-$(detect_ip)}"
  # Heal critical runtime keys on every re-run.
  env_set DOCKER_SOCKET /run/podman/podman.sock "${ENV_FILE}"
  env_set WORKER_ENROLL_TOKEN "${WORKER_ENROLL_TOKEN}" "${ENV_FILE}"
  env_set LOCAL_WORKER_ENABLED true "${ENV_FILE}"
  env_set BROWSER_NETWORK_MODE host "${ENV_FILE}"
  env_set PUBLIC_IP "${PUBLIC_IP}" "${ENV_FILE}"
  env_set PROFILE_DATA_DIR "${HOST_STATE}/profiles" "${ENV_FILE}"
  env_set DATABASE_PATH /data/rbi.sqlite "${ENV_FILE}"
else
  PUBLIC_IP="$(detect_ip)"
  echo "==> Creating ${ENV_FILE} (PUBLIC_IP=${PUBLIC_IP})"
  umask 077
  cat > "${ENV_FILE}" <<EOF
# Generated by deploy/podman/install-orchestrator.sh — $(date -u +%Y-%m-%dT%H:%MZ)
PORT=${PORT}
HOST=0.0.0.0
TRUST_PROXY=false
COOKIE_SECURE=false
SESSION_TTL_HOURS=24
BCRYPT_ROUNDS=12
DATABASE_PATH=/data/rbi.sqlite
STATIC_DIR=/app/web/dist
NODE_ENV=production
AUTH_USERS=admin:${ADMIN_PASSWORD}:admin
SAML_ENABLED=false
ENABLED_BROWSERS=google-chrome,firefox,brave
NEKO_IMAGE_TAG=latest
PERSIST_PROFILES_ENABLED=true
PROFILE_DATA_DIR=${HOST_STATE}/profiles
ALLOW_CLIPBOARD=false
ALLOW_DOWNLOADS=false
LOCAL_WORKER_ENABLED=true
WORKER_ENROLL_TOKEN=${WORKER_ENROLL_TOKEN}
BROWSER_NETWORK=rbi-browsers
BROWSER_NETWORK_MODE=host
BROWSER_SHM_SIZE=2gb
BROWSER_CPUS=3
BROWSER_MEMORY=2g
DOCKER_SOCKET=/run/podman/podman.sock
PUBLIC_IP=${PUBLIC_IP}
WEBRTC_PORT_RANGE=${WEBRTC_PORT_RANGE}
WEBRTC_ICELITE=true
ICE_SERVERS_FRONTEND=[]
ICE_SERVERS_BACKEND=[]
DESKTOP_SCREEN=1280x720@30
CAPTURE_VIDEO_CODEC=h264
IDLE_TIMEOUT_MINUTES=60
MAX_SESSION_HOURS=12
REAPER_INTERVAL_SECONDS=60
EOF
  chmod 600 "${ENV_FILE}"
  printf '%s\n' "${ADMIN_PASSWORD}" > "${CONFIG_DIR}/admin-password.txt"
  chmod 600 "${CONFIG_DIR}/admin-password.txt"
fi

echo "==> Stopping any previous ${NAME} / freeing port ${PORT}"
systemctl stop browser-isolation.service >/dev/null 2>&1 || true
podman rm -f "${NAME}" >/dev/null 2>&1 || true
free_port "${PORT}"

echo "==> Starting ${NAME} (host network)"
podman run -d \
  --name "${NAME}" \
  --restart=always \
  --label io.containers.autoupdate=registry \
  --network=host \
  --privileged \
  --security-opt label=disable \
  -v "${CONFIG_DIR}:/config:Z" \
  -v "${HOST_STATE}:/var/lib/browser-isolation:Z" \
  -v "${HOST_STATE}/data:/data:Z" \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e DOCKER_SOCKET=/run/podman/podman.sock \
  -e RBI_ROLE=orchestrator \
  "${IMAGE}"

open_firewall_ports \
  "${PORT}/tcp" \
  "52000-52099/tcp" \
  "52000-52099/udp"

install_auto_update

echo "==> Waiting for health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

echo
if [[ "${ok}" -eq 1 ]]; then
  echo "DONE. Open:  http://${PUBLIC_IP}:${PORT}"
  if [[ "${EXISTING}" -eq 1 ]]; then
    echo "Login:       existing admin password in ${ENV_FILE}"
  else
    echo "Login:       admin / ${ADMIN_PASSWORD}"
    echo "Password also saved at: ${CONFIG_DIR}/admin-password.txt"
  fi
  echo
  echo "Auto-update:  every 5 minutes after you push to main (GHCR :latest)"
  echo "              systemctl status browser-isolation-update.timer"
  echo "Update now:   sudo systemctl start browser-isolation-update.service"
  echo "Worker hosts:"
  echo "  sudo bash install-worker.sh"
  echo "  # prompt for this orchestrator IP/URL: ${PUBLIC_IP}"
else
  echo "Container started but health check failed."
  echo "Check: sudo podman ps -a; sudo podman logs ${NAME}"
  exit 1
fi
