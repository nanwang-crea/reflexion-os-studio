# Runtime 生命周期

核心对象：Session（会话）、Run（一次执行）、Turn（一次用户回合）、NodeRun（后续 Workflow 执行）、Checkpoint（后续可恢复快照）。

MVP Run 状态：`created → running → completed|failed|cancelled|interrupted`。MVP 不实现 waiting_approval、NodeRun 或 checkpoint 恢复；应用重启时以 SQLite canonical state 为准，将未完成 Run 标记为 interrupted。取消使用协作式 AbortSignal；Retry 创建新 Run 并保留原失败记录。

1A-2 再增加 waiting_approval、ToolCall 和 Rust 子进程恢复；Workflow 阶段再增加 NodeRun、暂停和 checkpoint。

### Windows 启动兼容

宿主传给 Node 的入口路径将 `\\?\C:\…` 转为普通盘符路径，将
`\\?\UNC\server\share\…` 转为 UNC 路径，规避随包 Node 22 的入口
realpath 回归（nodejs/node#62446）。不转换设备命名空间。macOS/Linux
路径保持原样。Windows 发布版宿主使用 GUI 子系统；后台 Node、System
Runtime、MCP 与 taskkill 隐藏控制台，开发版宿主保留控制台日志。

Windows 验收须从资源管理器双击新构建的安装版，检查 runtime.ready、
工具调用与关停，确认无控制台弹窗；另验安装路径含空格/中文及 UNC
入口。超长路径仍需 Windows 真机验收，当前 macOS 验证不能替代。
