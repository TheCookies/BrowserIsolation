#!/usr/bin/env bash
# Back-compat wrapper — prefer the auto-update timer, or re-run the installer.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-orchestrator.sh" "$@"
