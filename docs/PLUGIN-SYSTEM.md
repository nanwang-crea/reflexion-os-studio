# 插件系统

当前可安装插件仅为声明式 Skill。每个包必须包含 `plugin.json` 和 `SKILL.md`：前者是版本化元数据唯一真源，后者只保存说明正文。`plugin.json` v1 声明 `type`、入口、协议兼容范围、能力与权限；未知字段、非法相对路径、不支持的类型和不兼容版本均在安装前拒绝。

安装源包括项目相对目录、本地文件/目录和无凭据 HTTPS Git URL。统一生命周期为：

```text
preview → validate → permission confirmation → stage → validate again
        → atomic rename → persist → reload registry
```

更新必须保持相同 id 且版本严格递增。旧目录先改名为备份，新目录与数据库写入任一步失败都会恢复旧目录。卸载同样先移入应用管理目录内的隔离位置，再删记录。插件包拒绝符号链接、隐藏项、凭据类文件名、越界入口以及超出文件数/体积上限的内容。

内置和外部 Skill 最终都投影为同一个 `PluginPackageManifest + SkillDefinition` 加载模型。manifest 权限仅用于展示和确认，不授予 Agent 权限；实际工具调用仍经过 ToolRegistry、PermissionGate 与审批链路。Provider/Tool 插件只保留契约类型，第三方可执行代码隔离模型完成前不得加载。
