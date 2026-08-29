#!/usr/bin/env bash
set -euo pipefail

scripts/build-ts.sh
node apps/runtime/dist/index.js
