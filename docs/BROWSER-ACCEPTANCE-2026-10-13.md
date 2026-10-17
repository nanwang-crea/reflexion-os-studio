# Browser macOS 验收记录（2026-10-13）

> 2026-10-17 更新：本文中的 WKWebView / WebView2 / WebKitGTK 网页实现及 `browser-spike` 构建选项属于历史记录，现已移除。当前实现与构建方式见 [CEF 接入](CEF-BROWSER-INTEGRATION.md)；不能按下文旧命令启用旧引擎。

> 路线调整：本文 B4 静态读取相关测试为历史记录，该实现已按用户决定移除，不能作为当前功能或 Playwright 验收证据。用户 Surface 验收记录继续保留。

环境：macOS 26.7.1 / arm64，独立临时数据目录和独立验收 app，dev Renderer。
不读取真实浏览器 profile、密码库或 Provider 密钥；网站和 Provider 由本地合成
fixture 提供。以下结论仅适用于本次环境，不能推广为三平台和全部 macOS 版本。

## 用户 Surface

| 项目           | 本机结果与证据                                                                                                                     | 剩余范围                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 临时会话       | 合成 Cookie 写入后关闭浏览会话，重开无标记                                                                                         | 真实登录站点不在本次范围                         |
| 持久会话       | 合成持久 Cookie/localStorage 在退出重启后保留                                                                                      | macOS 12/13 不支持持久配置；14/15 等旧系统待验收 |
| 分项清理       | 缓存响应重复读取为 cache-1，单清缓存后为 cache-2，网站标记保留；单清网站数据后标记消失、历史保留；单清历史后列表清空、网站标记保留 | 清理中导航/切模式等竞态完整 GUI 矩阵待补         |
| 保存取消       | 原生保存对话框取消，记录 cancelled、0 字节                                                                                         | Unicode/已有文件/磁盘错误矩阵待补                |
| 下载进行中取消 | 合成慢下载 19456/122880 字节时取消；目标文件未发布、未发现临时半文件                                                               | 关闭会话取消、网络中断等矩阵待补                 |
| 下载重定向     | 同来源重定向进入保存流程；跨来源拒绝，不出现保存对话框                                                                             | 多跳和子框架下载矩阵待补                         |
| 网站权限       | 发布配置下媒体请求返回 NotAllowedError；保存/移除规则后已有网页标签销毁；原生确认复核来源、活动标签与 revision                     | 活跃摄像头/麦克风停止的硬件验收尚未执行          |
| 遮挡           | dev/发布菜单和设置弹层隐藏原生网页，Escape 关闭后恢复；窗口 zoom 后工具栏与网页位置正常                                            | 窄窗口、高 DPI、全屏及完整键盘矩阵待补           |
| 长稳           | 双标签连续十分钟，21 次采样，无持续 CPU 或 RSS 增长                                                                                | 动态视频/真实登录/长时间下载不在此采样场景       |

本轮发现并修复：附件在成为 WKDownload **之前**发生跨来源导航重定向时，
原有下载 delegate 守卫尚未生效。现在附件响应必须匹配本次导航的初始 origin；
缺少来源、改变协议/端口/host 均拒绝。增加纯函数回归测试并做同/跨来源 GUI 复测。
附件响应还隐藏旧页面，避免失败地址与旧内容同时显示。

## 空闲资源采样

同一独立 dev app：空标签时 `top -l 4 -s 3` 的 Host、Runtime、Renderer
均为 0.0% CPU；RSS 分别 127.6、87.5、285.7 MiB。随后打开两个本地合成网页，
每 30 秒采样，共 21 次，持续 600.33 秒；结束再用同样的 top 四轮采样。
Host 在 ps 采样中最高 0.1%，其他进程 0.0%；结束 top 全部为 0.0%。

| 进程              | 双标签起始 RSS MiB | 十分钟结束 RSS MiB | 采样峰值 RSS MiB |
| ----------------- | -----------------: | -----------------: | ---------------: |
| Host（63117）     |              121.2 |              108.7 |            121.3 |
| Runtime（63135）  |               64.6 |               43.1 |             64.6 |
| Renderer（63132） |              216.0 |               59.3 |            216.1 |
| 网页 1（70369）   |               29.8 |               30.3 |             30.3 |
| 网页 2（70526）   |               33.7 |               22.6 |             33.7 |

Renderer 由独立 app 启动关联，两个网页进程由各次新标签创建前后进程差分关联，
不是任选系统中同名进程。采样阶段不构建前端、不更改 Renderer 源码；CPU/RSS
记录保存在临时目录 `reflexion-browser-long-stability.jsonl` 与
`reflexion-browser-long-final-top.txt`。RSS 受系统压缩/回收影响，减少不代表产品
内存优化；结论仅为该静态双标签场景没有持续空转或增长，不推广到媒体负载。

## B4 首批

已实现 `browser.navigate` / `browser.read`：独立公开静态文本快照；默认开关
关闭，导航与读取分别一次审批，workspace-full/Danger 不旁路。绑定 Session、
Run、标签、origin、sourceUrl 和随机页面版本；关闭、撤销、Run 结束失效。
敏感 URL 在批量预建、checkpoint、工具轨迹之前做拒绝与参数清空；表单、
嵌入及疑似凭据正文拒绝；脚本剥离、HTML 转义、正文有界、临时 store、CSP
禁资源/脚本。网页 provenance 标为 untrusted_external，系统提示要求披露注入
并只推进用户原任务。过滤不是对任意敏感个人信息的完整语义分类器，也不声称
能消除所有模型提示注入；保留逐次审批、系统敏感拒读与最小能力边界。

隔离成功测试覆盖导航返回身份而不泄露正文、读取同一文本、脚本不执行、
来源与版本不匹配拒绝、不可信 provenance、禁用中断、RPC 取消及 late response、
审批拒绝不调用工具、Danger 两次调用仍两次审批。Host 测试覆盖跨 Session/Run/
标签/origin/version 拒绝和关闭后失效。

GUI 已验证导航审批与拒绝安全网络请求。公网成功 GUI 链路**尚未验收**：
example.com / rust-lang.org / wikipedia.org / developer.apple.com 在本机 DNS
均解析到 198.18.x.x（Fake-IP 代理保留段），safeFetch 正确拒绝；没有绕过
公网边界，也没有用真实 Provider 或用户登录页面替代验收。

本批不提供用户当前页面 DOM、登录态、动态 JS 内容、点击、填表、截图、Agent
下载。设计见 [B4 只读快照](BROWSER-AGENT.md)。这与完整 Browser Tool 的范围不同。

## 验证记录

全量 `pnpm test`：contracts 73、agent-core 65、runtime-client 25、Runtime 492
通过/4 Windows 跳过、前端 78、System Runtime 233；冒烟、终端故障矩阵 26/26
及白名单验证通过。B4 新增 7 项 Runtime 测试与 1 项前端审批展示测试包含在该全量结果中。
Host 默认测试 43 通过，关闭 feature 检查通过（已有及隔离未使用代码警告）。
最终 format:check、lint、根/前端 typecheck、build:packages、两个 Rust workspace
格式检查、Host 默认测试与 no-default-features 检查通过。macOS app/DMG 打包
通过；自包含资源复制至独立临时验收 app 后，Node/Rust sidecar 确认从包内
Resources/pkg 启动，Renderer 为 tauri://localhost。持久测试标记保留，网页
与默认媒体拒绝正常。正常退出后，本次 Host/Node/Rust 三个进程均消失，无验收孤儿进程。

最初手工验收 wrapper 缺少 NSMicrophoneUsageDescription，媒体测试触发 macOS
TCC SIGABRT；这是测试环境失败，未算通过。正式打包 Info.plist 的 camera/mic
说明存在；补齐同样声明并使用自包含产物后，重新验证为 NotAllowedError、
未出现 OS 授权或应用退出。缺失用途说明/旧 OS 的完整能力门槛矩阵仍待补。

第一次在受限沙箱运行最终全量测试出现 52 项本地监听 EPERM 和 1 项 OS 沙箱
环境不足；在支持本地监听与 OS 沙箱的环境重跑后全量通过，没有为此修改产品
安全边界。

Windows/Linux 原生浏览器及 B4 工具保持不可用、系统浏览器回退；未进行目标系统
真机或交叉编译，不把本机 no-default-features 检查当作跨平台验收。

## 可复现的合成环境

运行 `node scripts/browser-test-server.mjs`（127.0.0.1:47630），在独立测试
app/数据目录打开网页；持久标记、慢下载、同/跨来源重定向均来自该 fixture。
慢下载约五分钟，便于在原生保存流程结束后取消，目标应选临时目录新文件名。

运行 `node scripts/browser-agent-provider-fixture.mjs`（127.0.0.1:47631/v1），
仅在独立测试数据目录配置合成 Provider 与合成 key。模拟 Provider 按产品的
工具名称映射发起 navigate/read；在每次审批可拒绝或允许一次。网络和 Host
均使用生产边界，没有测试环境放宽开关。它是确定性协议 fixture，不是实际
模型对抗测试；公网 DNS 恢复正常后还需验证原生快照展示与真实模型回答。

## 只读浏览补齐：代码验证（同日后续批次）

标题/层级/安全链接/来源引用、from/linkId 原快照绑定导航、快照来源地址只读
已实现。采用离线 HTML 解析与构建/遍历双预算；敏感过滤与脚本隔离保持有效。
完整测试 Runtime 504 通过、4 Windows 跳过；前端 79、Host 45；其它全量套件、
静态检查及关闭 feature 检查通过。此前原生 GUI 和十分钟采样属于上一批证据，
不算作此批新控件和解析器的真机/性能通过。按用户“待验收的可以先等等”的
指示，公网 GUI、三平台及媒体/资源矩阵继续保留待验收；B4 功能设计见
[B4 设计](BROWSER-AGENT.md)。

本轮最终 macOS 自包含 app/DMG 打包通过（含原生提交时再次核对来源身份）；未重新执行 GUI/硬件/长期资源验收。

## Playwright 首批替代实现

静态读取已移除。内置受管官方 Playwright MCP 的导航/读取/关闭、真实动态 DOM、审批与页面身份绑定、取消/撤销/隔离及 Agent 证据回填已有合成回归。具体范围见 [当前 B4 设计](BROWSER-AGENT.md)。此前静态快照相关证据不适用于该实现；三平台真机矩阵、真实模型和网站兼容性仍待验收。

Playwright 首批最终验证：全量测试通过，Runtime 497 pass + 4 Windows skip、前端 78 pass、System Runtime 233 pass、宿主 41 pass，故障矩阵 26/26；format/lint/typecheck 与 macOS app/DMG 通过。随包 Node 和 Chromium 沙箱/stdio 冒烟通过；取消导航与强杀 worker 的受控进程回收检查通过。当前没有新增 GUI 或长稳验收结果；Fake-IP DNS 被策略拒绝，详见 B4 文档。
