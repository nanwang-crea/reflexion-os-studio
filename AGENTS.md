# AGENTS.md — ReflexionOS Studio Agent 开发规范

本文件供 AI Agent 与人类开发者共同遵守，沉淀自实际开发过程。架构总纲见 `ARCHITECTURE.md`，分阶段范围见 `docs/ROADMAP.md`；本文件只写"做事的规则"。

## 1. 项目概览与当前阶段

```text
React Renderer → Tauri Host → TypeScript Runtime → Rust System Services
                                        ↘ SQLite / Event Store
```

- 桌面宿主是 **Tauri 2**（已从 Electron 迁移），不是 Electron。任何文档或代码里残留的 Electron 假设都应视为待清理项。
- 当前已完成 **Phase 1A**（M0 启动骨架 → 1A-1 Chat Core → 1A-2 System Tools）、**Phase 1B 第一部分（Workspace Surface）** 与 **Phase 2 的 Skills / Memory 子集**：
  - **Chat**：Provider 配置与密钥存储、Project/Session/Message/Run、SSE 流式（正文+思考）、Stop/Retry/错误恢复、发送队列（回复中自动排队，可修改/删除/立即发送）、重启后历史仍在；
  - **Tools**：纯 TS 工具（时间 / web.fetch / skill.use）+ Rust 工具（file.read/list/glob/grep/write/edit/delete/move/mkdir、shell.execute），workspace / read-only 权限 Profile、审批卡（once / session）、会话级授权、工具轨迹聚合展示；
  - **Skills**：内置 code-review / web-research / workspace-report；斜杠命令激活 + skill.use 工具加载全文；
  - **Memory**：Run 结束后自动提取-合并（会话/项目级，user 级待确认流程落地前不产出候选项）、记忆管理页、上下文召回注入；
  - **Workspace（Phase 1B 第一部分）**：异步 Indexer（progress/cancel/stale/failed、忽略目录与符号链接、快照落库）、文件树按需加载、只读代码/文档查看器（行号/复制/跳转行/分段加载/Markdown·JSON 预览），全部经 Rust 侧 workspace 边界；
  - **存储**：`node:sqlite`（WAL、外键、启动把未完成 Run/Message 恢复为 interrupted、终态单事务、workspace_index 快照表）。
- **尚未实现、不得提前实现**：Phase 1B 剩余（Git Diff、Asset/Artifact Card、ResourceLink、Browser Surface）、Phase 2 剩余（MCP、Provider/Tool 插件、Browser 工具、user 级记忆写入确认）、Phase 3 多 Agent、Phase 4 Workflow、Phase 5 多模态、Phase 6 硬化与激活码许可。
- 现有页面与占位边界：聊天区、落地页、技能页、记忆管理页、设置页（Provider）均为独立页面；工作区（索引状态+文件树+查看器）是对话区的**右侧可开合面板**（顶栏文件夹按钮切换，局部状态记忆），不是独立页；Automations 页是 Phase 4 占位（文案如实标注"尚未开放"），不要在占位页假装能力存在。

## 2. 目录结构与职责

| 路径                       | 职责                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/desktop/frontend/`   | WebView 前端（Vite + TypeScript），通过 `@tauri-apps/api` 的 `invoke`/`listen` 通信      |
| `apps/desktop/src-tauri/`  | Tauri Rust 宿主：窗口、白名单 command/event、sidecar supervisor                          |
| `apps/runtime/`            | TypeScript Runtime（Node sidecar，stdio JSON-RPC）                                       |
| `packages/contracts/`      | 跨进程协议类型的**唯一真源**，新增协议先改这里                                           |
| `packages/agent-core/`     | Agent 循环内核（内部 SDK）：runAgentLoop / ToolRegistry / 上下文压缩，不碰 SQLite 与传输 |
| `packages/runtime-client/` | 前端唯一 typed facade，不得绕过它直连任何进程                                            |
| `packages/*`（其余）       | 仅 README 占位，不要在其中堆放实现代码                                                   |
| `crates/system-runtime/`   | Rust System Runtime sidecar（独立 Cargo workspace，根目录 `Cargo.toml` 不存在）          |
| `scripts/`                 | bash 构建编排                                                                            |
| `docs/`                    | 设计文档；改架构先改文档                                                                 |

依赖方向硬约束：`contracts → all`；`desktop → runtime-client`；`runtime → contracts/SDK`。反向依赖即返工。

## 3. 架构红线（违反即错误实现）

1. **stdout 只传 JSON-RPC 协议消息，stderr 只写日志**。newline-delimited、单行 JSON。
2. 前端不得直接访问 Node API、文件系统、Provider、数据库或 sidecar 原始 stdio；只能调用 Tauri 白名单 command（当前：`bootstrap_get_state`、`runtime_request`）。
3. Runtime 不依赖 Tauri/桌面宿主/React；宿主不实现业务逻辑。
4. 不用固定 localhost HTTP 做进程间通信。
5. Chat 不因 Rust 未 ready 阻塞：`system-degraded` 是降级不是 `error`；`runtime.ready` 才代表 Chat 可用。
6. Tauri Host 与 `crates/system-runtime` 职责分离：前者是窗口 + supervisor，后者是未来系统工具边界，不得合并。
7. 激活/登录属后续阶段（见 `docs/AUTH-AND-LICENSING.md`）：当前不实现任何授权门禁；`license.*` 命令、`licensing` capability、`activation-required` 状态为保留命名，不得挪用；激活失败是门禁状态，不是 `error`，不得影响 sidecar 健康语义。
8. **全平台优先**：项目整体必须跨 macOS / Windows / Linux。设计或实现任何新功能时必须回答"三个平台分别如何工作"，禁止只针对单一平台实现后"再补移植"；平台差异必须显式分支或抽象，不允许隐含 POSIX 或 Windows 假设（详见第 8 节）。

## 4. 代码风格

- **TypeScript**：`strict`；格式由 Prettier 统一（单引号、无分号、2 空格、trailing comma、行宽 80，配置在 `.prettierrc.json`）。跑 `pnpm format:check` / `pnpm format`。
- **TypeScript 模块解析**：Node 侧用 NodeNext（根 `tsconfig.json`）；前端用 Bundler + DOM lib（`apps/desktop/tsconfig.json`）。两套 tsconfig 不要互相污染（根配置已排除 `apps/desktop/frontend`）。
- **Rust**：rustfmt 默认风格（`cargo fmt`），协议数据用 `serde_json::Value`/`json!`。
- **Shell**：`#!/usr/bin/env bash` + `set -euo pipefail`；脚本基于自身位置定位仓库根，不假设 cwd。
- 状态枚举与协议类型复用 `packages/contracts` 与 `apps/desktop` 既有定义，不要在各处重复手写近似类型。
- 契约统一用 zod 定义（`packages/contracts/src/`），TS 类型用 `z.infer` 派生、JSON Schema 用 `z.toJSONSchema` 导出；禁止在 schema 之外手写平行的接口类型或校验逻辑。
- **存储**：MVP 用 Node 内置 `node:sqlite`（无原生依赖），数据目录 `REFLEXION_DATA_DIR` ?? `~/.reflexion-os-studio`；外键开启；Run/Message 终态写入用单事务；启动时把未完成 Run/Message 恢复为 `interrupted`。
- **Secret 纪律**：API Key 等机密只经 `provider.configure` 的只写 `secret` 参数出现一次，落入数据目录 `secrets.json`（0600），其余任何地方只出现 `secretRef`；secret 不得进入响应、事件、日志或错误详情。
- **前端访问 Runtime 的唯一通道**：`runtime-client` 的 `RuntimeTransport`（Tauri 白名单 command `runtime_request` + `bootstrap:message` 事件按 id 关联）；新增业务命令需同步更新 Rust 侧白名单数组。
- **按职责拆分（硬规则，新代码先拆再写）**：不先写大文件再事后补拆。
  - 一个文件只承载一个职责；TypeScript 单文件超过约 300 行即应拆分，**500 行是硬上限**；本次变更中发现超纲文件就在当次拆掉，不留"以后再拆"。
  - **Runtime 存储**：`store/` 按领域分文件（projects / sessions / messages / runs / providers / toolCalls 各一个类），schema 与版本迁移独立在 `store/migrations.ts`，共享工具在 `store/shared.ts`，`store/index.ts` 只做门面（连接、事务边界、启动恢复编排）。业务代码只调领域方法（如 `store.sessions.list(null)`），不直接写 SQL。
  - **Runtime Agent**：`agent/` 按职责分文件——`prompts/`（一个 prompt 一个文件，禁止在代码里内联长 prompt）、`context.ts`（历史重建与压缩）、`permissions.ts`（权限策略表 + ApprovalGateway + PermissionGate）、`tools.ts`（按 Run 装配工具，Rust 工具经 SystemRuntimeClient）、`runner.ts`（Run 编排：循环+持久化+事件+审批+取消）、`errors.ts`、`title.ts`，`agent/index.ts` 只做命令门面。循环算法本身在 `packages/agent-core`，不得把 SQLite/传输细节漏进去。
  - **前端请求**：组件不得直接 `transport.request`。统一走 `api/` 层并按功能分文件（projects / sessions / chat / providers / client），`requestId` 由 api 层自动注入；组件调用具名函数（如 `createSession(projectId)`）。
  - **前端目录结构**：`apps/desktop/frontend/` 按功能模块分包，禁止根目录平铺组件/样式/hooks。
    - `features/<name>/`：一个功能模块一个目录（chat / landing / memories / skills / settings / automations），模块内放页面组件 + 仅该模块使用的子组件 + 该模块 CSS（如 `features/chat/chat.css`、`features/settings/settings.css`）。
    - `components/`：跨功能模块复用的共享组件（如 `Composer`、`SessionRow`、`Sidebar`、`ConfirmDialog`）。
    - `hooks/`：应用级/跨模块 hooks（如 `useAppBootstrap`、`useModelSelection`、`useSessionActions`）。
    - `api/`：唯一请求层，按领域分文件；`lib/`：传输与基础设施（如 `transport.ts`）；`styles/`：全局 base 与布局样式（如 `style.css`、`sidebar.css`）；`ui/`：通用图标等纯展示资源。
    - 仅被单个功能模块引用的组件/样式归 `features/` 对应模块，不放进 `components/`；被两个以上模块引用才上移共享目录，避免"每个模块都有一份"或"共享目录堆积模块私货"。
  - 拆分以"职责"为界而不是"行数均摊"：领域、页面、传输层各自的内聚单元独立成文件，避免把不相关逻辑凑进同一个文件。
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
pnpm lint                  # ESLint(前端 react-hooks 依赖纪律 + TS 基础规则)
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

- **宿主 sidecar 监管**：后台启动 `apps/desktop/src-tauri/target/release/reflexion-desktop`，数秒后用 `pgrep -fl` 确认 `node …/apps/runtime/dist/index.js` 与 `reflexion-system-runtime` 两个进程存在（Rust 由 TS spawn 监管，Host 只握进程树兜底收割权）；TERM 宿主后再次 pgrep 确认无孤儿进程。

## 8. 跨平台纪律（红线第 8 条的落地清单）

原则：**主开发平台是 macOS（ARM），但交付目标是 macOS / Windows / Linux 三平台**。新功能的设计评审、实现和测试都要过一遍下面清单；发现平台相关假设时当场显式处理，而不是留待"以后移植"。

- **路径**：一律用 `PathBuf`/`Path::join`、`node:path`，禁止手拼 `/` 或 `\`；数据目录等用户路径不硬编码分隔符。
- **可执行文件**：查找外部二进制时同时尝试带/不带 `.exe` 后缀（sidecar 查找已内置该行为，改动时保持）。
- **进程生命周期**：`SIGTERM` 在 Windows 上不存在，`kill()` 等价于 TerminateProcess；优雅关闭必须依赖协议 shutdown（如 `runtime.shutdown`）而非信号，信号只作兜底。
- **权限与密钥落盘**：POSIX 的 0600 权限在 Windows（NTFS ACL）上语义不同——密钥存储代码要把平台差异收敛在 `secrets` 模块内，不散落调用点。
- **编码与换行**：文件与协议统一 UTF-8 无 BOM；协议换行固定 `\n`（newline-delimited JSON），读取侧不要依赖 CRLF/LF 平台默认。
- **系统依赖**：Linux 运行需要 `webkit2gtk`，Windows 依赖 WebView2（Win10/11 多数自带）；新增系统依赖时在文档记录三平台差异。
- **脚本**：bash 脚本仅用于开发编排；产品逻辑不得写成 bash-only。跨平台工具逻辑进 Node/Rust。
- **分发**：安装包（.app/.dmg、.msi、.deb/AppImage）在对应平台分别构建（CI 矩阵），Tauri 不支持交叉打包；签名/公证属 Phase 6，当前 `bundle.active = false`，`tauri build` 只产出宿主二进制。

## 9. 变更纪律

- 格式化与重构分离：格式化提交只动排版；本次会话规则是"格式化不改运行时行为、不引入逻辑重构"。
- 修复问题前先确认证据支持该动作（如 PATH 问题与"未安装"是两类问题）。
- 每次交付说明：通过了什么验证、跳过了什么及原因，不夸大完成度。
- 核心模块超过约 300–500 行时重新审视职责拆分（`ARCHITECTURE.md` 验收标准）；新代码的拆分要求见第 4 节"按职责拆分"，不满足即返工。
