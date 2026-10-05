#!/usr/bin/env bash
# Browser Isolation — Alma/RHEL worker bootstrap
#
# Run on a fresh worker host (root). Prompts only for the orchestrator host/IP.
# Everything else (Podman, GHCR login, image pulls, enroll) is automatic.
#
#   curl -fsSL http://ORCHESTRATOR:8080/deploy/install-worker.sh | sudo bash
#   # or from a pulled image:
#   sudo podman run --rm --entrypoint cat \
#     ghcr.io/thecookies/browserisolation:latest /deploy/install-worker.sh | sudo bash
#
# After enroll, authorize the worker in Admin → Workers.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
NEKO_TAG="${NEKO_TAG:-latest}"
AUTH_FILE="${AUTH_FILE:-/etc/containers/auth.json}"
CONFIG_DIR="/etc/browser-isolation"
ENV_FILE="${CONFIG_DIR}/.env"
UNIT_DIR="/etc/containers/systemd"
WORKER_PORT="${WORKER_PORT:-8090}"
WEBRTC_PORT_RANGE="${WEBRTC_PORT_RANGE:-52000-52099}"

# Hardcoded credentials (per deployment plan).
GHCR_USER="TheCookies"
GHCR_TOKEN="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"
WORKER_ENROLL_TOKEN="rbi_enroll_k9m2Vx7Qp4Hs8nWc3YfL6tZa1Bd0EgR5"

# Default browser images pulled for a typical worker.
NEKO_IMAGES=(
  "ghcr.io/m1k1o/neko/google-chrome:${NEKO_TAG}"
  "ghcr.io/m1k1o/neko/firefox:${NEKO_TAG}"
  "ghcr.io/m1k1o/neko/brave:${NEKO_TAG}"
)

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
  # Bare host → default portal port.
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
    # Escape sed replacement specials carefully via a temp rewrite.
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
  echo "==> Installing podman"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y podman curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y podman curl
  else
    die "podman not found and no dnf/yum available"
  fi
fi
command -v curl >/dev/null 2>&1 || die "curl is required"

echo "==> Enabling podman.socket"
systemctl enable --now podman.socket
[[ -S /run/podman/podman.sock ]] || die "podman.socket did not create /run/podman/podman.sock"

echo "==> Logging in to ghcr.io as ${GHCR_USER}"
umask 077
mkdir -p "$(dirname "${AUTH_FILE}")"
echo "${GHCR_TOKEN}" | podman login ghcr.io -u "${GHCR_USER}" \
  --authfile "${AUTH_FILE}" --password-stdin
chmod 600 "${AUTH_FILE}"

echo "==> Pulling ${IMAGE}"
podman pull --authfile "${AUTH_FILE}" "${IMAGE}" || die "failed to pull ${IMAGE}"

echo "==> Pulling Neko browser images"
for img in "${NEKO_IMAGES[@]}"; do
  echo "    ${img}"
  podman pull "${img}" || echo "WARN: could not pull ${img} (will retry on first session)"
done

PUBLIC_IP="$(detect_ip)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname || true)"
WORKER_ID="$(sanitize_worker_id "${HOSTNAME_SHORT}")"
[[ -n "${WORKER_ID}" ]] || WORKER_ID="worker-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BASE_URL="http://${PUBLIC_IP}:${WORKER_PORT}"

echo "==> This host: PUBLIC_IP=${PUBLIC_IP} WORKER_ID=${WORKER_ID}"

echo "==> Enrolling with orchestrator"
ENROLL_JSON="$(curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${WORKER_ENROLL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"workerId\":\"${WORKER_ID}\",\"baseUrl\":\"${BASE_URL}\",\"publicIp\":\"${PUBLIC_IP}\"}" \
  "${ORCHESTRATOR_BASE}/api/workers/enroll")" \
  || die "enroll failed — is WORKER_ENROLL_TOKEN set on the orchestrator and is ${ORCHESTRATOR_BASE} reachable?"

WORKER_TOKEN="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
ASSIGNED_ID="$(printf '%s' "${ENROLL_JSON}" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[[ -n "${WORKER_TOKEN}" ]] || die "enroll response missing token: ${ENROLL_JSON}"
[[ -n "${ASSIGNED_ID}" ]] || ASSIGNED_ID="${WORKER_ID}"
WORKER_ID="${ASSIGNED_ID}"

mkdir -p "${CONFIG_DIR}" "${UNIT_DIR}"
umask 077
if [[ -f "${ENV_FILE}" ]]; then
  echo "==> Updating existing ${ENV_FILE}"
  env_set RBI_ROLE worker "${ENV_FILE}"
  env_set WORKER_ID "${WORKER_ID}" "${ENV_FILE}"
  env_set WORKER_TOKEN "${WORKER_TOKEN}" "${ENV_FILE}"
  env_set WORKER_PORT "${WORKER_PORT}" "${ENV_FILE}"
  env_set PUBLIC_IP "${PUBLIC_IP}" "${ENV_FILE}"
  env_set DOCKER_SOCKET /var/run/docker.sock "${ENV_FILE}"
  env_set WEBRTC_PORT_RANGE "${WEBRTC_PORT_RANGE}" "${ENV_FILE}"
  env_set BROWSER_NETWORK_MODE host "${ENV_FILE}"
  env_set NODE_ENV production "${ENV_FILE}"
else
  cat > "${ENV_FILE}" <<EOF
# Generated by deploy/podman/install-worker.sh — $(date -u +%Y-%m-%dT%H:%MZ)
RBI_ROLE=worker
WORKER_ID=${WORKER_ID}
WORKER_TOKEN=${WORKER_TOKEN}
WORKER_PORT=${WORKER_PORT}
PUBLIC_IP=${PUBLIC_IP}
DOCKER_SOCKET=/var/run/docker.sock
WEBRTC_PORT_RANGE=${WEBRTC_PORT_RANGE}
WEBRTC_ICELITE=true
BROWSER_NETWORK_MODE=host
BROWSER_SHM_SIZE=2gb
BROWSER_CPUS=3
BROWSER_MEMORY=2g
NEKO_IMAGE_TAG=${NEKO_TAG}
NODE_ENV=production
EOF
fi
chmod 600 "${ENV_FILE}"
echo "==> Wrote ${ENV_FILE}"

start_worker_podman_run() {
  echo "==> Starting worker with podman run (host network)"
  podman rm -f browser-isolation-worker >/dev/null 2>&1 || true
  podman run -d \
    --name browser-isolation-worker \
    --restart=always \
    --network=host \
    --security-opt label=disable \
    --authfile "${AUTH_FILE}" \
    -v "${CONFIG_DIR}:/config:Z" \
    -v /run/podman/podman.sock:/var/run/docker.sock \
    -e DOCKER_SOCKET=/var/run/docker.sock \
    -e RBI_ROLE=worker \
    "${IMAGE}"
}

# Prefer Quadlet when the generator works; otherwise fall back to podman run.
# Host network is required for WebRTC on Alma / Hyper-V.
cat > "${UNIT_DIR}/browser-isolation-worker.container" <<EOF
[Unit]
Description=Browser Isolation worker agent
After=network-online.target podman.socket
Wants=network-online.target podman.socket

[Container]
Image=${IMAGE}
Pull=always
AuthFile=${AUTH_FILE}
ContainerName=browser-isolation-worker
HostName=browser-isolation-worker
EnvironmentFile=${ENV_FILE}
Environment=HOST=0.0.0.0
Environment=WORKER_PORT=${WORKER_PORT}
Environment=NODE_ENV=production
Environment=DOCKER_SOCKET=/var/run/docker.sock
Environment=RBI_ROLE=worker
Volume=${CONFIG_DIR}:/config:Z
Volume=/run/podman/podman.sock:/var/run/docker.sock
Network=host
PodmanArgs=--init
PodmanArgs=--security-opt=label=disable

[Service]
Restart=always
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wrote Quadlet unit ${UNIT_DIR}/browser-isolation-worker.container"
systemctl daemon-reload
if systemctl cat browser-isolation-worker.service >/dev/null 2>&1; then
  echo "==> Starting browser-isolation-worker.service"
  systemctl restart browser-isolation-worker.service
else
  echo "WARN: Quadlet did not generate browser-isolation-worker.service; using podman run"
  rm -f "${UNIT_DIR}/browser-isolation-worker.container"
  systemctl daemon-reload >/dev/null 2>&1 || true
  start_worker_podman_run
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  echo "==> Opening firewall ports"
  firewall-cmd --permanent --add-port="${WORKER_PORT}/tcp" >/dev/null
  firewall-cmd --permanent --add-port=52000-52099/tcp >/dev/null
  firewall-cmd --permanent --add-port=52000-52099/udp >/dev/null
  firewall-cmd --reload >/dev/null
fi

echo "==> Waiting for worker health"
ok=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${WORKER_PORT}/v1/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

echo
if [[ "${ok}" -eq 1 ]]; then
  echo "DONE. Worker ${WORKER_ID} is connected and pending authorization."
  echo "    Agent:   ${BASE_URL}"
  echo "    Next:    Admin → Workers → Authorize ${WORKER_ID}"
  echo
  echo "Re-run this installer anytime to rotate the worker token and refresh registration."
else
  echo "Worker enrolled but health check did not pass yet."
  echo "Check: sudo podman ps -a; sudo podman logs browser-isolation-worker"
  echo "The worker is still enrolled as pending — authorize it after health recovers."
  exit 1
fi
