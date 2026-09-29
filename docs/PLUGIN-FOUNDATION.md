# Plugin Foundation 与 Skill Plugin 外部化

> 状态：**已落地**（2026-09-24）。当前只加载声明式 Skill；Provider/Tool 类型已冻结契约槽位，但在第三方代码隔离模型完成前不加载。

## 1. 包格式

插件安装目录为 `<dataDir>/plugins/<id>/`：

```text
<id>/
├── SKILL.md          # 必需，标准 frontmatter + instructions
├── plugin.json       # 可选，ReflexionOS 扩展 manifest
├── assets/           # 可选静态资源
├── references/       # 可选参考资料
└── scripts/          # 可选随包资源；当前绝不执行
```

`plugin.json` v1 示例：

```json
{
  "manifestVersion": 1,
  "id": "review-plus",
  "name": "Review Plus",
  "version": "1.2.0",
  "description": "Review workflow",
  "type": "skill",
  "entry": "SKILL.md",
  "compatibility": { "protocol": ">=1.3 <2.0" },
  "capabilities": ["skill.instructions"],
  "permissions": {
    "filesystem": "workspace-read",
    "network": false,
    "shell": false
  },
  "skill": {
    "tools": ["file.read"],
    "argumentHint": "<path>"
  }
}
```

标准 `SKILL.md` 与 ZCode Skill 字段保持一致：`name` 与 `description` 必填，`when_to_use`、`license` 与 JSON `metadata` 可选；description 上限 1024 字符，正文按 100KB 上限加载。`when_to_use` 参与模型侧技能匹配，license 与 metadata 随内部规范化 manifest 保留；`metadata.version` 缺失时内部版本为 `1.0.0`。扩展 manifest 的版本必须为 SemVer，协议兼容范围支持精确版本、比较组合和 caret；Skill 入口固定为 `SKILL.md`，并声明 `skill.instructions` 和 `skill` 元数据。

权限是信息性声明，不产生授权。Skill 实际可调用的工具仍由单次 Run 的 ToolRegistry、PermissionGate、沙箱与审批决定。

## 2. 安装源与生命周期

- `dir`：当前项目中的相对路径；拒绝绝对路径、`..` 与路径链符号链接。
- `local`：用户经系统文件选择器或 Tauri 拖拽明确提供的本地文件/目录；选择文件时只接受并隔离复制该 `SKILL.md`，不扫描父目录；`plugin.json` 扩展包必须选择目录。
- `git`：无用户名和密码的 HTTPS URL；浅克隆，关闭交互式 credential helper，60 秒超时，验证前删除 `.git`。

命令：

- `plugin.preview`：立即返回异步 task；完成后 task 携带 manifest 与同 id 的已安装记录，UI 据此展示权限确认。
- `plugin.install`：立即返回异步 task；后台再次校验、复制到临时 stage、复验并原子改名到正式目录。
- `plugin.update`：立即返回异步 task；从持久化来源重新取包，id 必须相同；扩展 manifest 版本按 SemVer 2.0.0 优先级严格递增，标准 Skill 允许同版本刷新。
- `plugin.task.list` / `plugin.task.cancel`：查询本次 Runtime 生命周期内的任务，以及取消尚未结束的任务；`plugin.task.changed` 持续报告 phase、百分比、终态和错误。
- `plugin.toggle` / `plugin.uninstall` / `plugin.rescan`：启停、卸载和磁盘对账。

安装时必须选择作用域：`global` 安装到全局插件目录；`project` 绑定明确的 `projectId` 并安装到项目隔离子目录。Registry、system prompt、显式 `$skill`/`/skill` 解析和 `skill.use` 均按会话项目过滤，禁止把项目 Skill 泄漏到其他项目或独立会话。

更新顺序：

```text
resolve source → validate → copy stage → validate stage
→ target rename to backup → stage rename to target → persist record
→ remove backup → reload registry
```

目标替换、数据库写入或注册表重载前发生异常时，旧目录从 backup 恢复。卸载也先把目标移到应用管理目录内的隔离路径，删除记录成功后才清除内容。

Runtime 启动时在正常插件扫描前恢复中断事务：遗留 stage/source/preview 直接清理；backup 根据数据库记录与正式目录版本决定完成提交还是恢复旧包；remove 隔离目录根据卸载记录是否仍存在决定恢复或删除。任务本身不持久化，重启后的正确状态由数据库与这些原子目录事实推导，避免第二套事务真源。

## 3. 安全边界

安装前递归检查整个包：

- 禁止符号链接、设备文件和其他非普通文件；
- 禁止危险隐藏项、`.git`、凭据类文件名及 `.key`/`.pem`/`.token`；
- 根目录非 Skill 条目在预览中告警并跳过复制；
- 最多 1000 个文件、总计 16 MiB；
- 入口必须留在包内且为普通文件；
- 只加载 `skill`，Provider/Tool 包返回“不支持加载”；
- instructions 为空时拒绝。

包内容始终是不可信数据。当前 Runtime 不执行 `scripts/`，不把 manifest 的 tools/permissions 转成授权，也不允许插件访问数据库内部实现。

## 4. 存储与恢复

schema v26 的 `plugins.manifest_json` 保存完整已校验 manifest；版本、来源、安装路径、启停、状态和错误继续使用独立列便于查询。Runtime 启动时扫描磁盘并与数据库对账：

- 合法且启用：进入 SkillRegistry；
- 停用：保留记录但不进入 Registry；
- 包损坏：标记 `invalid`，隔离但不阻塞启动；
- 目录缺失：保留记录并标记 `invalid`；
- 旧 `<dataDir>/skills/<id>/SKILL.md`：复制到新目录并生成一次 `plugin.json`，不删除旧目录。

内置技能不入库，但会生成同结构的 `PluginPackageManifest`，与外部 Skill 共用 Registry 与调用链。

## 5. 管理 UI

技能页提供：

- 本地文件/目录选择、系统拖拽和 Git HTTPS 输入；
- 安装前显示名称、版本、类型、能力和权限声明；
- 来源、版本、状态与兼容错误展示；
- 更新、启停、卸载、重新扫描；
- Git 下载、校验、stage、提交和重载进度，以及运行中取消；
- 内置技能只读，不允许更新、停用或卸载。

## 6. 后续边界

Provider/Tool 插件需要独立进程隔离、资源配额、签名/来源信任和更细权限模型。上述条件落地前，不得因为 manifest 已有 `provider`/`tool` 类型就动态加载第三方代码。
