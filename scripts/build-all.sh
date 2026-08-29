#!/usr/bin/env bash
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

scripts/build-ts.sh
cargo build --manifest-path crates/Cargo.toml
pnpm --filter @reflexion-os-studio/desktop build
