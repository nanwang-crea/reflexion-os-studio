# Skill System

> Phase 1A 已落地：内置 Skill 注册表（manifest 经 contracts schema 校验）、`skill.list` 命令、
> `skill.use` Agent 工具、`/<skillId>` 斜杠激活与 `message.send` 显式 `skillId` 激活、
> `runs.skill_id` 落库（schema v6）。Phase 2 的 Plugin Foundation 批 1 已接入全局目录发现、
> 工作区目录安装、启停、隔离、状态持久化与管理 UI；拖拽交互与 git/file 安装仍属后续批次。

Skill 是可发现、可组合、带约束的 Agent 能力包，描述“如何完成一类任务”，而不是直接执行系统调用。Skill 可以包含 Instructions、Tool references、Examples、输入要求、输出规范、Memory hints、权限要求和资源。

```text
Tool 负责能做什么
Skill 负责应该如何做
Agent 负责决定和执行
Workflow Node 负责固定成可视化流程
```

Skill 生命周期：`discover → validate → install → enable → load → execute → disable/update`。Manifest 必须声明版本、适用场景、依赖工具、权限、兼容 Agent、是否允许 Worker 使用和是否可被 Workflow 引用。Skill 只能引用 Tool，不能绕过 Tool/Policy 直接访问系统。

## Phase 1A 实现

- **契约**：`SkillManifestSchema`（`packages/contracts`）——id（`/^[a-z0-9][a-z0-9-]*$/`）、name、version、description、tools（信息性引用）、argumentHint；`Run.skillId` 记录激活来源；`message.send` 增加可选 `skillId`；新增 `skill.list` 命令。
- **注册表**（`apps/runtime/src/skills/`）：`SkillRegistry` 注册时以 contracts schema 校验 manifest；内置技能不合法时启动失败，外部技能不合法时隔离为 `invalid`；Registry 由 Runtime 注入，不再使用全局单例。
- **激活链路**：显式 `skillId` 优先（未知 id → `invalid_request`）；消息以 `/<skillId>` 开头隐式激活（未知斜杠视为普通文本，不报错）。激活后 run 记录 `skillId`，system prompt 注入该技能完整 instructions；未激活时 system prompt 注入"可用 Skills"清单段。
- **Agent 工具**：`skill.use`（纯 TS，无 workspace 依赖）把指定技能的说明返回给模型——模型自主匹配任务与技能的通道。
- **存储**：schema v6 给 `runs` 加 `skill_id` 列（旧库自动迁移）；重试沿用原 Run 的技能。
- **内置技能**：`code-review`（代码审查）、`verify-fix`（验证修复循环）、`workspace-report`（工作区盘点）、`web-research`（网络调研）。
- **冒烟**：`scripts/smoke-skills.mjs` 覆盖清单/激活/拒绝/迁移。

## Phase 2 Plugin Foundation 批 1

- 全局 `<dataDir>/skills/<id>/SKILL.md` 启动发现与手动重扫；仅加载声明式 Markdown，不执行第三方代码；
- `plugins` 表（schema v25）持久化版本、来源、启停、错误与安装路径；
- `plugin.install` 支持从当前项目内的技能目录或 `SKILL.md` 安全复制安装，拒绝路径穿越与符号链接；
- 外部技能启用后与内置技能共用斜杠激活、`skill.use` 和 system prompt 清单；停用/无效后从三条链路同时隔离；
- 技能页展示来源和状态，并支持启停、卸载与重扫；
- 拖拽交互、git/file specifier 安装与更新留在 Plugin Foundation 后续批次。
