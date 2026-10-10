#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

pnpm -w build:system
scripts/build-ts.sh
node --disable-warning=ExperimentalWarning apps/runtime/dist/index.js
