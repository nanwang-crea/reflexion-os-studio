# Browser Surface

当前状态（2026-10-13）：macOS 默认开发/发布启用，B4 已接入内置受管 Playwright MCP 首批工具，静态读取已移除，见 [B4 设计](BROWSER-AGENT.md) 与 [本机验收记录](BROWSER-ACCEPTANCE-2026-10-13.md)。
下文早期 Spike 的 debug-only/发布关闭描述由此更新替代；
Windows/Linux 用户原生 Surface 保持待验收；Agent 的点击、输入与登录能力仍未开放。

Browser Surface 是用户操作的隔离网页浏览区域，不是 Chat Core 的依赖。

## 首版范围（2026-10-11）

- 任意域名的 HTTP / HTTPS，包括 localhost 与内网；地址栏省略协议时补 HTTPS，失败后由用户选择 HTTP，不静默降级。HTTP 明示不安全连接。
- 网站自己的 JavaScript 与用户交互可用。“只读”仅指 Agent 当前不能读取、点击、填表或执行脚本，不承诺网页交互不会修改远端数据。
- 多标签、地址栏、后退、前进、刷新、停止、失败提示和系统浏览器打开。
- 独立临时 Cookie / 存储；默认不共享系统浏览器登录资料，用户可显式迁移，清除会话时销毁 Cookie。导入密码保存在独立 Keychain 条目，可单独删除。
- 禁止网页访问 Tauri IPC、Runtime、文件工具、应用事件与内部资源协议。
- 不支持下载、上传、持久化登录资料、任意外部应用协议和证书校验绕过。

## Spike 与发布边界

用户浏览器位于主窗口右侧面板，与工作区切换；聊天始终保持在中间且输入框可用。右侧面板可调整宽度、收起保活，关闭销毁临时会话。工具栏是可信应用 UI，网页是不注入 IPC、初始化脚本或自定义协议的原生 WebView，不能把远程网页当作应用 Renderer。
Host 负责窗口和原生适配；contracts 定义 Surface 契约，runtime-client 提供 typed facade，前端 api 层调用。Surface 命令不加入 Runtime 的命令或 Agent 工具表。

Spike 仅在显式启用 Cargo `browser-spike` feature 的 debug 构建可用，普通开发/发布构建均使用系统浏览器。macOS 用独立非持久化 WKWebView；Windows 的 WebView2、Linux 的 WebKitGTK 在原生权限与上传边界验收前返回 unavailable，保持 HTTP / HTTPS 系统打开回退。不能把静态检查写成三平台完成。
（2026-10-17 状态更新：macOS 的 WKWebView spike 适配器已删除，普通与发布构建改用 CEF，见 `docs/CEF-BROWSER-INTEGRATION.md`；本节保留为历史设计记录。）

发布前必须证明程序化剪贴板、定位、通知、拖放上传、子框架与原生权限边界，并完成三平台真机与打包验收。不能用网页内 JavaScript 补丁作为这些能力的安全边界。现阶段不对实验窗口作“所有系统权限均已封锁”的承诺。

## URL 与导航

顶层地址只允许 HTTP / HTTPS，有 host、无 username/password。file、data、blob、javascript、tauri、asset、ipc 及其他应用协议拒绝；网页自己的正常子资源不采用顶层协议白名单。对每次导航、重定向、弹窗请求复核。应用开发服务器和 tauri.localhost / asset.localhost / ipc.localhost 不是可浏览目标。

失败保留请求地址与重试、系统打开入口，不自动弹出系统浏览器；Surface 不可用时 Resource Router 直接回退系统浏览器。审计只记录动作、协议、域名、端口和结果，不记录 path、query、fragment、页面正文或原生错误详情。

## 后续 Agent Browser Tool

用户已明确要求后续开放网页读取和操作。后续单独设计 Browser Tool：页面快照、内容提取、点击、填表和受控导航。用户 Surface 的多标签与显式迁移已独立实现，不能直接授予 Agent。它们经 Runtime / ToolRegistry / PermissionGate 调用，绑定 surface、页面版本、origin 和具体操作，并有取消与审计。
网页正文属于不可信输入；不能沿用用户 Surface 命令绕过 Agent 审批，不能开放任意 Host IPC 或直接把 DOM 注入 Chat/Memory。当前不注册这些工具，也不实现空壳接口。

Spike 证据、阻塞项与验收矩阵见 [Browser Spike 报告](BROWSER-SPIKE-REPORT.md)。

## 基础浏览能力扩展（2026-10-11）

用户授权将右侧浏览器扩展为多标签，并选择直接从系统浏览器迁移。
每个标签独立保存网页、标题、导航历史；同一浏览面板共享独立临时
WebsiteDataStore，关闭单个标签不删除其他标签的登录态，关闭整个浏览会话
销毁全部标签与临时数据。最多 24 个标签，后台回调只更新所属标签。

导入必须由可信应用界面的用户动作触发，来源、类型与结果须明确。
源浏览器数据、系统解密密钥、明文密码和 Cookie 不得进入 Agent、Runtime、
IPC 响应、日志或测试夹具。不得通过当前 Agent 工具读取真实浏览器资料。
三平台迁移适配分别依赖 macOS Keychain、Windows DPAPI/App-bound encryption、
Linux Secret Service；无法解密的版本必须拒绝并明确说明，不得静默算作成功。
Safari/Firefox 的密码存储不是 Chromium 格式，不得用同一适配器处理。
现有非 macOS 原生 Surface 仍保持不可用，不能承诺导入后的跨平台浏览已完成。

macOS 实验适配：直接读取用户确认的 Chrome/Edge 配置只读 SQLite 快照，
系统 Keychain 获取来源 Safe Storage 密钥，支持 v10 AES-CBC/PBKDF2 及
Cookie 数据库 v24 域摘要绑定。不支持的加密/数据库结构停止导入。
密码写入独立应用 Keychain 条目，界面只收到网站和账户序号；用户显式选择
填入时，固定原生操作再次校验当前主 frame HTTPS origin，不自动提交。
这是用户密码填充的限定脚本例外，仍不向 Agent 暴露 evaluate/DOM/点击工具。
Cookie 写入共享临时 WKHTTPCookieStore，保留 Secure/HttpOnly/SameSite 属性，
不支持的安全属性拒绝；分区 Cookie 不迁移。原生二次确认先于源数据读取。
Windows/Linux 适配未实现，命令和按钮不可用；正常发布构建同样不可用。

### 浏览器界面复用

浏览器采用紧凑标签栏、胶囊导航/地址栏、可关闭的导入横幅和右上角菜单。
菜单使用 Radix Dropdown Menu，复用其键盘导航、Portal 定位与焦点恢复。
菜单展开时隐藏原生网页视图，关闭后恢复，避免原生视图遮挡菜单。
导入与密码管理复用已有原生确认流程；清除临时会话不会删除钥匙串密码。
查找、缩放、打印与浏览器设置/历史/下载菜单已接实验原生路径；能力按平台报告，未支持项保持不可用。

继续复用系统浏览引擎而非维护自有浏览器内核：macOS 使用 WKWebView，
Windows 使用 WebView2，Linux 使用 WebKitGTK。引擎复用不代表后三个平台
的隔离适配已经验收；当前原生 Browser Surface 仍仅为 macOS 实验实现。
完整 Chromium/CEF 接入需要另行处理进程、分发和权限边界，不是 UI 组件替换。

## 设置与后续能力规划

常规偏好、数据/历史、密码与自动填充、下载、网站权限和 Agent 权限统一规划见
[浏览器设置与能力规划](BROWSER-SETTINGS-PLAN.md)。B1 设置与路由已实现，真机验收状态见该规划；B2–B3 已有 macOS 实验实现，完整验收与缺口见该规划；B4–B5 仍为待实施批次。

### macOS 默认启用更新（2026-10-12）

按用户决定，macOS 12+ 的原生内嵌浏览器在默认开发与发布构建中启用；
不再受 debug-only 限制。Cargo 默认启用现有 browser-spike feature，显式
`--no-default-features` 仍可关闭。Windows/Linux 保持不可用并回退系统浏览器。
持久配置仍需 macOS 14+，媒体权限仍检查 bundle 的用途说明，其余权限约束不变。
此更新取代上文历史记录中的 macOS 发布关闭规则，不代表待补真机验收已完成。
默认链接路由仍尊重已有设置，用户可在浏览器设置中选择内嵌打开。

### 2026-10-12：主内容区与导航稳定性

网页默认占据中间主内容区。加载提示使用固定高度区域，导入横幅只在起始页显示，避免导航改变网页视口高度。macOS 原生网页保留当前画面直到新文档提交，并在提交时显示新网页，不再等全部资源加载后切换显隐。视口请求仅在尺寸、可见性或活动标签变化时同步，关闭再打开仍重新同步。Windows/Linux 继续系统浏览器回退。实际交互抖动与三平台布局仍需真机复测，编译通过不代表视觉验收完成。

### 2026-10-12：聊天并排与页面兼容性修复

修正主内容区覆盖聊天的问题：浏览器居中，聊天在右侧，Composer 与聊天状态持续保留。macOS 视口先在实际应用 WKWebView 坐标系中处理 CSS 顶部原点，再转换到原生网页父视图；支持 flipped / 非 flipped 视图并限制在 Renderer 范围内，避免窗口内容区域与 Renderer 不一致时覆盖工具栏。

HTTP 页面通过 `NSAllowsArbitraryLoadsInWebContent` 放开 WebView 的 ATS 限制，主 Renderer 仍受既有 CSP 限制，TLS 证书验证未增加绕过处理。新窗口返回使用 WebKit 提供配置创建的隔离网页视图，保留原始请求（含 POST、referrer 与 opener）；初始 `about:blank` 允许内部导航，应用 origin / file / 自定义协议仍拒绝。状态查询仅返回导航状态，不再根据 `isLoading=false` 把失败状态改成 ready。长加载或失败提供重试、系统浏览器入口，协议切换仅由用户点击触发。Windows/Linux 继续系统浏览器回退。

HTTP 配置依据 [Apple ATS 文档](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloadsinwebcontent)。自动验证覆盖双坐标方向、视口边界、协议策略、类型检查和打包；本轮界面实测受 Mac 锁定阻碍，不能将自动检查视为截图问题已通过视觉验收。

### 2026-10-12：按用户澄清恢复面板位置

聊天保持在中间，浏览器继续使用右侧面板。此更新取代上文将浏览器移动至主内容区及将聊天放在右侧的布局说明，保留导航、HTTP、新窗口请求与原生坐标修复。“网页居中”仅指右侧视口中的网页内容。

macOS 新文档首次加载完成、初始样式布局稳定后执行一次横向定位：仅当网页宽于视口、用户尚未横向滚动且没有锚点时，将横向可滚动范围居中，保留纵向位置；后退、前进和刷新保留已有位置。定位等待 DOMContentLoaded（已就绪时直接执行），没有常驻轮询，也不修改网页 CSS、注入 IPC 或回传网页内容。响应式网页保持站点原有布局。Windows/Linux 仍使用系统浏览器。

### 2026-10-12：稳定加载与实际导航地址

加载由 WebKit estimatedProgress 驱动细进度条；状态事件通过前端逐帧合并，标签保留已有标题，不反复显示加载占位文字。重定向和文档提交立即同步实际 HTTP/HTTPS 地址，不再等待所有资源完成。地址编辑中的草稿保持稳定，加载中的请求不作为已确认 HTTP 连接显示“不安全”。HTTP 跳转 HTTPS 由站点/引擎决定，应用不自动切换协议；移除失败提示中的协议切换快捷按钮，显式地址输入仍支持 HTTP 和 HTTPS。

网络失败保留已提交的网页，旧导航的完成/失败回调不能覆盖新导航；网页进程退出才隐藏失效原生视图。子框架下载响应不再改变整页状态或隐藏页面。布局仍为聊天居中、浏览器右侧。macOS 实现真实原生进度；Windows/Linux 不开放原生浏览器，协议 progress 缺失时默认 0。自动检查不能替代动态网页视觉验收。

本轮已在 macOS 打包版本实测：HTTP 百度地址跳转 HTTPS、页面“更多”打开新标签、无效域名失败保留已有网页且显示恢复入口；提交地址后退出编辑状态，以实际地址替换输入草稿。空闲采样宿主与两侧进程 CPU 均为 0%。验证只覆盖上述场景，不代表所有站点或三平台真机验收完成。
