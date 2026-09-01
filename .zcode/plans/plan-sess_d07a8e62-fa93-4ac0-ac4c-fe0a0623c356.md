1. 新增 Git 分支只读查询链路：在 `crates/system-runtime` 的 git 服务与 JSON-RPC dispatch 增加 `git.branches`；在 Runtime workspace handler、contracts command registry、前端 `api/workspace.ts` 增加 `workspace.git_branches`，返回 repo 标记、当前分支和本地分支列表。非 Git 项目返回 `repo: false`，查询失败不阻塞新建对话。
2. 扩展会话上下文：给 `Session` 增加 nullable `gitBranch`，在 SQLite sessions 表增加迁移字段，并同步 SessionStore、`session.create` 命令 schema、Runtime handler 与前端 `createSession`。旧数据默认 null，保持兼容。
3. 新建对话 UI：在 `LandingView` 的 Composer 附近增加项目选择（独立对话 + 已有项目），选中项目后加载分支；Git 项目显示分支下拉并默认当前分支，切换项目清除旧分支；加载/失败状态有明确提示。使用普通 HTML select，保证三平台一致。
4. 发送链路：App 持有新建对话的项目/分支选择状态，并通过 LandingView 与 `useSessionActions` 传入；首次发送时 `session.create` 传递 projectId/gitBranch。侧栏进入项目新会话时默认使用该项目当前分支；已有会话不改变当前行为，重开会话可读取保存的 gitBranch。
5. 补充样式与必要测试，检查项目选择和分支选择不影响现有模型、权限、技能和 Composer 行为。
6. 按项目流程运行 `pnpm format:check`、`pnpm lint`、根级及 desktop typecheck、Rust fmt/check/test、前端构建；如环境限制导致步骤失败，准确报告。