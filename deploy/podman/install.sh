#!/usr/bin/env bash
# Back-compat wrapper — use install-orchestrator.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-orchestrator.sh" "$@"
