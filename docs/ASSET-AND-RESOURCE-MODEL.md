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

## ToolOutput 与会话文件展示

工具执行结果统一收敛为 `ToolOutput { type, version, content, data, resourceLinks, changedFiles }`。工具可以直接返回结构化字段；现有只返回 JSON 文本的工具由 Runtime 在单一归一化边界提取 `data`、`changedFiles` 和显式资源引用。文件变更在有项目上下文时同步生成 canonical `workspace://` ResourceLink。

会话末尾只展示“变更了 N 个文件”折叠列表（2026-10-07）：

- **文件变更**：汇总本轮成功工具调用记录的全部变更，源码、文档、图片等使用同一列表，不因最终回复引用而移除；无变更时隐藏。展开列表限高，点击有编辑快照的文件打开 diff，否则进入文件查看器。
- **正文引用**：文件、资产和 https 链接留在正文，保持原有点击导航及行号定位。仅被读取或引用的文件不加入变更列表。
- **去重**：按规范化路径合并同一文件的重复操作与重复工具调用，移动合并为一项，保留最后一次变更状态。取消或失败的 Run 已经成功落盘的变更仍然展示。
- **移除独立产物区**：不再从工具输出、消息引用或文件扩展名推断交付物，也不在回复末尾额外渲染 Artifact 卡。Artifact 协议概念保留，历史消息与工具记录不重写。

聚合和展开均在 React 展示层完成，macOS / Windows / Linux 共用逻辑，路径比较兼容两种分隔符且不改变原始导航目标。不新增事件订阅或定时器。模型上下文继续使用同一 ToolOutput 的 `content`。

## 生命周期与安全

Asset：`created → indexed → previewed → opened/exported → archived/deleted`。Phase 1B 只支持预览、定位和复制引用；导出到 Workspace、下载和系统应用打开需要后续明确权限。Asset Store 按 Project/Workspace 隔离；ResourceLink 是短期导航对象，不改变目标资源所有权或生命周期。

## 落地状态（2026-08-31，Phase 1B）

- 已落地：Asset Store（数据目录 `assets/<projectId>/` 隔离、sha256、`asset.*` 命令：导入/列表/读取/删除）、ResourceLink（`workspace://<projectId>/<path>#L<行号>`、`asset://<assetId>`、https 三种引用的消息内渲染与点击分发）、版本化 ToolOutput，以及由成功工具变更驱动的会话文件列表；独立 Artifact 卡已于 2026-10-07 移除，资源引用保留在正文。
- 边界：仅预览、定位与复制引用；导出到 Workspace、下载、系统应用打开、媒体内嵌预览（音频/视频）留后续阶段（需权限）。nodeRunId 字段当前恒 null（多 Agent 阶段填充）。
