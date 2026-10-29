#!/usr/bin/env bash
# Browser Isolation — host auto-update
#
# Default: pull :latest from GHCR and recreate containers labeled
# io.containers.autoupdate=registry if the image digest changed.
#
#   sudo bash auto-update.sh
#   sudo bash auto-update.sh --install-timer
#
# The install scripts enable a systemd timer that runs this every 5 minutes.
# Push to main → GitHub Actions publishes the image → this host picks it up.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/thecookies/browserisolation:latest}"
DEST="${DEST:-/usr/local/sbin/browser-isolation-update}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"

die() { echo "ERROR: $*" >&2; exit 1; }

log() { echo "==> $(date -u +%Y-%m-%dT%H:%MZ) $*"; }

install_timer() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root (sudo)."
  command -v systemctl >/dev/null 2>&1 || die "systemd is required for auto-update"
  local self="${BASH_SOURCE[0]:-}"
  [[ -f "${self}" ]] || die "auto-update.sh must be run from a file (not a pipe)"

  echo "==> Installing auto-update timer (every 5 minutes)"
  install -m 0755 "${self}" "${DEST}"

  cat > "${UNIT_DIR}/browser-isolation-update.service" <<EOF
[Unit]
Description=Update Browser Isolation from GHCR
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${DEST}
EOF

  cat > "${UNIT_DIR}/browser-isolation-update.timer" <<'EOF'
[Unit]
Description=Check GHCR for Browser Isolation updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now browser-isolation-update.timer
  echo "    enabled: browser-isolation-update.timer"
  echo "    run now:  systemctl start browser-isolation-update.service"
  echo "    status:   systemctl status browser-isolation-update.timer"
  echo "    disable:  systemctl disable --now browser-isolation-update.timer"
}

refresh_self() {
  local tmp
  tmp="$(mktemp)"
  if podman run --rm --entrypoint cat "${IMAGE}" /deploy/auto-update.sh > "${tmp}" 2>/dev/null \
    && grep -q "browser-isolation-update.timer" "${tmp}"; then
    install -m 0755 "${tmp}" "${DEST}"
  fi
  rm -f "${tmp}"
}

run_update() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root (sudo)."
  command -v podman >/dev/null 2>&1 || die "podman not found"

  log "pulling ${IMAGE}"
  if ! podman pull "${IMAGE}"; then
    log "pull failed — will retry on the next timer tick"
    exit 1
  fi

  refresh_self

  log "applying registry updates"
  podman auto-update
  podman image prune -f >/dev/null 2>&1 || true
  log "done"
}

case "${1:-}" in
  --install-timer) install_timer ;;
  -h|--help)
    echo "Usage: sudo bash auto-update.sh [--install-timer]"
    exit 0
    ;;
  "") run_update ;;
  *) die "unknown argument: $1" ;;
esac
