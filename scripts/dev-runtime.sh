#!/usr/bin/env bash
set -euo pipefail

scripts/build-ts.sh
node --disable-warning=ExperimentalWarning apps/runtime/dist/index.js
