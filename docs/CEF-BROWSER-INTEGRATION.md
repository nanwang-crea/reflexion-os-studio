# CEF 浏览器接入

分支：`codex/cef-browser-integration`。范围由用户明确授权：统一右侧浏览器和 Agent 浏览器，优先 macOS / Windows，Linux 明确降级。

## 边界

- Tauri 2 保留应用 UI、主窗口、sidecar 监管和可信 command；CEF 仅承载外部网页，无 Tauri IPC / 应用 scheme。
- 宿主管理 CEF 生命周期、原生父视图、标签、页面状态和临时上下文；Runtime 保留权限审批、来源校验、网页内容过滤和 Agent 工具执行。
- Runtime 通过既有 stdio JSON-RPC 的私有宿主请求取得受管页面连接，前端不得传入任意调试端点。调试端点不进入事件、聊天、数据库或错误。
- Agent 使用会话专属临时标签；只有经过审批的工具调用才能创建/控制，其他标签和应用 WebView 不向工具暴露。用户接管会撤销 Agent 当前操作权；恢复必须重新读取页面身份和快照。
- Chromium 沙箱必须开启。Windows 使用 CEF 官方 sandbox bootstrap / DLL 入口；macOS 使用 helper bundles。不可通过关闭沙箱换取“跨平台支持”。
- 消息循环采用 CEF `on_schedule_message_pump_work` 回调驱动，只保留一个可重排的定时器；不以常驻 16ms 轮询实现。
- macOS：NSView 子视图、Retina/CSS 坐标转换、CEF NSApplication 协议、helper/frameworks 打包。
- Windows：HWND 子窗口、DPI/焦点、官方 sandbox bootstrap、CEF DLL/资源打包。CEF 154 的窗口句柄是 `cef::sys::HWND` 包装类型，与 Tauri 的 HWND 通过其内部原始指针转换；转换集中在 `cef/handles.rs`，不能将包装类型直接 `as usize`。macOS 继续使用 NSView 原始指针，Linux 不编译此 CEF 嵌入模块。
- Linux：当前迁移不启用 CEF 原生嵌入，保留明确不可用/系统浏览器回退；X11/Wayland 另行真机验收，不能静默提供半成品。

## 验收

原型证据见 `CEF-VALIDATION-2026-10-17.md`。正式接入须重新验证：真实产品窗口内的导航、标签/历史、缩放和隐藏、输入法、Agent 动作与人工接管、跨会话隔离、取消/重启/退出、无孤儿进程、空闲资源、开发态和安装包。
Windows 本机未有真机环境时必须标明未验收；编译/静态检查不等于 GUI 验收。

## 构建与开发

macOS 需要 Xcode Command Line Tools、CMake、Ninja；Windows 需要 MSVC C++ 工具链、Windows SDK、CMake、Ninja。macOS 安装方式：`brew install cmake ninja`（须在 PATH 中，如 `/opt/homebrew/bin`）。cef-dll-sys 构建脚本报 "is `cmake` not installed?" 即为缺这两个工具——不要把工具临时装进 `/tmp` 再手工加 PATH，重启即失效。通过官方 cef-rs 固定版本 `154.5.0+154.0.34` 准备 CEF，首次需联网。不要设置 `--no-sandbox`。

```sh
pnpm prepare:cef
pnpm dev
pnpm build:desktop
```

开发构建在 `.cache/cef-native/ReflexionOS Studio Dev.app` 内运行，以满足 Chromium 沙箱对 macOS bundle/helper 的要求；原始 debug 二进制会复制自身并转入该 bundle。Windows 开发使用官方 bootstrap 与匹配的 sandbox DLL。安装包包含 CEF、helper/bootstrap、运行资源、Node、Runtime、Playwright MCP 及许可，不要求用户安装 Chrome、Node 或单独下载 Agent Chromium。

旧网页引擎已清理（2026-10-17）：移除独立 WKWebView、WebView2、WebKitGTK 网页适配器以及旧 guest registry、弹窗、下载和初始定位脚本，不再保留 Windows 的非 CEF 引擎分支。默认构建仅启用 `cef-browser`，旧 `browser-spike` feature 已删除；原生密码管理、Chrome/Edge 迁移和联系信息填充继续由 CEF 使用。macOS/Windows 的网页嵌入只走 CEF；Linux 及 `--no-default-features` 构建明确不可用，保留系统浏览器入口。

Tauri/Wry 仍负责 React 应用界面，因此其 WebKit/WebView2 传递依赖不属于旧网页引擎残留。`objc2-web-kit` 仅保留定位宿主 WKWebView 所需的类型，用于 CEF 坐标换算，不创建第二个网页视图。Playwright MCP 是 Agent 自动化层，CEF 构建连接受管 CEF 页面；无 CEF 平台或无宿主 Runtime 的受控 Chromium 启动支持不属于用户 Browser Surface。CEF 构建固定设置 Runtime 的宿主引擎选择，不受初始化是否成功影响；启动失败明确报错，不静默启动独立 Chromium。`scripts/browser-test-server.mjs` 是共享合成站点，`scripts/cef-spike/` 是 CEF 接入验证工具，均不注册产品引擎。

清理与 review 验证：默认 CEF 宿主 45 项测试、`--no-default-features` 宿主 31 项测试、System Runtime 236 项测试、前端 84 项测试通过；格式、lint、双 TS typecheck、packages 构建、Rust check/fmt 与最终 `.app` / DMG 构建通过。前端测试首次受回环监听限制，正常宿主权限重跑后另有一项既有混合换行时间预算在编译高负载下失败，编译结束后全套重跑通过。首次打包与 packages 构建争用前端产物导致资源缺失，串行重跑解决；DMG 创建需要正常宿主权限。最终包启动日志确认 CEF 和两个 sidecar ready，但本轮最终原生关窗复测受 Mac 锁屏阻挡，未计为通过；先前关闭修复的 GUI 证据仍见生命周期回归记录。Windows/Linux 本轮未做真机 GUI 验证。

Review 补修：宿主不再根据 `cef::ready()` 决定 Runtime 是否使用 CEF。引擎选择在应用构建边界固定，并在设置其他 sidecar 环境后写入，避免初始化失败或环境覆盖让 Runtime 启动独立 Chromium；非 CEF 构建清除继承的引擎选择。宿主回归覆盖初始化前的选择与降级构建，Runtime 回归覆盖连续两次嵌入导航失败均不解析独立浏览器启动选项。Runtime 嵌入相关 4 项测试通过。

## 产品原生接管验收

仅调试构建可启用 `cef-acceptance`。它固定选择仓库内的合成测试 driver，不读取个人 Chrome、真实凭据或真实 Provider，也不向产品命令注册测试接口。release 构建即使误传该 feature 也不会加载 driver。

```sh
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin reflexion-desktop --features cef-acceptance
REFLEXION_DATA_DIR=/tmp/reflexion-cef-acceptance \
CEF_ACCEPTANCE_OUTPUT=/tmp/cef-acceptance-result.json \
apps/desktop/src-tauri/target/debug/reflexion-desktop
```

macOS 调试界面需要先启动 Vite。driver 自动创建临时同源网站、执行 Agent 中文输入与点击、验证另一会话看不到输入，并关闭第二个标签。结果为 `await-takeover` 后，在右侧点“接管操作”，将“公开查询”改为 `人工接管输入` 并点“应用”，再点“交还 Agent”。最终 JSON 应为 `passed`，且 `isolation`、`agentInput`、`takeoverBlocksAgent`、`manualStatePreserved`、`screenshot` 均为 true。

2026-10-17 在实际 Tauri 产品窗口复验通过以上全部项目；接管期间 Agent 导航被拒绝，交还按原 TargetId 恢复，人工输入保留；关闭子标签不退出主应用。额外回归覆盖后台动画帧暂停时的状态/尺寸同步及空闲不轮询。dev 模式 `top -l 4 -s 3` 末次采样：宿主、Node Runtime、CEF GPU helper 均为 0.0% CPU；对应 `top` 内存约 105 MB、119 MB、32 MB。此采样是页面关闭后的空闲场景，不代表复杂网页资源上限。

Windows 原生输入、IME、高 DPI、沙箱 bootstrap、下载与退出需要 Windows 真机验证。Linux 维持明确不可用与系统浏览器回退。签名、公证、真实站点登录及长期稳定性未在本次合成验收中验证。

## 最终构建与回归结果（2026-10-17）

- `pnpm format:check`、`pnpm lint`、根级与前端 typecheck、`pnpm build:packages` 均通过。
- Runtime：730 通过，17 按原有平台/环境条件跳过；前端：88 通过；runtime-client：25 通过。
- Rust System Runtime：236 通过；Tauri Host：42 通过；两个 Cargo workspace 的格式检查通过。
- 默认 CEF、无默认特性的降级构建均在 macOS 编译检查通过（旧 `browser-spike` 构建选项已删除）；Windows 编译与 GUI 未在本机执行。
- `pnpm build:desktop` 生成自包含 `.app` 和 `.dmg`，约 492 MB / 199 MB；嵌入前端资源探针通过。
- `node scripts/smoke-workspace.mjs --packaged` 通过，涵盖包内 Node / Runtime / System Runtime、索引、文件读取、Git diff 与干净退出。
- 将最终 `.app` 复制到仓库外的 `/private/tmp`，只修改 QA 副本的 bundle 标识以避开已打开的用户应用；产品代码、CEF、helper 和包内资源保持一致。UI 启动、网页导航、脚本执行、网页无 Host IPC、下载保存及完成记录通过。合成下载文件内容核验一致，46/46 字节，跨来源重定向显示明确拒绝提示。
- 下载适配在此验收中修复了主线程阻塞保存对话框和提前到达的进度回调误取消问题。保存位置选择在后台等待，记录和 CEF continuation 回主线程处理，排队和活动下载共用上限。联系信息的原生确认也改为异步等待，保留页面 revision 复核与用户确认后才填充的边界。
- 包内 Node 从仓库外实际导入 `playwright` 和 `@playwright/mcp` 成功。macOS 用规范路径启动；`/tmp` 本身为符号链接，Tauri 的安全路径检查会拒绝该启动路径，不通过关闭此保护规避。

尚未验证真实 IME 组合输入、Windows 真机、Linux 原生嵌入、签名/公证、真实网站登录、真实凭据迁移和长期运行。未为验收读取个人浏览器资料。

## 生命周期与消息调度收敛（2026-10-17）

用户报告百度搜索结果打开时整个应用退出。17:17、17:28、17:31 的 macOS 崩溃报告均指向主线程 CEF 消息泵中的 `NSView dealloc` 断言。代码检查发现原生视图关闭、容器释放和父窗口销毁没有统一收敛，且 Tauri `run_on_main_thread` 在主线程会立即执行，不能用于隔离 CEF 回调中的同步创建。

现在由 CEF lifecycle 持有存活 Browser ID 集合，关闭主窗口先停止接收新页面并请求关闭所有子页面；`OnBeforeClose` 立即释放 Browser 引用，退出回调后再释放原生容器。收到全部子页面关闭确认后先把 Wry 容器恢复为原来的 `NSWindow.contentView`，再允许 Tauri 关闭主窗口并释放 Wry 渲染资源；窗口销毁返回后停止消息泵、执行 `CefShutdown`，再进入 Runtime 协议退出。单纯脱离 Wry 容器的旧方案仍会发生 Zombie release，已由恢复窗口持有关系替代，详见回归记录的 23:22 同环境对照。CEF 的全局 Cocoa 集成不早于 Wry 资源销毁。`DoClose` 只销毁 CEF 子视图/子 HWND，不关闭顶层窗口。macOS 原生容器由 input 模块持有，隐藏标签的容器从父视图脱离但保持持有，重新激活时挂回，避免遮挡及切换后黑屏。

统一 dispatcher 在 CEF 消息泵返回后执行原生变更，popup、用户命令、Agent 请求、下载 continuation、凭据确认返回和 Runtime 故障回收均经该队列。调度器合并最早截止时间，以 posted/running 防止重复投递和嵌套模态循环重入；停止后清空待执行任务并拒绝新调度，兜底消息泵有界退出，不常驻轮询。

macOS 已完成 30 轮合成导航/弹窗关闭、5 轮原生界面关闭结果标签、百度搜索结果实际打开与恢复、下载取消、接管交还及退出测试。证据、复跑方法和平台限制见 [生命周期回归记录](CEF-LIFECYCLE-REGRESSION-2026-10-17.md)。这次验证覆盖已知故障路径，不等于无限时长稳定性或 Windows 真机验收。

## 2026-10-18 系统网络调整

Agent 临时 CEF RequestContext 使用 `proxy.mode=system`，上下文配置成功前保持网络关闭。租约协议不再携带应用出口代理地址；Runtime 不再做域名公网 DNS 预检查或启动本地出口代理。独立 Playwright worker 不覆盖 Chromium 代理设置，三个平台分别使用 Chromium 对应的系统网络实现。审批、同源 GET/HEAD、凭据保护及应用内部来源拒绝保持；获准域名可能解析到本机可达网络，不保证仅公网隔离。web.fetch 不在本次调整范围。

debug 验收 driver 可额外设置 `CEF_ACCEPTANCE_NETWORK_URL=https://www.baidu.com/`，先使用独立租约导航并读取公开页面，再继续原有合成接管验收；默认不依赖外网。成功输出 `[cef-network-probe]` 标题与来源，不读取日常浏览器资料。

本轮独立 Chromium 与内嵌 CEF 均实际打开百度并返回“百度一下，你就知道”。CEF 合成页面加载、中文输入与会话隔离通过，driver 达到 `await-takeover`；本轮未重复人工接管及交还验收。最初使用产品标识启动 QA 时 CEF 初始化失败，独立 Tauri 标识隔离缓存后成功，未修改产品缓存。Windows/Linux 本轮未做真机网络验收。

验证通过：format/lint、根级与桌面 typecheck、packages 构建、完整 `pnpm test`（Runtime 754 pass / 4 Windows skip、前端 85、System Runtime 237、终端故障矩阵 26/26）、默认 CEF 宿主 47 项与无 CEF 宿主 31 项单测、两个 Cargo 格式检查、默认宿主编译、macOS app/ARM64 DMG 打包及包内 workspace 冒烟。未执行 Windows/Linux 真机或本轮长稳测试。

## 2026-10-18 浏览器凭据限制移除

按用户明确要求，移除整页凭据扫描及其强制关闭分支、URL 路径/参数关键词拦截、输入文本凭据形态过滤、密码/验证码控件与 GET 凭据表单拒绝、可编辑控件截图遮罩。Runtime 提示与主 Agent 指令同步更新。旧 browser_sensitive_content 枚举仅兼容历史结果，当前 worker 不产生此错误。审批、页面身份、临时会话隔离、应用内部来源、同源 GET/HEAD、支付/上传、iframe 遮罩及截图大小限制保持。该调整不新增个人浏览器资料、系统凭据或浏览器上下文存储读取 API。

本轮只使用合成页面与合成输入验证，不读取真实凭据或个人浏览器资料。三平台复用契约与 Runtime 实现；Windows/Linux 真机交互仍待验收。

本轮最终验证：format、lint、根级/桌面类型检查与完整 `pnpm test` 通过（Runtime 754 pass / 4 Windows skip、前端 85、System Runtime 237、终端故障矩阵 26/26）；两个 Cargo 格式检查与宿主 cargo check 通过；macOS app/ARM64 DMG 及包内 workspace 冒烟通过。合成有头/无头页面均验证密码与验证码输入、同源 GET 登录表单；尚未验证真实网站登录、Windows/Linux 真机与本轮长稳。

## 2026-10-18 可见浏览器操作

按用户明确决定，移除整页摘要冻结、跨站与请求方法限制。read 原地获取动态快照；标签身份跨导航保留，临时会话不会因换来源重建。正常资源、POST 表单、重定向、WebSocket 与 Service Worker 交给 Chromium。CEF 保留内部应用来源和非网页主导航限制，允许 blob/data 子资源。Agent 新标签链接和 CEF HTTP 弹窗目标复用当前可见租约；用户接管后允许地址栏和历史导航。

导航失败等待 Chromium 在途错误页提交后返回分类结果，不重试、不关闭可恢复标签。执行结果 failurePhase 区分动作前、动作中与动作后观测失败；completed 记录已执行动作，避免把读取失败当作未提交。wait/goto 不依赖旧页面先能抓取快照。新设置默认可见模式，已有显式设置保留。脚本仍是有界动作语言，未增加任意 JS、宿主文件、其他会话或上下文存储访问。
