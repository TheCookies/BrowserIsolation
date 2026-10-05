#!/usr/bin/env bash
# Host helper: create or recreate the Browser Isolation container.
# Usage:
#   sudo bash run.sh            # pull + recreate
#   sudo bash run.sh --no-pull  # recreate only
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
NAME="${NAME:-browser-isolation}"
CONFIG_DIR="${CONFIG_DIR:-/etc/browser-isolation}"
AUTH_FILE="${AUTH_FILE:-/etc/containers/auth.json}"
DATA_VOLUME="${DATA_VOLUME:-rbi-data}"
SOCKET="${SOCKET:-/run/podman/podman.sock}"

do_pull=1
for arg in "$@"; do
  case "${arg}" in
    --no-pull) do_pull=0 ;;
    -h|--help)
      echo "Usage: sudo bash run.sh [--no-pull]"
      exit 0
      ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

if [[ ! -S "${SOCKET}" ]]; then
  echo "Enabling podman.socket..."
  systemctl enable --now podman.socket
fi

mkdir -p "${CONFIG_DIR}"

if [[ "${do_pull}" -eq 1 ]]; then
  if [[ -f "${AUTH_FILE}" ]]; then
    podman pull --authfile "${AUTH_FILE}" "${IMAGE}"
  else
    echo "WARN: ${AUTH_FILE} missing; trying pull without authfile" >&2
    podman pull "${IMAGE}"
  fi
fi

podman rm -f "${NAME}" >/dev/null 2>&1 || true

podman run -d \
  --name "${NAME}" \
  --restart=always \
  --network=host \
  -v "${CONFIG_DIR}:/config:Z" \
  -v "${DATA_VOLUME}:/data:Z" \
  -v "${SOCKET}:/var/run/docker.sock" \
  -e DOCKER_SOCKET=/var/run/docker.sock \
  "${IMAGE}"

echo "Started ${NAME}"
echo "Logs (look for admin password on first boot):"
echo "  podman logs -f ${NAME}"
echo "Health:"
echo "  curl -sS http://127.0.0.1:8080/api/health"
