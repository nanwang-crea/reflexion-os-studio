#!/usr/bin/env bash
set -euo pipefail

scripts/build-ts.sh
cargo build --manifest-path crates/Cargo.toml
pnpm --filter @reflexion-os-studio/desktop build
