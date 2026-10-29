#!/usr/bin/env bash
# Browser Isolation — update an existing Alma/RHEL worker
#
# Pulls the latest app image and recreates browser-isolation-worker.
# Keeps /etc/browser-isolation/.env (no orchestrator prompt).
#
# Usage:
#   sudo bash update-worker.sh
#   sudo bash update-worker.sh --no-pull
#   IMAGE=ghcr.io/thecookies/browserisolation:v1.2.3 sudo -E bash update-worker.sh
#
# From the published image:
#   sudo podman run --rm --entrypoint cat \
#     ghcr.io/thecookies/browserisolation:latest /deploy/update-worker.sh | sudo bash

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
NAME="browser-isolation-worker"
CONFIG_DIR="/etc/browser-isolation"
ENV_FILE="${CONFIG_DIR}/.env"
AUTH_FILE="${AUTH_FILE:-/etc/containers/auth.json}"
WORKER_PORT_DEFAULT=8090
WEBRTC_PORT_RANGE_DEFAULT="52000-52099"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main}"
HOST_STATE="${HOST_STATE:-/var/lib/browser-isolation}"

# Optional GHCR login. Public packages pull without credentials.
GHCR_USER="${GHCR_USER:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root (sudo)."; }

ghcr_pull() {
  mkdir -p "$(dirname "${AUTH_FILE}")"
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

  GHCR_USER=YourGitHubUsername GHCR_TOKEN=ghp_... sudo -E bash update-worker.sh
MSG
  exit 1
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
  echo "==> Ensuring podman.socket"
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
    echo "==> firewall-cmd not available; skipping firewall rules"
    return 0
  fi
  systemctl enable --now firewalld >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet firewalld; then
    echo "WARN: firewalld not active; skipping firewall rules"
    return 0
  fi
  echo "==> Ensuring firewall ports: ${ports[*]}"
  local p
  for p in "${ports[@]}"; do
    firewall-cmd --permanent --add-port="${p}" >/dev/null || true
  done
  firewall-cmd --reload >/dev/null || true
}

remove_named_containers() {
  local id
  # Exact name first, then any leftover filter matches (crash-loop renames).
  podman rm -f "${NAME}" >/dev/null 2>&1 || true
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    podman rm -f "${id}" >/dev/null 2>&1 || true
  done < <(podman ps -aq --filter "name=${NAME}" 2>/dev/null || true)
}

wait_for_health() {
  local attempts="${1:-45}"
  local i
  for i in $(seq 1 "${attempts}"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${WORKER_PORT}/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

image_short_id() {
  local ref="$1"
  podman image inspect --format '{{.Id}}' "${ref}" 2>/dev/null | cut -c1-12 || true
}

do_pull=1
for arg in "$@"; do
  case "${arg}" in
    --no-pull) do_pull=0 ;;
    -h|--help)
      echo "Usage: sudo bash update-worker.sh [--no-pull]"
      echo "  Pulls ${IMAGE} and recreates ${NAME}."
      echo "  Preserves ${ENV_FILE}."
      exit 0
      ;;
    *)
      die "Unknown argument: ${arg} (try --help)"
      ;;
  esac
done

need_root

echo "==> Browser Isolation worker update"
echo "    Image: ${IMAGE}"

[[ -f "${ENV_FILE}" ]] || die "missing ${ENV_FILE} — run install-worker.sh first"
role="$(env_get RBI_ROLE "${ENV_FILE}")"
if [[ -n "${role}" && "${role}" != "worker" ]]; then
  die "${ENV_FILE} has RBI_ROLE=${role}; this host does not look like a worker"
fi

WORKER_PORT="$(env_get WORKER_PORT "${ENV_FILE}")"
WORKER_PORT="${WORKER_PORT:-${WORKER_PORT_DEFAULT}}"
WORKER_ID="$(env_get WORKER_ID "${ENV_FILE}")"
ORCHESTRATOR_URL="$(env_get ORCHESTRATOR_URL "${ENV_FILE}")"
PUBLIC_IP="$(env_get PUBLIC_IP "${ENV_FILE}")"
WORKER_ENROLL_TOKEN="$(env_get WORKER_ENROLL_TOKEN "${ENV_FILE}")"
WORKER_BASE_URL="$(env_get WORKER_BASE_URL "${ENV_FILE}")"
WEBRTC_PORT_RANGE="$(env_get WEBRTC_PORT_RANGE "${ENV_FILE}")"
WEBRTC_PORT_RANGE="${WEBRTC_PORT_RANGE:-${WEBRTC_PORT_RANGE_DEFAULT}}"
[[ -n "${WORKER_BASE_URL}" ]] || WORKER_BASE_URL="http://${PUBLIC_IP:-127.0.0.1}:${WORKER_PORT}"
mkdir -p "${HOST_STATE}/profiles"
env_set PROFILE_DATA_DIR "${HOST_STATE}/profiles" "${ENV_FILE}"

command -v podman >/dev/null 2>&1 || die "podman not found — run install-worker.sh first"
command -v curl >/dev/null 2>&1 || die "curl is required"

ensure_podman_socket

active_browsers="$(podman ps -q --filter "label=rbi.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${active_browsers}" =~ ^[1-9] ]]; then
  echo "WARN: ${active_browsers} managed browser container(s) still running on this host."
  echo "      Updating the worker agent usually leaves them running, but active sessions may"
  echo "      briefly lose control-plane contact until the new agent is healthy."
fi

before_id="$(image_short_id "${IMAGE}")"

if [[ "${do_pull}" -eq 1 ]]; then
  ghcr_pull
else
  echo "==> Skipping image pull (--no-pull)"
  podman image exists "${IMAGE}" || die "image not present locally: ${IMAGE} (omit --no-pull, or set IMAGE=…)"
fi

after_id="$(image_short_id "${IMAGE}")"
if [[ -n "${before_id}" && -n "${after_id}" && "${before_id}" == "${after_id}" && "${do_pull}" -eq 1 ]]; then
  echo "    Image unchanged (${after_id}) — recreating container anyway"
elif [[ -n "${after_id}" ]]; then
  echo "    Image id: ${after_id}${before_id:+ (was ${before_id})}"
fi

echo "==> Stopping ${NAME} / freeing port ${WORKER_PORT}"
systemctl stop browser-isolation-worker.service >/dev/null 2>&1 || true
remove_named_containers
free_port "${WORKER_PORT}"

echo "==> Starting ${NAME} (host network, existing ${ENV_FILE})"
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
  "${WEBRTC_PORT_RANGE}/tcp" \
  "${WEBRTC_PORT_RANGE}/udp"

echo "==> Waiting for worker health"
if ! wait_for_health 45; then
  echo "Container started but health check failed."
  echo "Check: sudo podman ps -a; sudo podman logs ${NAME}"
  exit 1
fi

if [[ -n "${ORCHESTRATOR_URL}" && -n "${WORKER_ENROLL_TOKEN}" && -n "${WORKER_ID}" && -n "${PUBLIC_IP}" ]]; then
  echo "==> Re-enrolling with orchestrator (${ORCHESTRATOR_URL})"
  ENROLL_JSON=""
  if ENROLL_JSON="$(curl -fsS --max-time 15 \
    -X POST \
    -H "Authorization: Bearer ${WORKER_ENROLL_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"workerId\":\"${WORKER_ID}\",\"baseUrl\":\"${WORKER_BASE_URL}\",\"publicIp\":\"${PUBLIC_IP}\"}" \
    "${ORCHESTRATOR_URL%/}/api/workers/enroll")"; then
    echo "    enroll OK"
    ASSIGNED_ID="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    [[ -n "${ASSIGNED_ID}" ]] || ASSIGNED_ID="${WORKER_ID}"
    if [[ "${ASSIGNED_ID}" != "${WORKER_ID}" ]]; then
      WORKER_ID="${ASSIGNED_ID}"
      env_set WORKER_ID "${WORKER_ID}" "${ENV_FILE}"
      echo "==> Orchestrator assigned WORKER_ID=${WORKER_ID}; restarting container"
      podman restart "${NAME}" >/dev/null
      wait_for_health 30 || die "worker failed health check after WORKER_ID restart"
    fi
    ENABLED_HINT="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n1)"
  else
    echo "WARN: enroll failed — worker is up; check orchestrator reachability / Admin → Workers" >&2
    ENABLED_HINT=""
  fi
else
  echo "WARN: skipping enroll (ORCHESTRATOR_URL / WORKER_ID / PUBLIC_IP / WORKER_ENROLL_TOKEN incomplete in ${ENV_FILE})" >&2
  ENABLED_HINT=""
fi

install_auto_update

echo
echo "DONE. Worker ${WORKER_ID:-unknown} updated."
echo "    Agent:  ${WORKER_BASE_URL}"
echo "    Image:  ${IMAGE}${after_id:+ (${after_id})}"
echo "    Config: ${ENV_FILE} (unchanged)"
if [[ "${ENABLED_HINT}" == "true" ]]; then
  echo "    Status: authorized"
elif [[ "${ENABLED_HINT}" == "false" ]]; then
  echo "    Status: enrolled / pending — Authorize in Admin → Workers"
fi
echo
echo "Logs:   sudo podman logs -f ${NAME}"
echo "Health: curl -fsS http://127.0.0.1:${WORKER_PORT}/v1/health"
