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
DATA_VOLUME="rbi-data"
PORT="${PORT:-8080}"
WEBRTC_PORT_RANGE="${WEBRTC_PORT_RANGE:-52000-52099}"

# Hardcoded credentials for this deployment.
GHCR_USER="TheCookies"
GHCR_TOKEN="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"
WORKER_ENROLL_TOKEN="rbi_enroll_k9m2Vx7Qp4Hs8nWc3YfL6tZa1Bd0EgR5"
# First-boot portal login (only used when .env does not already exist).
ADMIN_PASSWORD="${ADMIN_PASSWORD:-BrowserIsolation-Admin1}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root (sudo)."; }

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

echo "==> Logging in to ghcr.io as ${GHCR_USER}"
umask 077
mkdir -p "$(dirname "${AUTH_FILE}")" "${CONFIG_DIR}"
echo "${GHCR_TOKEN}" | podman login ghcr.io -u "${GHCR_USER}" \
  --authfile "${AUTH_FILE}" --password-stdin
chmod 600 "${AUTH_FILE}"

echo "==> Pulling ${IMAGE}"
podman pull --authfile "${AUTH_FILE}" "${IMAGE}" || die "failed to pull ${IMAGE}"

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
  --network=host \
  --privileged \
  --security-opt label=disable \
  --authfile "${AUTH_FILE}" \
  -v "${CONFIG_DIR}:/config:Z" \
  -v "${DATA_VOLUME}:/data:Z" \
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e DOCKER_SOCKET=/run/podman/podman.sock \
  -e RBI_ROLE=orchestrator \
  "${IMAGE}"

open_firewall_ports \
  "${PORT}/tcp" \
  "52000-52099/tcp" \
  "52000-52099/udp"

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
  echo "Update later:"
  echo "  sudo bash install-orchestrator.sh"
  echo "Worker hosts:"
  echo "  sudo bash install-worker.sh"
  echo "  # prompt for this orchestrator IP/URL: ${PUBLIC_IP}"
else
  echo "Container started but health check failed."
  echo "Check: sudo podman ps -a; sudo podman logs ${NAME}"
  exit 1
fi
