#!/usr/bin/env bash
set -euo pipefail

pnpm test:ts
pnpm --filter @reflexion-os-studio/desktop typecheck
cargo test --manifest-path crates/Cargo.toml
