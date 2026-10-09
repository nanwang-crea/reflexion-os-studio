# 对话历史分页与渲染

界面读取 `session.get` 默认取最近 10 轮对话（`turns` 最大 50），可通过
`before` 游标读取更早的页。游标由 `created_at + rowid` 组成，同毫秒消息按
插入顺序排序，过滤 superseded 后再分页。一轮从用户发言开始，包含下一次用户发言之前的全部助手、思考与工具消息；重试不单独计轮。每页携带消息位置与下一页游标，
关联 Run、工具调用和运行事件只读取该页对应的数据；计划仅读取当前活动
及最近完成的计划。模型上下文继续使用 MessageStore 的完整历史读取。

前端首次打开只取最新页；向上加载时合并并去重，保留滚动锚点。最新页刷新
替换重叠区间，清除编辑重发产生的旧消息，保留已加载的更早区间；若新页与
缓存无交集则回到最新页，避免制造历史缺口。切换会话后旧响应不得回填。

聊天块使用动态高度虚拟列表，只挂载视口及相邻缓冲区域。ResizeObserver
测量真实高度，滚动事件通过 requestAnimationFrame 合帧，卸载清理订阅。
流式回复仅在贴底时跟随；历史加载与高度变化保留阅读位置。子 Agent 轨迹
同样分页，避免另一路全量加载。macOS / Windows / Linux 均使用 WebView
标准 DOM API，无平台专属进程或文件路径假设。

验收包含同毫秒游标、空会话、superseded、分页关联轨迹、并发刷新/切换、
长列表挂载数量、动态高度、历史插入与贴底跟随。真机性能按 AGENTS.md
要求单独记录，不能用构建或单测代替。

## 本次验证（2026-10-09）

- 默认页包含 10 次用户发言以及每轮全部助手/工具步骤；最新轮尚在执行时
  同样显示，不隐藏正在回复的内容。同毫秒分页、80 个中间步骤的一轮、
  重试与编辑重发、空会话及跨会话隔离均有 Runtime 回归测试。
- 前端测试 47 项通过；Runtime 405 项通过、12 项跳过；Rust 221 项通过。
  format、lint、两侧 typecheck、packages 构建与宿主 cargo check 通过。
- Chromium / Vite 开发模式的合成长列表验收：2101 个块全量挂载对比
  虚拟挂载 7 个块；JS heap 分别约 15.8 / 6.3 MiB。3 秒空闲采样的
  TaskDuration CPU 分别约 0.010% / 0.014%。该结果只说明测试页的
  浏览器开销，不能代表 Tauri/WebView/Node 三进程真机基线。
- 历史前插、展开造成的动态高度、窄窗口、贴底追加及无脚本错误通过
  真实 DOM 验收。夹具：`apps/desktop/test/fixtures/history-virtualization.html`；
  可运行 `pnpm --filter @reflexion-os-studio/desktop dev:frontend` 后打开该页。
- macOS `.app` 与 DMG 打包通过（DMG 需在受限沙箱之外执行 hdiutil）。
  桌面 UI 自动化未能选中独立验收窗口，Tauri 三进程 dev 空闲基线和
  Windows/Linux 真机 UI 尚未验收。
