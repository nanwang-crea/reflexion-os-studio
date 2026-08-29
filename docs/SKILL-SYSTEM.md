# Skill System

> Phase 1A 限定：只保留内置/空 `SkillRef` 和 manifest 校验。禁止第三方 Skill install、enable、load、execute，不实现 Registry 或动态权限合并。

Skill 是可发现、可组合、带约束的 Agent 能力包，描述“如何完成一类任务”，而不是直接执行系统调用。Skill 可以包含 Instructions、Tool references、Examples、输入要求、输出规范、Memory hints、权限要求和资源。

```text
Tool 负责能做什么
Skill 负责应该如何做
Agent 负责决定和执行
Workflow Node 负责固定成可视化流程
```

Skill 生命周期：`discover → validate → install → enable → load → execute → disable/update`。Manifest 必须声明版本、适用场景、依赖工具、权限、兼容 Agent、是否允许 Worker 使用和是否可被 Workflow 引用。Skill 只能引用 Tool，不能绕过 Tool/Policy 直接访问系统。

Phase 1 只定义 SkillRef 和加载边界；Phase 2 实现 Registry、版本、启停、隔离和 UI。
