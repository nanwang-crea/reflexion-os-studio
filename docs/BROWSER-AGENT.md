# B4：内置受管 Playwright MCP

实现方案采用内置工具门面与固定版本官方 Playwright MCP。用户无需配置 MCP 服务；Runtime 为每个 Run 懒启动独立 stdio worker，worker 通过官方 createConnection 与 MCP 内存传输调用 Playwright MCP，浏览器上下文不与用户 Surface、其他 Run 或通用 MCP 共享。

## 首批范围

browser.navigate、browser.read、browser.close；先导航取得页面身份，再按浏览器批准策略读取真实渲染后的无障碍快照。导航结果不向模型返回正文；读取校验 Session/Run/标签/来源/页面版本，并重新取快照核对内容摘要，页面变化要求重新导航取得新版本。导航可携带 from 绑定原页面；不带 from 时重新建立隔离页面。点击、输入、上传、下载、脚本执行、截图和登录态导入不在本批工具清单中。

不保留静态 HTML 抓取或离线只读标签。用户 Browser Surface 继续使用原生 WebView，不由 Playwright 接管。

## 审批与安全

默认 Agent 开关关闭。工具经 ToolRegistry、PermissionGate 与 ApprovalGateway；批准策略默认跟随对话权限：workspace-full 自动放行当前导航/读取/关闭，其他档位询问；也可设置每次询问或自动允许只读浏览。ask-everything 覆盖自动放行，Danger 本身不改变浏览器策略；通用会话 operation 规则不能旁路。审批主题展示实际目标及来源页面身份；非法或敏感参数在持久化之前拒绝且不回显。

浏览器使用临时上下文，不加载用户资料、凭据或历史；服务关闭页面下载、权限、Service Worker 和 WebSocket。首批只允许已批准来源的 GET/HEAD 请求，跨来源资源与重定向拒绝，需要用户批准新的来源。Playwright 请求路由检查 URL/方法；临时出口代理逐连接解析公网 DNS 并固定目标 IP，避免浏览器独立 DNS 解析绕过检查。代理是浏览器出口，不承载进程间协议；MCP 仅走 stdio/内存传输。

注入提示使用启发式检测，不宣称识别所有攻击；权限边界由工具白名单、批准策略和隔离执行维持。返回仅保留快照区块，丢弃 MCP 自动代码、日志、网络详情等；敏感内容拒绝返回，明确标记网页注入警告与 untrusted_external provenance，进入既有 canonical ToolOutput。机密过滤不能作为读取用户凭据的许可证。

关闭开关、取消、Run 结束与 Runtime shutdown 收回 worker 和浏览器。未知服务错误只返回固定安全错误，不记录网页正文或原始 MCP 错误。

## 分发与平台

固定 @playwright/mcp 版本和匹配 Playwright 版本；安装包仅携带受管 worker 和官方依赖，Chromium 由用户在设置 → Agent 浏览器中点击下载，不运行 npx/latest，不要求用户 npm 或外部 Node。

macOS、Windows、Linux 共用 Runtime/worker；Windows 使用 node.exe 与进程树回收，POSIX 使用进程组回收。Linux 仍需要 Chromium 系统库，缺失时明确报不可用，不能静默禁用沙箱。三平台分别构建并验收；Windows/Linux 真机状态保留待验收。本批不宣称完成点击/填表或完整 B4。

## 本批验证

macOS 合成动态页面已通过官方 MCP 渲染与快照读取；导航不泄露正文、页面变化拒绝旧版本、跨来源资源/重定向拒绝、密码控件拒绝、私有 DNS 与敏感参数拒绝、每次询问模式下 Danger 仍不旁路审批、stdio 工具白名单、取消握手与撤销隔离均有测试。合成 Provider 的 Agent 回路已验证两次审批、网页证据回填及 canonical ToolOutput 持久化；这不代替真实模型遵循率或完整网页矩阵验收。

本机 Fake-IP DNS 返回 198.18/15 时会被公网策略拒绝；使用正常公网解析的环境才能导航对应站点，不提供绕过内网拒绝的开关。Windows/Linux 真机及完整网站兼容性待验收。

固定依赖：@playwright/mcp 0.0.83、Playwright 1.64.0-alpha-1790635538000（官方 MCP 对应版本）。构建不下载 Chromium。用户显式下载固定版本的完整 Chromium 到数据目录；有头/无头共用同一套浏览器，不再包含 headless shell。默认无头，可在独立 Agent 浏览器设置中选择显示窗口。用户原生浏览器面板仍独立。Linux 缺失系统库时按 Playwright 官方安装说明配置构建/运行环境，不使用 --no-sandbox 变通。

最终验证：format/lint、根与前端 typecheck、全量构建/测试通过（Runtime 497 通过、4 个 Windows 项按平台跳过；前端 78、System Runtime 233、宿主 41 通过；终端故障矩阵 26/26）。macOS app/DMG 已生成；随包 Node/Headless Chromium 沙箱及 worker stdio 冒烟通过。受管导航取消和 worker SIGKILL 的本机检查确认记录到的 Chromium 子进程已回收。新 GUI/长稳和 Windows/Linux 真机验收按用户决定后置。

入口：设置 → 模型与工具 → Agent 浏览器；打开开关后发送新消息。默认不启动浏览器，首次经批准的工具调用才懒启动 worker。

显示模式：headless（默认）/headed。配置独立通过 agent_browser_settings.get/update；更新只合并 Agent 字段，不调用用户 Surface 或修改普通浏览器偏好。切换模式和关闭开关撤销当前 worker，下一次审批通过的导航按新模式启动。macOS/Windows 显示独立 Chromium 窗口；Linux 有头需要桌面显示服务，缺失时启动失败，不自动扩大权限或关闭沙箱。用户手动关闭窗口或改动页面后，原页面身份可能失效，需要重新导航；任务结束仍回收窗口。

显示模式补齐验收：macOS 有头 Chromium 的真实页面读取与手动导航失效检查通过；独立配置的持久化、普通浏览器偏好隔离和模式变更撤销通过。完整回归 Runtime 499 pass + 4 Windows skip、contracts 74 pass、前端 78 pass；宿主与构建检查通过。此前安装包曾同时携带 Chromium 与 headless shell；Windows/Linux 有头 GUI 验收仍待验证。

批准模式：follow-session（默认）、ask、allow-read-only。策略只覆盖当前三项只读工具，不自动授权未来点击、输入、提交或下载。浏览器开关仍须开启；无工作区会话也可以跟随本次 Run 的显式权限档位。改变批准模式收回现有 worker；配置持久化，页面身份和安全检查不随自动放行取消。

## 浏览器组件按需安装（2026-10-13）

设置展示未安装、下载中、已安装与失败状态，只有用户点击下载才联网；打开工具开关或 Agent 调用不触发下载。下载命令不向 Agent 工具注册表开放。用户原生 WebView Surface 不依赖该组件。

使用随包固定版本 Playwright 官方安装器（不运行 npx、不读取用户浏览器资料）。组件按 Playwright 版本、系统与架构隔离缓存。下载先进入暂存目录，检查可执行文件后原子发布，失败不发布半成品；重启后可重试。每个 Runtime 仅允许一个安装任务，关闭应用或取消下载回收进程树。

macOS、Windows、Linux 共用 Node 下载和安装代码；平台发行版由 Playwright 官方安装器选择。Linux 系统库仍需由用户/发行版提供，不自动调用 sudo，也不关闭 Chromium 沙箱。版本不匹配显示未安装，需要用户再次下载。

状态轮询仅在设置页有下载任务时启用，离开页面清理定时器；后台下载继续，重新打开设置可读取状态。进度表示当前组件的下载进度，未知进度显示不定进度状态，不伪造总百分比。

按需安装验证：新增 Runtime 安装生命周期测试 6 项、设置页真实 DOM 下载/取消/重试与空闲停止轮询测试通过；真实固定版本 Playwright CLI、可执行文件检查与原子发布通过（使用已有官方 Chromium 缓存的临时副本，没有重复联网下载大文件）。有头/无头与浏览器安全回归通过。完整 Runtime 503 pass + 14 skip，其中 10 项缺省路径跳过的 Rust/核心端到端测试在显式配置已构建二进制后补测全部通过，剩余 4 项为 Windows 平台测试；前端 81 pass，System Runtime 233 pass，契约、格式、lint、根/前端 typecheck 和宿主检查通过。包内 Node/Runtime 未安装状态及协议 shutdown 冒烟通过。

macOS 应用包约 156 MB，DMG 约 57 MB；浏览器工具代码约 20 MB，不再包含 Chromium。开发模式四次空闲瞬时采样：宿主、Node Runtime、新建 WebView CPU 均为 0%；该采样是本轮空闲观测，不是修改前后性能基线对比。Windows/Linux 真机、完整生产网络下载矩阵及原生设置窗口验收仍待验证；设置交互已由本地合成服务的真实 DOM 测试覆盖。
