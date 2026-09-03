#!/usr/bin/env bash
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

# clean checkout 下各包 dist 不存在，而单元测试与 smoke 脚本都从 dist 导入；
# 先构建依赖包（contracts → runtime-client → runtime → 前端），确保产物就绪。
scripts/build-ts.sh
[ -f "apps/runtime/dist/index.js" ] || {
  echo "test-all: apps/runtime/dist/index.js missing after build" >&2
  exit 1
}

pnpm lint
pnpm test:ts
pnpm --filter @reflexion-os-studio/contracts test
pnpm --filter @reflexion-os-studio/agent-core test
pnpm --filter @reflexion-os-studio/runtime-client test
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
