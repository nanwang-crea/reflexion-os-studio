#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @reflexion-os-studio/contracts build
node scripts/generate-runtime-methods.mjs
pnpm --filter @reflexion-os-studio/agent-core build
pnpm --filter @reflexion-os-studio/runtime-client build
pnpm --filter @reflexion-os-studio/runtime build
pnpm --filter @reflexion-os-studio/desktop build:frontend
