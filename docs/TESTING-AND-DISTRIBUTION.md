# Testing and Distribution

## Phase 1A-0/1A-1 MVP 测试矩阵

- Renderer：启动页、runtime-ready、provider-required、ready、error/degraded 状态；首配空状态；发送按钮连接前禁用；流式 delta、Stop、Retry 和 interrupted 展示。
- Provider：SSE stream、认证/网络/限流/超时错误和 AbortSignal。
- Storage：Project/Session/Message/Run 写入、重启历史恢复和 interrupted 状态。

## Phase 1A-2 测试矩阵

- Contracts：合法/非法 Command、Event、Provider 配置和 handshake；未知字段、版本不兼容、错误 discriminator。
- Runtime：Provider stream、delta 顺序、stop、retry、cancel race、canonical state 和 interrupted recovery。
- Rust：1A-0 只测试 ping、ready、shutdown、协议解析和 stdout/stderr 分离；1A-2 再测试路径穿越、cwd、环境、超时和进程回收。
- E2E：sidecar 启动与握手 → 创建 Session → Provider 首配 → 流式 Chat → Stop/错误 → SQLite 落盘 → 重启恢复。
- 跨平台：macOS/Linux/Windows 的路径、Shell、进程退出和编码差异。

## Phase 1B 测试

异步 Indexer 的 progress/cancel/retry/stale/error；文件树按需加载；ResourceLink 路由；代码查看器；Asset Preview；URL 白名单和系统浏览器回退。

## 开发与分发

Tauri Host 从开发目录或打包资源目录解析两个 sidecar，并用版本 manifest 校验 Runtime/Rust 兼容性。生产包需记录 sidecar 版本、平台和架构；日志写 stderr/诊断文件，不进入协议 stdout。Phase 1A 先保证开发可用和安装包可启动；签名、公证、自动更新、回滚、崩溃报告和备份恢复在 Phase 6 完善，但路径和接口现在必须预留。
