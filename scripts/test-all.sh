#!/usr/bin/env bash
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

pnpm lint
pnpm test:ts
pnpm --filter @reflexion-os-studio/contracts test
pnpm --filter @reflexion-os-studio/agent-core test
pnpm --filter @reflexion-os-studio/runtime test
pnpm --filter @reflexion-os-studio/desktop typecheck
cargo test --manifest-path crates/Cargo.toml
# cargo test 只链测试 harness，不保证产出可执行 bin；冒烟前显式构建。
cargo build --manifest-path crates/Cargo.toml
node --disable-warning=ExperimentalWarning scripts/smoke-system-channel.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-chat.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-workspace.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-skills.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-store-migration.mjs
# 契约命令与 Tauri 白名单一致性(双份清单的自动防线)。
node scripts/check-whitelist.mjs
