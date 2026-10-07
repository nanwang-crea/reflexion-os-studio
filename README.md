# ReflexionOS Studio

ReflexionOS 的下一代桌面 Agent 与可视化工作流平台。它不是现有 `ReflexionOS` 的直接副本，而是一个以 TypeScript Runtime 为核心、Rust 系统服务为边界、Tauri 为第一阶段宿主的独立架构项目。

## 当前阶段

当前仓库已完成 **Phase 1A**（Bootstrap → Chat Core → System Tools）、**Phase 1B 第一部分（Workspace Surface）**、**Phase 2 的 Skills / Memory / MCP 子集** 与 **Phase 3 动态受控委派子集**：

- **Chat**：OpenAI-compatible Provider 配置与本地密钥存储，Project/Session/Message/Run，SSE 流式回复（含思考过程）、Stop / Retry、**发送队列**（回复中自动排队，可修改/删除/立即发送）、SQLite 持久化与重启恢复；
- **工具**：文件读写/搜索（经 Rust System Runtime）与 Shell、网络抓取、计时器、**MCP 服务器工具**（设置页管理、使用前审批）；workspace / read-only 权限 Profile、工具审批（允许一次 / 本会话允许 / 拒绝）、工具轨迹聚合展示；
- **Skills**：内置 code-review、web-research、workspace-report，斜杠命令（`/code-review …`）与 skill.use 激活；
- **Memory**：AGENTS.md/MEMORY.md 四层文件注入、`memory.remember` 与指令页；不再运行自动提取/合并/召回链路；
- **Workspace**：按项目异步索引（进度/取消/过期状态与统计）、文件树按需加载、代码/文档查看器（行号、复制、跳转行、Markdown/JSON 预览）、Git 状态与写操作，文件访问经 Rust 侧 workspace 边界；
- **Artifacts / Changes**：Run 终态从 canonical ToolOutput 聚合最终交付资源与 Changed Files，分别以 Artifact 卡和折叠变更摘要展示，并支持 workspace/asset/https 资源引用；
- **Multi-Agent**：Primary 通过 `task` 动态创建受控子 Agent；子 Run 隔离上下文、继承权限交集，可在预算内继续委派；根级 mutation coordinator 串行化兄弟写入，revision 冲突显式失败并记录变更归属；
- **UI**：项目/会话侧栏、聊天区（含右侧可开合的工作区面板）、落地页、技能页、指令页、Provider 设置页、委派运行卡与 Artifact/Changed Files 展示。

尚未实现（见 `docs/ROADMAP.md`）：只读内嵌 Browser 与 Browser Tool、Provider/Tool 动态插件、更完整的资产检索、Workflow Engine、多模态、激活码许可；Phase 3 的更完整跨层恢复与高级变更治理仍待后续。

## 常用命令

```bash
pnpm dev          # 开发模式启动桌面应用
pnpm build        # 全量构建
pnpm clean        # 清理构建产物
pnpm test:ts      # TypeScript 单测（contracts / agent-core / runtime）
scripts/test-all.sh   # 全量验证（含 cargo 与冒烟）
```

## 目录

- `ARCHITECTURE.md`：总架构和不可违反的边界
- `AGENTS.md`：Agent 开发规范（代码风格、目录职责、验证流程）
- `apps/`：桌面宿主、Runtime、CLI
- `packages/`：跨应用协议和 SDK
- `crates/`：未来 Rust 系统服务
- `docs/`：生命周期、插件、工作流、事件、安全、存储和迁移设计

## 与旧项目的关系

旧项目 `../ReflexionOS` 保持独立，仅作为需求和实现经验参考。新项目直接作为未来主项目建设，不依赖旧 Python 服务，也不以兼容旧实现为前提。

## 设计原则

先契约后实现，先边界后迁移；UI 不直接调用模型或系统工具；长任务必须支持事件流、取消、重试和恢复；所有外部能力声明权限。

计划模式的审阅文件、审批快照与自动清理规则见 [计划模式设计](docs/PLAN-MODE.md)。
