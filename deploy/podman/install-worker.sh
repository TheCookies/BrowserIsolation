#!/usr/bin/env bash
# Browser Isolation — Alma/RHEL 10 worker installer (blank-box ready)
#
# Drop this script on a fresh worker host and run:
#   sudo bash install-worker.sh
#   # prompts only for orchestrator host/IP (or set ORCHESTRATOR=10.0.0.2)
#
# Or:
#   sudo podman run --rm --entrypoint cat \
#     ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
#
# Re-run anytime to pull latest, rewrite worker env, re-enroll, and recreate the container.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
NEKO_TAG="${NEKO_TAG:-latest}"
NAME="browser-isolation-worker"
CONFIG_DIR="/etc/browser-isolation"
ENV_FILE="${CONFIG_DIR}/.env"
AUTH_FILE="${AUTH_FILE:-/etc/containers/auth.json}"
WORKER_PORT="${WORKER_PORT:-8090}"
WEBRTC_PORT_RANGE="${WEBRTC_PORT_RANGE:-52000-52099}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main}"
HOST_STATE="${HOST_STATE:-/var/lib/browser-isolation}"

# Optional GHCR login. Public packages pull without credentials.
# Private package: GHCR_USER=YourGitHubUsername GHCR_TOKEN=ghp_... sudo -E bash install-worker.sh
GHCR_USER="${GHCR_USER:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
WORKER_ENROLL_TOKEN="rbi_enroll_k9m2Vx7Qp4Hs8nWc3YfL6tZa1Bd0EgR5"

# Browser images are NOT pulled here. The orchestrator pulls enabled browsers
# onto this host only after the worker is authorized (or re-authorized).

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

  GHCR_USER=YourGitHubUsername GHCR_TOKEN=ghp_... sudo -E bash install-worker.sh
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

ask_tty() {
  local prompt="$1"
  local reply=""
  if [[ -r /dev/tty ]]; then
    # shellcheck disable=SC2162
    read -r -p "${prompt}" reply </dev/tty || true
  fi
  printf '%s' "${reply}"
}

normalize_orchestrator() {
  local raw="$1"
  raw="$(echo "${raw}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's:/*$::')"
  [[ -n "${raw}" ]] || return 1
  if [[ "${raw}" != http://* && "${raw}" != https://* ]]; then
    raw="http://${raw}"
  fi
  if [[ "${raw}" =~ ^https?://[^/:]+$ ]]; then
    raw="${raw}:8080"
  fi
  printf '%s' "${raw}"
}

sanitize_worker_id() {
  local raw="$1"
  echo "${raw}" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9._-]/-/g' -e 's/^-\+//' -e 's/-\+$//' | cut -c1-64
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

echo "==> Browser Isolation worker installer"
echo "    Image: ${IMAGE}"

ORCH_INPUT="${ORCHESTRATOR:-}"
if [[ -z "${ORCH_INPUT}" ]]; then
  ORCH_INPUT="$(ask_tty "Orchestrator host or URL: ")"
fi
ORCHESTRATOR_BASE="$(normalize_orchestrator "${ORCH_INPUT}")" || die "orchestrator host/IP required"
echo "==> Orchestrator: ${ORCHESTRATOR_BASE}"

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

PUBLIC_IP="$(detect_ip)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname || true)"
WORKER_ID="$(sanitize_worker_id "${HOSTNAME_SHORT}")"
[[ -n "${WORKER_ID}" ]] || WORKER_ID="worker-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BASE_URL="http://${PUBLIC_IP}:${WORKER_PORT}"
WORKER_TOKEN="${WORKER_ENROLL_TOKEN}"

echo "==> This host: PUBLIC_IP=${PUBLIC_IP} WORKER_ID=${WORKER_ID}"

umask 077
if [[ -f "${ENV_FILE}" ]]; then
  echo "==> Updating existing ${ENV_FILE}"
else
  echo "==> Creating ${ENV_FILE}"
  : > "${ENV_FILE}"
fi
env_set RBI_ROLE worker "${ENV_FILE}"
env_set WORKER_ID "${WORKER_ID}" "${ENV_FILE}"
env_set WORKER_TOKEN "${WORKER_TOKEN}" "${ENV_FILE}"
env_set WORKER_ENROLL_TOKEN "${WORKER_ENROLL_TOKEN}" "${ENV_FILE}"
env_set ORCHESTRATOR_URL "${ORCHESTRATOR_BASE}" "${ENV_FILE}"
env_set WORKER_BASE_URL "${BASE_URL}" "${ENV_FILE}"
env_set WORKER_PORT "${WORKER_PORT}" "${ENV_FILE}"
env_set PUBLIC_IP "${PUBLIC_IP}" "${ENV_FILE}"
env_set DOCKER_SOCKET /run/podman/podman.sock "${ENV_FILE}"
env_set WEBRTC_PORT_RANGE "${WEBRTC_PORT_RANGE}" "${ENV_FILE}"
env_set WEBRTC_ICELITE true "${ENV_FILE}"
env_set BROWSER_NETWORK_MODE host "${ENV_FILE}"
env_set BROWSER_SHM_SIZE 2gb "${ENV_FILE}"
env_set BROWSER_CPUS 3 "${ENV_FILE}"
env_set BROWSER_MEMORY 2g "${ENV_FILE}"
env_set NEKO_IMAGE_TAG "${NEKO_TAG}" "${ENV_FILE}"
env_set NODE_ENV production "${ENV_FILE}"
env_set PROFILE_DATA_DIR "${HOST_STATE}/profiles" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
echo "==> Wrote ${ENV_FILE}"

mkdir -p "${HOST_STATE}/profiles"
while IFS= read -r vol; do
  [[ "${vol}" =~ ^rbi-profile-([a-f0-9]{32})-(.+)$ ]] || continue
  dest="${HOST_STATE}/profiles/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  if [[ -d "${dest}" ]] && [[ -n "$(ls -A "${dest}" 2>/dev/null || true)" ]]; then
    continue
  fi
  echo "==> Copying profile volume ${vol} to ${dest}"
  mkdir -p "${dest}"
  podman run --rm --entrypoint cp \
    -v "${vol}:/from:ro" \
    -v "${dest}:/to:Z" \
    "${IMAGE}" -a /from/. /to/ \
    || echo "WARN: could not copy ${vol}"
done < <(podman volume ls -q 2>/dev/null || true)

echo "==> Stopping any previous ${NAME} / freeing port ${WORKER_PORT}"
systemctl stop browser-isolation-worker.service >/dev/null 2>&1 || true
podman rm -f "${NAME}" >/dev/null 2>&1 || true
# Also clear any leftover identically named crash-loop containers.
podman rm -f $(podman ps -aq --filter "name=${NAME}" 2>/dev/null) >/dev/null 2>&1 || true
free_port "${WORKER_PORT}"

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
  -v /run/podman/podman.sock:/run/podman/podman.sock \
  -e DOCKER_SOCKET=/run/podman/podman.sock \
  -e RBI_ROLE=worker \
  "${IMAGE}"

open_firewall_ports \
  "${WORKER_PORT}/tcp" \
  "52000-52099/tcp" \
  "52000-52099/udp"

echo "==> Waiting for worker health"
ok=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${WORKER_PORT}/v1/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "${ok}" -ne 1 ]]; then
  echo "Container started but health check failed."
  echo "Check: sudo podman ps -a; sudo podman logs ${NAME}"
  exit 1
fi

install_auto_update

# Enroll only after the agent is listening so probe (and browser pulls) can succeed.
echo "==> Enrolling with orchestrator"
ENROLL_JSON="$(curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${WORKER_ENROLL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"workerId\":\"${WORKER_ID}\",\"baseUrl\":\"${BASE_URL}\",\"publicIp\":\"${PUBLIC_IP}\"}" \
  "${ORCHESTRATOR_BASE}/api/workers/enroll")" \
  || die "enroll failed — is the orchestrator up, and is ${ORCHESTRATOR_BASE} reachable?"

ASSIGNED_ID="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[[ -n "${ASSIGNED_ID}" ]] || ASSIGNED_ID="${WORKER_ID}"
if [[ "${ASSIGNED_ID}" != "${WORKER_ID}" ]]; then
  WORKER_ID="${ASSIGNED_ID}"
  env_set WORKER_ID "${WORKER_ID}" "${ENV_FILE}"
  echo "==> Orchestrator assigned WORKER_ID=${WORKER_ID}; restarting container"
  podman restart "${NAME}" >/dev/null
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${WORKER_PORT}/v1/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  [[ "${ok}" -eq 1 ]] || die "worker failed health check after WORKER_ID restart"
fi
ENABLED_HINT="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n1)"

echo
echo "DONE. Worker ${WORKER_ID} is running."
echo "    Agent:   ${BASE_URL}"
if [[ "${ENABLED_HINT}" == "true" ]]; then
  echo "    Status:  authorized — orchestrator is pulling enabled browser images onto this host"
else
  echo "    Status:  enrolled / pending — Authorize in Admin → Workers to pull browsers"
fi
echo
echo "Auto-update:  every 5 minutes after you push to main (GHCR :latest)"
echo "Update now:   sudo systemctl start browser-isolation-update.service"
echo "Full reinstall / rewrite env:"
echo "  ORCHESTRATOR=${ORCHESTRATOR_BASE} sudo -E bash install-worker.sh"
