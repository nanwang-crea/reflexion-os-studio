# Workflow 跨平台兼容性与第二轮 Review

> 历史文档：2026-10-14 已退役独立 Workflow 编排。实现保留于 `codex/archive-workflow-2026-10-14`，当前方向见 [Agent 协作](AGENT-COLLABORATION-2026-10-14.md)。

日期：2026-10-14；分支：`feature/workflow`；基线：`d4d3b0e`。

## 已修复的问题

| 优先级 | 问题                                                                                   | 修复与回归                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 文件资源只拒绝盘符，没有明确拒绝 Windows ADS、设备名与 Win32 尾部点/空格别名           | 在任何 System 请求前拒绝冒号、控制字符、Windows 非法字符、设备名及组件尾部点/空格；UNC/设备路径沿既有相对路径边界拒绝；测试确认零读取请求 |
| P2     | 人工确认只在异步资源校验前检查有效期                                                   | 校验返回后再次检查，过期则失败且不发布成果；回归让时间在 await 期间越过截止时间                                                           |
| P2     | 生成取消/超时后模型仍成功返回，runner 直接 return，可能保留 running 状态或漏掉终态事件 | 统一进入终态收敛；分别覆盖取消及 120 秒超时后的迟到成功结果，拒绝应用候选且发布 cancelled/failed 事件                                     |
| P2     | 运行事件刷新第一页会丢失已加载历史，重叠分页也可能留下旧状态                           | 最新页与较早页统一去重合并、保留较高 stateVersion；刷新 epoch 拒绝迟到的旧列表请求；回归覆盖分页保留、重叠和状态倒退                      |

## 跨平台检查

| 边界                    | macOS                                                     | Windows                                                                   | Linux                                       |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| Workflow 调度/存储/恢复 | Node SQLite、Promise、AbortSignal、JSON-RPC               | 相同实现，无 POSIX 信号或 shell 产品逻辑                                  | 相同实现                                    |
| 工作区文件资源          | node:path.resolve，Rust canonical containment 与 revision | 额外拒绝 ADS/设备名/Win32 别名；反斜杠规范为协议斜杠；Rust 按本机路径解析 | 相同可移植资源规则；Rust 按本机路径解析     |
| Agent 工具与授权        | 复用已有 PermissionGate/System Runtime/Seatbelt           | 复用已有受限令牌适配；不升级已有 Danger 限制                              | 复用已有 bwrap 适配；不升级已有 Danger 限制 |
| UI                      | React Flow/Radix，Backspace/Delete 均支持                 | 相同 DOM 实现，系统集成仍经 Tauri                                         | 相同 DOM 实现，依赖既有 WebKitGTK           |
| 自动验证                | 本机执行                                                  | 已接入 CI，尚未在本轮运行                                                 | 已接入 CI，尚未在本轮运行                   |

Workflow 资源使用三平台共同可表示的文件名子集。因此 macOS/Linux 上合法但包含冒号、
星号等字符的文件不能作为 Workflow 文件资源；不更改普通工作区文件工具的命名行为。
中文、空格（非组件末尾）、两种路径分隔符和 `./` 形式仍可用，指纹按原始文件字节验证，
不改变 CRLF/LF 或大小写。跨项目资产、陈旧 revision 与敏感路径继续拒绝。

CI 的现有三个 OS 构建 job 新增完整 Runtime Workflow 回归及纯前端编辑/历史回归。
`test:workflow` 使用显式文件参数，不依赖 bash glob；在 `build:packages` 后运行。
headless Chromium 组件测试需要已安装的受管浏览器，本轮仅在 macOS 本机执行，
没有把它作为 Windows/Linux 已通过的证据。

## 验证记录与限制

本机 Runtime 全量：593 pass / 4 平台 skip（597 项）；前端：87 pass；System Runtime：
233 pass。新增五项回归覆盖资源路径、确认跨 await 过期、生成取消/超时迟到结果、历史合并。
Workflow 相关共 77 项：契约 6、Runtime 65、前端 6。

首轮受执行环境沙箱影响，本机监听被 EPERM 拒绝、Seatbelt 嵌套启动被拒绝；允许测试所需
本机操作后重跑通过。测试仅使用临时数据与合成 Provider，没有调用用户模型或读取真实凭据。

Windows/Linux 编译、安装包、真实 WebView/沙箱/PTY 运行仍需要对应 CI/真机结果；本轮没有
远程触发 CI。真实模型质量、长稳、最终 Tauri GUI 与完整窄窗口/高 DPI/键盘矩阵仍待验收。
本次列表修复没有新增事件订阅、定时轮询或高频 setState；未重新实测 dev 空闲进程资源。

format:check、lint、根级/前端 typecheck、build:packages、两套 Rust fmt、Host cargo check、
契约 81 项回归及 macOS app/DMG 打包通过。新增 CI 命令在本机执行：Workflow 65 项、
编辑/历史 5 项通过。主要日志：`/tmp/reflexion-workflow-review-runtime-tests.log`、
`/tmp/reflexion-workflow-review-frontend-tests.log`、`/tmp/reflexion-workflow-review-rust-tests.log`、
`/tmp/reflexion-workflow-review-desktop-build.log`。

前次完整实现记录见
[W4–W5 Review](WORKFLOW-REVIEW-2026-10-14.md)。
