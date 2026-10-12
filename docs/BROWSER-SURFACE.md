# Browser Surface

Browser Surface 是用户操作的隔离网页浏览区域，不是 Chat Core 的依赖。

## 首版范围（2026-10-11）

- 任意域名的 HTTP / HTTPS，包括 localhost 与内网；地址栏省略协议时补 HTTPS，失败后由用户选择 HTTP，不静默降级。HTTP 明示不安全连接。
- 网站自己的 JavaScript 与用户交互可用。“只读”仅指 Agent 当前不能读取、点击、填表或执行脚本，不承诺网页交互不会修改远端数据。
- 多标签、地址栏、后退、前进、刷新、停止、失败提示和系统浏览器打开。
- 独立临时 Cookie / 存储；默认不共享系统浏览器登录资料，用户可显式迁移，清除会话时销毁 Cookie。导入密码保存在独立 Keychain 条目，可单独删除。
- 禁止网页访问 Tauri IPC、Runtime、文件工具、应用事件与内部资源协议。
- 不支持下载、上传、持久化登录资料、任意外部应用协议和证书校验绕过。

## Spike 与发布边界

用户浏览器位于主窗口右侧面板，与工作区标签切换；聊天保持在中间。面板可拖动宽度、收起保活，关闭销毁临时会话。工具栏是可信应用 UI，网页是不注入 IPC、初始化脚本或自定义协议的原生 WebView，不能把远程网页当作应用 Renderer。
Host 负责窗口和原生适配；contracts 定义 Surface 契约，runtime-client 提供 typed facade，前端 api 层调用。Surface 命令不加入 Runtime 的命令或 Agent 工具表。

Spike 仅在显式启用 Cargo `browser-spike` feature 的 debug 构建可用，普通开发/发布构建均使用系统浏览器。macOS 用独立非持久化 WKWebView；Windows 的 WebView2、Linux 的 WebKitGTK 在原生权限与上传边界验收前返回 unavailable，保持 HTTP / HTTPS 系统打开回退。不能把静态检查写成三平台完成。

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

右侧面板采用紧凑标签栏、胶囊导航/地址栏、可关闭的导入横幅和右上角菜单。
菜单使用 Radix Dropdown Menu，复用其键盘导航、Portal 定位与焦点恢复。
菜单展开时隐藏原生网页视图，关闭后恢复，避免原生视图遮挡菜单。
导入与密码管理复用已有原生确认流程；清除临时会话不会删除钥匙串密码。
尚未实现的查找、打印、下载和持久历史菜单明确禁用。

继续复用系统浏览引擎而非维护自有浏览器内核：macOS 使用 WKWebView，
Windows 使用 WebView2，Linux 使用 WebKitGTK。引擎复用不代表后三个平台
的隔离适配已经验收；当前原生 Browser Surface 仍仅为 macOS 实验实现。
完整 Chromium/CEF 接入需要另行处理进程、分发和权限边界，不是 UI 组件替换。

## 设置与后续能力规划

常规偏好、数据/历史、密码与自动填充、下载、网站权限和 Agent 权限统一规划见
[浏览器设置与能力规划](BROWSER-SETTINGS-PLAN.md)。B1 设置与路由已实现，真机验收状态见该规划；B2–B5 仍为待实施批次。
