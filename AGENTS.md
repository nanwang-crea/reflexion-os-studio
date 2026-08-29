# AGENTS.md — ReflexionOS Studio Agent 开发规范

本文件供 AI Agent 与人类开发者共同遵守，沉淀自实际开发过程。架构总纲见 `ARCHITECTURE.md`，分阶段范围见 `docs/ROADMAP.md`；本文件只写"做事的规则"。

## 1. 项目概览与当前阶段

```text
React Renderer（未来） → Tauri Host → TypeScript Runtime → Rust System Services
                                              ↘ SQLite / Event Store（未来）
```

- 桌面宿主是 **Tauri 2**（已从 Electron 迁移），不是 Electron。任何文档或代码里残留的 Electron 假设都应视为待清理项。
- 当前处于 **M0 Bootstrap** 阶段：只有启动页、两个 sidecar 的生命周期与 JSON-RPC 握手。**没有** Chat、数据库、工具、审批、React UI。不要提前实现后续阶段的能力，也不要让占位文案（如"Chat Core 尚未实现"）与实际能力不符。

## 2. 目录结构与职责

| 路径                       | 职责                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `apps/desktop/frontend/`   | WebView 前端（Vite + TypeScript），通过 `@tauri-apps/api` 的 `invoke`/`listen` 通信 |
| `apps/desktop/src-tauri/`  | Tauri Rust 宿主：窗口、白名单 command/event、sidecar supervisor                     |
| `apps/runtime/`            | TypeScript Runtime（Node sidecar，stdio JSON-RPC）                                  |
| `packages/contracts/`      | 跨进程协议类型的**唯一真源**，新增协议先改这里                                      |
| `packages/runtime-client/` | 前端唯一 typed facade，不得绕过它直连任何进程                                       |
| `packages/*`（其余）       | 仅 README 占位，不要在其中堆放实现代码                                              |
| `crates/system-runtime/`   | Rust System Runtime sidecar（独立 Cargo workspace，根目录 `Cargo.toml` 不存在）     |
| `scripts/`                 | bash 构建编排                                                                       |
| `docs/`                    | 设计文档；改架构先改文档                                                            |

依赖方向硬约束：`contracts → all`；`desktop → runtime-client`；`runtime → contracts/SDK`。反向依赖即返工。

## 3. 架构红线（违反即错误实现）

1. **stdout 只传 JSON-RPC 协议消息，stderr 只写日志**。newline-delimited、单行 JSON。
2. 前端不得直接访问 Node API、文件系统、Provider、数据库或 sidecar 原始 stdio；只能调用 Tauri 白名单 command（当前：`bootstrap_get_state`、`bootstrap_ping`）。
3. Runtime 不依赖 Tauri/桌面宿主/React；宿主不实现业务逻辑。
4. 不用固定 localhost HTTP 做进程间通信。
5. Chat 不因 Rust 未 ready 阻塞：`system-degraded` 是降级不是 `error`；`runtime.ready` 才代表 Chat 可用。
6. Tauri Host 与 `crates/system-runtime` 职责分离：前者是窗口 + supervisor，后者是未来系统工具边界，不得合并。
7. 激活/登录属后续阶段（见 `docs/AUTH-AND-LICENSING.md`）：当前不实现任何授权门禁；`license.*` 命令、`licensing` capability、`activation-required` 状态为保留命名，不得挪用；激活失败是门禁状态，不是 `error`，不得影响 sidecar 健康语义。

## 4. 代码风格

- **TypeScript**：`strict`；格式由 Prettier 统一（单引号、无分号、2 空格、trailing comma、行宽 80，配置在 `.prettierrc.json`）。跑 `pnpm format:check` / `pnpm format`。
- **TypeScript 模块解析**：Node 侧用 NodeNext（根 `tsconfig.json`）；前端用 Bundler + DOM lib（`apps/desktop/tsconfig.json`）。两套 tsconfig 不要互相污染（根配置已排除 `apps/desktop/frontend`）。
- **Rust**：rustfmt 默认风格（`cargo fmt`），协议数据用 `serde_json::Value`/`json!`。
- **Shell**：`#!/usr/bin/env bash` + `set -euo pipefail`；脚本基于自身位置定位仓库根，不假设 cwd。
- 状态枚举与协议类型复用 `packages/contracts` 与 `apps/desktop` 既有定义，不要在各处重复手写近似类型。
- Prettier 不支持的语言（如 shell）不做机械格式化，保持手写整洁即可。

## 5. 生成物纪律（曾真实踩坑）

以下内容**自动生成**：禁止手改、禁止格式化、禁止提交：

- `node_modules/`、`apps/*/dist/`、`apps/*/dist-frontend/`（构建产物）
- `**/target/`（Cargo 产物，两个 workspace 各有 target）
- `**/src-tauri/gen/`（含压缩成单行的 schema JSON，供编辑器补全用，乱是正常现象）

注意 `.gitignore` / `.prettierignore` 必须用 `**/` 前缀（如 `**/target/`）：裸写 `src-tauri/target` 只匹配仓库根，匹配不到 `apps/desktop/src-tauri/`，曾导致生成物漏忽略。新增生成物目录时两份 ignore 文件都要同步。

## 6. 构建与验证流程

改完代码按顺序跑，全部通过才算完成，如实报告失败与跳过项：

```bash
pnpm format:check          # Prettier
pnpm typecheck             # 根级 tsc --noEmit
pnpm --filter @reflexion-os-studio/desktop typecheck   # 前端
pnpm build:packages        # contracts → runtime-client → runtime → 前端
cargo fmt --manifest-path crates/Cargo.toml -- --check
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml   # Tauri 宿主
pnpm build:desktop         # release 宿主二进制（不打包安装器）
```

常用命令：`pnpm dev`（开发模式启动桌面应用）、`pnpm build`（全量）、`pnpm clean`。

环境注意：`cargo` 已写入 `~/.zshrc` 与 `~/.zprofile`（`source "$HOME/.cargo/env"`）；若脚本环境找不到 cargo，先 `source ~/.cargo/env`。

## 7. 冒烟测试模式

- **Rust sidecar 协议**：

  ```bash
  printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"system.ping"}' \
    '{"jsonrpc":"2.0","id":2,"method":"system.shutdown"}' \
    | ./crates/target/debug/reflexion-system-runtime
  ```

  预期：先输出 `system.ready` 通知，再输出两个 id 对应的 result，最后干净退出。

- **宿主 sidecar 监管**：后台启动 `apps/desktop/src-tauri/target/release/reflexion-desktop`，数秒后用 `pgrep -fl` 确认 `node …/apps/runtime/dist/index.js` 与 `reflexion-system-runtime` 两个子进程存在；TERM 宿主后再次 pgrep 确认无孤儿进程。

## 8. 跨平台注意

- 主开发平台 macOS（ARM）；Tauri 本身跨 macOS/Windows/Linux。
- Windows 下 Cargo 产物带 `.exe` 后缀——sidecar 查找逻辑（`src-tauri/src/lib.rs`）已同时尝试带/不带后缀，修改查找逻辑时保持该行为。
- Linux 运行时需要 `webkit2gtk` 系统依赖。
- 安装包签名/公证/sidecar 资源打包属 Phase 6；当前 `bundle.active = false`，`tauri build` 只产出宿主二进制。

## 9. 变更纪律

- 格式化与重构分离：格式化提交只动排版；本次会话规则是"格式化不改运行时行为、不引入逻辑重构"。
- 修复问题前先确认证据支持该动作（如 PATH 问题与"未安装"是两类问题）。
- 每次交付说明：通过了什么验证、跳过了什么及原因，不夸大完成度。
- 核心模块超过约 300–500 行时重新审视职责拆分（`ARCHITECTURE.md` 验收标准）。
