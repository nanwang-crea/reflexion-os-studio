#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @reflexion-os-studio/contracts build
pnpm --filter @reflexion-os-studio/runtime-client build
pnpm --filter @reflexion-os-studio/runtime build
pnpm --filter @reflexion-os-studio/desktop build:frontend
