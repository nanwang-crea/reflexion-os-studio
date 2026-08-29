# ReflexionOS Studio

ReflexionOS 的下一代桌面 Agent 与可视化工作流平台。它不是现有 `ReflexionOS` 的直接副本，而是一个以 TypeScript Runtime 为核心、Rust 系统服务为边界、Tauri 为第一阶段宿主的独立架构项目。

## 当前阶段

当前仓库处于 **Architecture Foundation** 阶段：只定义边界、协议和迁移路线，不迁移旧 Python 业务代码。

```text
React Renderer → Tauri Host → TypeScript Runtime → Rust System Services
                                      ↘ SQLite / Event Store
```

## 目录

- `ARCHITECTURE.md`：总架构和不可违反的边界
- `apps/`：桌面宿主、Runtime、CLI
- `packages/`：跨应用协议和 SDK
- `crates/`：未来 Rust 系统服务
- `docs/`：生命周期、插件、工作流、事件、安全、存储和迁移设计

## 与旧项目的关系

旧项目 `../ReflexionOS` 保持独立，仅作为需求和实现经验参考。新项目直接作为未来主项目建设，不依赖旧 Python 服务，也不以兼容旧实现为前提。

## 设计原则

先契约后实现，先边界后迁移；UI 不直接调用模型或系统工具；长任务必须支持事件流、取消、重试和恢复；所有外部能力声明权限。
