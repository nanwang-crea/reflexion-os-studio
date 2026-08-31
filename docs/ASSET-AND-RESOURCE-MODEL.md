# Asset and Resource Model

## 四个概念

- **WorkspaceFile**：Workspace 中真实存在的文件实体，使用受保护的 workspace-relative path，例如 `workspace://project/src/app.ts`。
- **Asset**：Asset Store 中的内容存储实体，例如图片、视频、音频或尚未导出的生成文件。
- **Artifact**：一次 Run 产生的面向用户的结果语义，可引用一个或多个 Asset 或 WorkspaceFile。
- **ResourceLink**：UI 导航引用，不拥有内容，可指向 WorkspaceFile、Asset 或 ExternalUrl。

关系：`Artifact → Asset | WorkspaceFile`，`ResourceLink → WorkspaceFile | Asset | ExternalUrl`。模型返回的代码块默认是 Message Content；Tool 写入后才成为 WorkspaceFile；Provider 媒体结果成为 Asset；用户明确导出后才可新建 WorkspaceFile。

## AssetRef

至少包含 `assetId`、`kind`、`uri`、`mimeType`、`size`、`hash`、`projectId`、`runId`、`nodeRunId`、`createdBy`、`createdAt`、`metadata` 和 `preview`。数据库和事件只保存引用与元数据，大文件存放在受控 Asset Store。

## ResourceLink

使用 discriminated union 表达目标类型，并携带显示名称、来源、归属、权限上下文和可选行列位置。Markdown 渲染器不得直接执行任意协议或路径。项目文件进入 Code/Document Viewer，Asset 进入预览器，https URL 进入安全 Browser Surface 或系统浏览器。

## 生命周期与安全

Asset：`created → indexed → previewed → opened/exported → archived/deleted`。Phase 1B 只支持预览、定位和复制引用；导出到 Workspace、下载和系统应用打开需要后续明确权限。Asset Store 按 Project/Workspace 隔离；ResourceLink 是短期导航对象，不改变目标资源所有权或生命周期。

## 落地状态（2026-08-31，Phase 1B）

- 已落地：Asset Store（数据目录 `assets/<projectId>/` 隔离、sha256、`asset.*` 命令：导入/列表/读取/删除）、ResourceLink（`workspace://<projectId>/<path>#L<行号>`、`asset://<assetId>`、https 三种引用的消息内渲染与点击分发）、Artifact 卡（Run 回复引用聚合展示）。
- 边界：仅预览、定位与复制引用；导出到 Workspace、下载、系统应用打开、媒体内嵌预览（音频/视频）留后续阶段（需权限）。nodeRunId 字段当前恒 null（多 Agent 阶段填充）。
