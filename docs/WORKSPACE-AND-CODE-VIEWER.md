# Workspace and Code Viewer

## Phase 1A 边界

Chat 不依赖全量 Workspace 索引。Agent 只通过 Rust File Service 按需执行 `fs.list`/`fs.read`，路径始终是 workspace-relative；不承诺文件树、统计或 Git 摘要立即可用。

## Phase 1B Workspace Indexer

Workspace Indexer 作为独立 worker/队列异步运行，不阻塞 Chat。首次扫描和增量更新都提供 `progress`、`cancel`、`retry`、`stale`、`error` 状态。默认忽略 `.git`、`node_modules`、`dist` 和缓存目录；文件树按需加载，符号链接默认不跨 Workspace。索引快照带 version、startedAt、completedAt 和 staleAt。

文件树只为当前已展开目录建立非递归原生 watcher。事件由 Rust 在 workspace
边界内产生，经 Runtime 投影成 project-scoped `workspace.changed`；前端合并短时间内
的重复事件后刷新受影响目录和共享 Git 状态。Watcher 失败时保留手动刷新，禁止退化成
常驻轮询。文件树徽章与 Git 面板通过同一个 repository refresh 入口读取状态，避免
各自维护互相漂移的快照。

预览读取分为文本与受限二进制两条契约。二进制预览同样必须经过 Rust workspace
边界，单文件硬限制 20 MiB，只向前端返回 base64 与经白名单推导的 MIME；当前支持
常见图片（SVG 以图片资源隔离渲染）、PDF、音频和视频。未知二进制仍显示占位提示，
不得尝试按文本解释。媒体预览为所在目录建立临时 watcher，文件变化后重新读取。

Git 变更面提供“工作区”和“当前任务”两个来源。当前任务不重新推断磁盘差异，而是
从 canonical `mutation_receipts` 按最新根 Run 汇总整棵 Agent 委派树的
`ToolOutput.changedFiles`，同一路径以最后一次 mutation 为准。该视图只读，可定位文件
和打开当前工作树 diff；暂存、提交等写操作仍只属于工作区来源。

`WorkspaceStats` 至少包含文件数、目录数、总大小、按扩展名统计、Git changed/untracked 数量和更新时间。索引器失败不影响 Chat，UI 必须显示过期或错误状态。

## Code/Document Viewer

Phase 1B 支持语法高亮、行号、折叠、复制、跳转行，以及 Markdown、JSON、YAML、TOML 预览。消息中的 `ResourceLink` 可直接打开文件并定位行列。查看器通过 Workspace API 获取内容，不能直接访问任意本地路径。完整编辑、符号导航和批量修改后续增加。

## Git

Git Changes 提供状态、单文件 diff、暂存、提交和同步；历史面提供提交浏览、分支与远程管理。所有操作经 Rust workspace 边界。

采用混合实现：`gix` 读取本地/远程引用、HEAD/提交树和索引中的 blob，为分支列表及 diff 提供内容；原生读取禁用用户、系统及环境 Git 配置读取。状态、历史、重命名检测、换行属性查询、暂存/提交/分支写入和网络操作仍调用外部 Git，保持 Git 配置、认证与工具链兼容。当前不额外创建内部快照或基线。

安装包尚未内置 Git。未找到 Git 时，变更与历史面板显示安装指引、官方入口及重试按钮：

- macOS：运行 `xcode-select --install`，或从 [Git 官方下载页](https://git-scm.com/downloads) 安装。
- Windows：安装 [Git for Windows](https://gitforwindows.org/)，选择将 Git 加入 PATH。
- Linux：使用发行版包管理器，如 `sudo apt install git` 或 `sudo dnf install git`。

安装后重启应用并重试。可通过 `REFLEXION_GIT_PATH` 指定 Git 可执行文件；路径问题与未安装应分别排查。
