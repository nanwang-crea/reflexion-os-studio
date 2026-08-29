# Workspace and Code Viewer

## Phase 1A 边界

Chat 不依赖全量 Workspace 索引。Agent 只通过 Rust File Service 按需执行 `fs.list`/`fs.read`，路径始终是 workspace-relative；不承诺文件树、统计或 Git 摘要立即可用。

## Phase 1B Workspace Indexer

Workspace Indexer 作为独立 worker/队列异步运行，不阻塞 Chat。首次扫描和增量更新都提供 `progress`、`cancel`、`retry`、`stale`、`error` 状态。默认忽略 `.git`、`node_modules`、`dist` 和缓存目录；文件树按需加载，符号链接默认不跨 Workspace。索引快照带 version、startedAt、completedAt 和 staleAt。

`WorkspaceStats` 至少包含文件数、目录数、总大小、按扩展名统计、Git changed/untracked 数量和更新时间。索引器失败不影响 Chat，UI 必须显示过期或错误状态。

## Code/Document Viewer

Phase 1B 支持语法高亮、行号、折叠、复制、跳转行，以及 Markdown、JSON、YAML、TOML 预览。消息中的 `ResourceLink` 可直接打开文件并定位行列。查看器通过 Workspace API 获取内容，不能直接访问任意本地路径。完整编辑、符号导航和批量修改后续增加。

## Git

Git Changes 作为按需 Context Surface 展示文件状态和 diff。第一阶段只支持查看和定位；编辑、暂存、提交等操作必须经过明确命令和权限策略。
