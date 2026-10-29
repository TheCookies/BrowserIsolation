#!/usr/bin/env bash
# Browser Isolation — one shot from a brand-new Linux VM.
#
#   curl -fsSL https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main/quickstart.sh | sudo bash
#
# Installs Podman, pulls the published image, starts the portal, opens the
# local firewall, and pre-pulls the default browser images.
# Re-run the same command later to pull a newer image and recreate the container.
#
# Podman, not Docker. This path uses host networking and the Podman socket.

set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/TheCookies/BrowserIsolation/main}"
INSTALLER_URL="${INSTALLER_URL:-${REPO_RAW}/deploy/podman/install-orchestrator.sh}"
CONFIG_DIR="/etc/browser-isolation"
ENV_FILE="${CONFIG_DIR}/.env"
PORT="${PORT:-8080}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root: curl -fsSL ${REPO_RAW}/quickstart.sh | sudo bash"

install_podman() {
  echo "==> Installing Podman"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y podman curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y podman curl ca-certificates
  elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y podman curl ca-certificates
  else
    die "No dnf, yum, or apt-get. Use Alma, RHEL, Debian, or Ubuntu."
  fi
  command -v podman >/dev/null 2>&1 || die "podman did not install"
  command -v curl >/dev/null 2>&1 || die "curl did not install"
}

open_ufw() {
  if ! command -v ufw >/dev/null 2>&1; then
    return 0
  fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    return 0
  fi
  echo "==> Opening UFW ports ${PORT}/tcp and 52000-52099 tcp/udp"
  ufw allow "${PORT}/tcp" >/dev/null
  ufw allow 52000:52099/tcp >/dev/null
  ufw allow 52000:52099/udp >/dev/null
}

env_get() {
  local key="$1"
  awk -F= -v k="${key}" '
    $0 ~ "^" k "=" {
      sub(/^[^=]*=/, "", $0)
      print $0
      exit
    }
  ' "${ENV_FILE}" 2>/dev/null || true
}

prepull_browsers() {
  echo "==> Pre-pulling browser images (first Launch will not wait on a download)"
  local images=(
    ghcr.io/m1k1o/neko/google-chrome:latest
    ghcr.io/m1k1o/neko/firefox:latest
    ghcr.io/m1k1o/neko/brave:latest
  )
  local img pid
  local pids=()
  for img in "${images[@]}"; do
    podman pull "${img}" &
    pids+=("$!")
  done
  local fail=0
  for pid in "${pids[@]}"; do
    wait "${pid}" || fail=1
  done
  if [[ "${fail}" -ne 0 ]]; then
    echo "WARN: a browser image failed to pull. The portal is up; Launch will retry that download."
  fi
}

if ! command -v podman >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  install_podman
fi

echo "==> Installing Browser Isolation"
script_path="${BASH_SOURCE[0]:-}"
local_installer=""
if [[ -n "${script_path}" && "${script_path}" != "bash" ]]; then
  candidate="$(cd "$(dirname "${script_path}")" && pwd)/deploy/podman/install-orchestrator.sh"
  if [[ -f "${candidate}" ]]; then
    local_installer="${candidate}"
  fi
fi

if [[ -n "${local_installer}" ]]; then
  bash "${local_installer}"
else
  tmp="$(mktemp)"
  trap 'rm -f "${tmp}"' EXIT
  curl -fsSL "${INSTALLER_URL}" -o "${tmp}"
  bash "${tmp}"
fi

open_ufw
prepull_browsers

public_ip="127.0.0.1"
if [[ -f "${ENV_FILE}" ]]; then
  public_ip="$(env_get PUBLIC_IP)"
  public_ip="${public_ip:-127.0.0.1}"
fi

echo
echo "READY. Open:  http://${public_ip}:${PORT}"
if [[ -f "${CONFIG_DIR}/admin-password.txt" ]]; then
  echo "Login:       admin / $(tr -d '\r\n' < "${CONFIG_DIR}/admin-password.txt")"
else
  echo "Login:       admin password is in ${ENV_FILE} (AUTH_USERS)"
fi
echo
echo "Cloud firewalls (security groups) are separate: allow TCP ${PORT} and TCP+UDP 52000-52099."
echo "Update later with the same curl command."
