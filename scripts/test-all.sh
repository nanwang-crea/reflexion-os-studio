#!/usr/bin/env bash
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

pnpm test:ts
pnpm --filter @reflexion-os-studio/contracts test
pnpm --filter @reflexion-os-studio/runtime test
pnpm --filter @reflexion-os-studio/desktop typecheck
cargo test --manifest-path crates/Cargo.toml
