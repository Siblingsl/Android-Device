#!/usr/bin/env bash
# Compatibility wrapper — use build-wsl-binder-kernel.sh (full Docker fixes).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${DIR}/build-wsl-binder-kernel.sh" "$@"
