# ReflexionOS Studio

ReflexionOS 的下一代桌面 Agent 与可视化工作流平台。它不是现有 `ReflexionOS` 的直接副本，而是一个以 TypeScript Runtime 为核心、Rust 系统服务为边界、Tauri 为第一阶段宿主的独立架构项目。

## 当前阶段

当前仓库已完成 **Phase 1A**（Bootstrap → Chat Core → System Tools）、**Phase 1B 第一部分（Workspace Surface）** 与 **Phase 2 的 Skills / Memory 子集**：

- **Chat**：OpenAI-compatible Provider 配置与本地密钥存储，Project/Session/Message/Run，SSE 流式回复（含思考过程）、Stop / Retry、**发送队列**（回复中自动排队，可修改/删除/立即发送）、SQLite 持久化与重启恢复；
- **工具**：文件读写/搜索（经 Rust System Runtime）与 Shell、网络抓取、计时器；workspace / read-only 权限 Profile、工具审批（允许一次 / 本会话允许 / 拒绝）、工具轨迹聚合展示；
- **Skills**：内置 code-review、web-research、workspace-report，斜杠命令（`/code-review …`）与 skill.use 激活；
- **Memory**：Run 结束后自动提取与合并、记忆管理页、上下文召回注入；
- **Workspace**：按项目异步索引（进度/取消/过期状态与统计）、文件树按需加载、只读代码/文档查看器（行号、复制、跳转行、Markdown/JSON 预览），文件访问经 Rust 侧 workspace 边界；
- **UI**：项目/会话侧栏、聊天区（含右侧可开合的工作区面板）、落地页、技能页、记忆管理页、Provider 设置页。

尚未实现（见 `docs/ROADMAP.md`）：Phase 1B 剩余（Git Diff、Asset Card、ResourceLink、内嵌浏览器）、MCP 与插件、Browser 工具、多 Agent、Workflow Engine、多模态、激活码许可。

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
