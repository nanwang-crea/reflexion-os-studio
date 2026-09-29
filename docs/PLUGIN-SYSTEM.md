# 插件系统

当前可安装插件仅为声明式 Skill。标准包只需包含带 YAML frontmatter 的 `SKILL.md`；字段与 ZCode Skill 规范一致：`name` 和 `description` 必填，`when_to_use`、`license` 与 JSON `metadata` 可选，description 上限 1024 字符，正文按 100KB 上限加载。`when_to_use` 参与技能匹配，其他兼容元数据随安装记录保留。`plugin.json` v1 是可选的 ReflexionOS 扩展 manifest，用于声明入口、协议兼容范围、能力与权限；缺失时 Runtime 从 `SKILL.md` 生成内部规范化 manifest。扩展 manifest 的未知字段、非法相对路径、不支持类型和不兼容版本仍在安装前拒绝。

安装源包括项目相对目录、本地文件/目录和无凭据 HTTPS Git URL。preview、安装与更新都以异步生命周期任务运行；命令立即返回 task，`plugin.task.changed` 报告阶段与进度，`plugin.task.cancel` 可终止运行中的 Git 子进程。统一生命周期为：

安装目标分为 `global` 与 `project`：全局 Skill 对所有会话可见；项目 Skill 必须绑定有效 `projectId`，只进入对应项目会话的元数据清单、显式调用和 `skill.use` 查询，独立会话与其他项目不可见。

```text
preview → validate → permission confirmation → stage → validate again
        → atomic rename → persist → reload registry
```

更新必须保持相同 id；扩展 manifest 按 SemVer 2.0.0 优先级严格递增，标准 Skill 可按原来源同版本刷新。旧目录先改名为备份，新目录与数据库写入任一步失败都会恢复旧目录；Runtime 启动时还会对遗留 stage、backup 与 remove 隔离目录执行对账恢复。卸载同样先移入应用管理目录内的隔离位置，再删记录。插件包拒绝符号链接、危险隐藏项、凭据类文件名、越界入口以及超出文件数/体积上限的内容；无关根目录条目告警后跳过。

内置和外部 Skill 最终都投影为同一个 `PluginPackageManifest + SkillDefinition` 加载模型。manifest 权限仅用于展示和确认，不授予 Agent 权限；实际工具调用仍经过 ToolRegistry、PermissionGate 与审批链路。Provider/Tool 插件只保留契约类型，第三方可执行代码隔离模型完成前不得加载。
