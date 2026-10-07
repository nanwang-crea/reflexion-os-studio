#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

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
node --test scripts/test/*.test.mjs
# Runtime 集成测试须使用当前源码构建的真实 sidecar，不能命中旧产物或静默跳过。
cargo build --manifest-path crates/Cargo.toml
REFLEXION_SYSTEM_RUNTIME_BIN="$ROOT/crates/target/debug/reflexion-system-runtime"
if [[ -f "$REFLEXION_SYSTEM_RUNTIME_BIN.exe" ]]; then
  REFLEXION_SYSTEM_RUNTIME_BIN="$REFLEXION_SYSTEM_RUNTIME_BIN.exe"
fi
export REFLEXION_SYSTEM_RUNTIME_BIN
pnpm --filter @reflexion-os-studio/contracts test
pnpm --filter @reflexion-os-studio/agent-core test
pnpm --filter @reflexion-os-studio/runtime-client test
pnpm --filter @reflexion-os-studio/runtime test
pnpm --filter @reflexion-os-studio/desktop typecheck
pnpm --filter @reflexion-os-studio/desktop test
cargo test --manifest-path crates/Cargo.toml
node --disable-warning=ExperimentalWarning scripts/smoke-system-channel.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-chat.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-workspace.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-skills.mjs
node --disable-warning=ExperimentalWarning scripts/smoke-store-migration.mjs
# W4-1 终端故障矩阵端到端（attach 超时/退出竞态/序号自愈/崩溃代际/额度回收/项目删除）。
node --disable-warning=ExperimentalWarning scripts/terminal-faults.mjs
# 契约命令与 Tauri 白名单一致性(双份清单的自动防线)。
node scripts/check-whitelist.mjs
