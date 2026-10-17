# Browser Surface Spike 报告

> 2026-10-17 更新：本文中的 WKWebView / WebView2 / WebKitGTK 网页实现及 `browser-spike` 构建选项属于历史记录，现已移除。当前实现与构建方式见 [CEF 接入](CEF-BROWSER-INTEGRATION.md)；不能按下文旧命令启用旧引擎。

日期：2026-10-11（历史 Spike）。当前状态以 [2026-10-13 验收报告](BROWSER-ACCEPTANCE-2026-10-13.md) 为准：macOS 默认开发/发布启用，B4 静态读取已移除，改为内置受管 Playwright MCP 首批导航/读取/关闭；下文是早期实验记录，不能作为当前发布开关或功能范围。

## 结论与发布状态

独立原生网页视图 + 可信工具栏的方案可行，已经实现可运行的 macOS 原型，并实测 HTTP / HTTPS、内网、网页 JavaScript、导航、上传/下载拦截与临时 Cookie 销毁。

**这是 Spike 交付，不是三平台浏览器发布完成。** 原型只在 macOS 12+、显式 `browser-spike` feature、debug 构建三个条件同时成立时开放。默认开发与 release 构建不创建原生网页视图；网页链接走系统浏览器，工具栏可作为系统浏览器的网址入口。Windows / Linux 原生适配未实施，保持 unavailable；不能声称已实现或验证三平台内嵌浏览。

发布阻塞项是完整原生权限封锁、Windows/Linux 真机适配、SPA 地址/历史变化观测、右侧内嵌布局完整矩阵和长期资源回收验收。尤其不能把“无 Tauri IPC”或“隐私模式”解释为网页所有 OS 能力均已封锁。

## 实现与边界

- contracts 的 `BrowserActionSchema` / `BrowserSnapshotSchema` 是 TS 契约真源，并导出 JSON Schema；Surface 不进入 Runtime 命令注册表或 Agent 工具集。
- runtime-client 提供 Host typed facade，校验输入、响应和事件。React 组件只调用前端 api 层。
- 可信工具栏集成主窗口右侧，工作区/浏览器标签切换；不再创建 `browser-toolbar` 窗口。原生网页操作在主线程串行执行，网页位置来自测量后的 viewport。macOS 使用 NSWindow contentLayoutRect 转换坐标以排除标题栏偏移。
- macOS 网页是全新 WKWebView + `nonPersistentDataStore`，不注册 Tauri IPC、脚本消息处理器、应用自定义协议或初始化脚本；不复用工具栏或系统浏览器的配置/登录资料。
- main 可以调用 bootstrap、Runtime、系统打开与用户 Surface 控制；远程网页没有命令能力。自定义命令经过 AppManifest capability 与调用者 label/origin 双重约束。
- 单 Surface 网页；收起或切换标签保留 view 和临时会话，关闭释放原生 view、delegate 和临时数据。关闭主窗口同时释放 Surface，保持原有 sidecar shutdown 生命周期。
- 每次网页导航和弹窗复核 HTTP / HTTPS、有 host、无账号密码；拒绝本地文件、内部协议、应用资源 origin 和正在使用的开发服务器（含常见 loopback 别名）。正常网页子资源遵循 WebKit 自身的 origin/协议边界。
- 地址栏省略协议时默认 HTTPS，HTTP 由用户显式选择；不忽略证书错误，不静默降级。弹窗链接复用当前 Surface，不创建无限窗口。
- 加载失败保留请求地址，隐藏旧页面，提供重试和系统打开；Surface unavailable 时 Resource Router 回退系统浏览器。
- 审计只写动作、scheme/host/port 和结果，不写 URL path/query/fragment、正文或原生错误详情。完整地址只存在 Host 内存与可信工具栏状态中，不发送给 Runtime、Chat 或 Memory。
- 订阅只接线一次，有卸载清理；用 revision 拒绝旧状态；只有 loading 时启动一个 30 秒一次性提示定时器，无常驻轮询、逐帧心跳或 DOM 注入。

## 三平台能力矩阵

| 能力                     | macOS / WKWebView                                           | Windows / WebView2                            | Linux / WebKitGTK                      |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| HTTP / HTTPS 系统打开    | 既有 `open` 路径扩展 HTTP                                   | 既有 `rundll32` 路径扩展 HTTP，未真机         | 既有 `xdg-open` 路径扩展 HTTP，未真机  |
| 独立网页视图             | 原型实测                                                    | 尚未实施；不可用回退                          | 尚未实施；不可用回退                   |
| 临时存储                 | 非持久化 DataStore；合成 Cookie 关闭后消失                  | 待独立 InPrivate/profile 及销毁验证           | 待独立 ephemeral WebContext 验证       |
| 无宿主 IPC               | 原生视图不注册任何桥；合成页面确认                          | 后续须使用不注入 IPC 的原生视图               | 后续须使用不注入 IPC 的原生视图        |
| 导航、弹窗               | 原生 delegate；实测前后退/同窗弹窗                          | 待 NavigationStarting/NewWindowRequested 适配 | 待 decide-policy/create 适配           |
| 下载                     | 下载 action 与附件/MIME response 拒绝；实测                 | 待 DownloadStarting 及其他保存路径审计        | 待 download-started 及其他保存路径审计 |
| 文件选择上传             | UIDelegate 返回空结果；实测无文件选择器                     | 待原生文件选择/文件系统能力边界证明           | 待 run-file-chooser 拒绝               |
| 摄像头/麦克风            | delegate 明确 Deny；本地页面 API 不可用，未证明原生回调路径 | 待 PermissionRequested 明确 Deny              | 待 permission-request 明确 deny        |
| 剪贴板、定位、通知、拖放 | **未完成全面验证**；已取消 drag types，仍须验证             | **未实施**                                    | **未实施**                             |
| 打包                     | 普通 release .app / .dmg 构建通过；实验仍关闭               | 必须 Windows 本机构建验收                     | 必须 Linux 本机构建验收                |

系统打开通过 OS 浏览器执行，其登录资料、下载和页面权限由系统浏览器管理，不承诺继承 Surface 的限制。原生 API、WebKit/WebView2 版本和 Linux 系统依赖均需在对应平台记录；不靠网页脚本补丁封锁系统能力。

## macOS GUI 证据

使用临时数据与日志目录，独立命名的临时 debug 应用，避免读取用户现有 Provider/会话。UI 通过 Computer Use 操作；合成页面由 `scripts/browser-test-server.mjs` 提供，不读取文件或外部数据。

已观测：

- 标准 HTTPS 页面加载成功；本机 `http://127.0.0.1:47630` 加载成功，地址栏显示 HTTP 不安全连接。
- 合成页面显示 JavaScript 正常运行、Host IPC 无桥。
- 进入第二页、后退、前进和 `_blank` 链接在当前 Surface 中工作。
- 点击 download 属性链接被拒绝；附件响应不能下载，并进入失败恢复状态。
- 文件上传按钮触发拒绝提示，没有文件选择器。
- 地址栏 file 协议被拒绝；进入应用开发服务器被 Host 拒绝。页面尝试 file 导航后仍停留在网页，没有本地文件访问结果。
- 临时合成 Cookie 在窗口内 reload 后存在；关闭并重新创建 Surface 后不存在，导航历史也被清空。
- 无服务端口连接失败，保留请求地址并显示重试/系统打开入口。
- 摄像头/麦克风测试得到 TypeError（该环境的 API 不可用），**不能据此宣称原生 permission 回调已验收**。

仍需验收：重定向矩阵、证书错误、慢加载/停止、动态子框架、SPA pushState、拖放、剪贴板/定位/通知、媒体/DRM、长时间运行与高 DPI/窄窗口/键盘焦点，以及完整三平台测试。网站可能拒绝 WebView、要求登录/验证码或依赖特定浏览器能力，不承诺所有网站都兼容。

## 右侧面板增量

macOS UI 实测通过：合成 HTTP 网页位于聊天右侧；拖动分隔条后原生视图同步；工具栏和状态文字没有被网页覆盖；打开 Radix 权限菜单后网页隐藏，Escape 关闭后恢复；切换工作区和收起面板保留合成 Cookie，关闭后重新打开 Cookie 不存在。真实项目脏 buffer、完整弹窗矩阵、高 DPI 与三平台真机仍需专项验收。

独立浏览窗口已替换为主窗口右侧面板，支持工作区/浏览器切换、拖动宽度和收起。原生网页挂在主窗口，可信工具栏仍使用 React；不使用 iframe，不向远程网页注入 Tauri 权限。资源链接优先展开浏览器面板，文件/资产链接切回工作区。

布局通过有界 `layout` 契约传递 CSS viewport，原生侧复核有限非负坐标并裁剪到客户区。ResizeObserver、MutationObserver 和窗口事件只挂载一次；更新按帧合并且去重，没有常驻轮询。弹窗或菜单出现时隐藏原生内容，关闭后恢复；原生加载回调也尊重面板隐藏状态，避免收起时网页重新出现。完整遮挡/多平台矩阵仍待验收。

## 浏览器外观增量

最初截图布局阶段（后续多标签扩展见下文）：参照用户截图改为与聊天顶栏并排的单页面标签栏、图标导航、圆角地址栏和充满内容区的网页。地址栏按 Enter 打开，标签关闭仍销毁临时会话。空白页提供可用的工作区文件、终端入口，沿用应用明暗主题；没有新增多标签、搜索服务或密码/Cookie 导入能力。macOS UI 已验证空白页、回车导航、原生网页边界和收起。本轮仅改前端布局；格式、lint、根/前端类型检查与安装包构建通过，未重复运行 Rust 单测或 Windows/Linux 真机。宿主、Runtime、主 WebView 在收起/展开各四轮采样中均为 0.0% CPU；RSS 分别为 113.6/105.5、73.8/72.9、213.6/133.9 MiB，仅为短时观察，内存回收会影响读数。

## 性能证据

右侧面板修正版使用同一批宿主、Node Runtime 与主 WebView，打开前后分别运行 `top -l 4 -s 3 -stats pid,cpu,mem` 和 `ps -o rss`；打开后同时采样新增网页 WebKit 进程。不再创建额外工具栏 WebKit 进程。

| 进程            | 打开前四轮 CPU | 打开后四轮 CPU | 前 / 后 RSS（MiB） |
| --------------- | -------------- | -------------- | ------------------ |
| Tauri Host      | 均 0.0%        | 均 0.0%        | 141.2 / 111.9      |
| Node Runtime    | 均 0.0%        | 均 0.0%        | 79.6 / 73.2        |
| 主 WebView      | 均 0.0%        | 均 0.0%        | 257.4 / 164.4      |
| 新增网页 WebKit | 未创建         | 均 0.0%        | — / 36.1           |

这是短时空闲观察，内存会受系统回收影响，不能据此宣称打开浏览器减少内存，也不能替代长稳验证。RSS 与 top footprint 口径不同，本表只比较 RSS。没有常驻计时器；网页运行自身 JavaScript 后的资源消耗不能承诺为零。

## 自动验证

- Prettier、ESLint、根/前端 typecheck、TS packages 与前端构建通过。
- contracts、runtime-client、desktop 单测与 Runtime ResourceLink 定向测试通过；HTTP 链接已从旧“拒绝协议”用例迁移到支持用例。
- Tauri Host 普通构建及 `browser-spike` 构建检查、Host 14 项单测通过。
- Rust System Runtime 233 项测试通过。受限工具沙箱内曾因 `sandbox_apply` 与进程探测权限失败，在允许系统权限的环境重跑通过。
- Rust 格式检查、协议白名单一致性检查通过。
- 普通 release 应用包已构建，DMG 已生成。受限环境内 `hdiutil` 曾失败，在允许设备操作的环境执行原有打包脚本后成功。
- Windows/Linux 真机、实验发布包和完整长稳验收未执行，实验仍关闭；全量 `pnpm test` 未执行，仅运行上述相关测试与规定构建检查。

## 复现

在 macOS 12+ 运行：

```bash
pnpm build:packages
pnpm --filter @reflexion-os-studio/desktop dev --features browser-spike --no-watch
```

测试网页另开终端运行：

```bash
node scripts/browser-test-server.mjs
```

点击顶栏“网页”，输入 `http://127.0.0.1:47630`。测试服务仅监听 loopback，端口可用 `BROWSER_TEST_PORT` 调整，它是验收网站，不是产品 IPC 服务。验收时为应用设置临时 `REFLEXION_DATA_DIR` 与 `REFLEXION_LOG_DIR`；不要在实验中复用真实登录资料。

## 后续落地顺序

1. 补原生权限守卫和平台真机证据；确定剪贴板、定位、通知、拖放及所有下载路径的可执行边界。
2. 补 SPA 原生 URL/history 观测、重定向与故障矩阵，以及窗口/进程资源长期回收。
3. 右侧布局已接入；继续补三平台遮挡、缩放、焦点和窗口生命周期完整矩阵，再考虑打开发布入口。
4. 开放 Agent Browser Tool：先只读快照/提取，再导航/点击/填表，每次调用独立走 Runtime 权限、页面版本绑定与审计。用户 Surface 命令不复用为 Agent 免审批入口。
5. 用户多标签和显式迁移已加入实验适配；Agent 的受控登录、内容进入模型/记忆和自动化仍需独立设计，网页数据仍按不可信输入处理。

参考：[Tauri Capabilities](https://v2.tauri.app/security/capabilities/)、[Tauri WebView 构建 API](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewBuilder.html)、[Apple WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)、[Apple WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate)、[WebView2 原生接口](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/)、[WebKitGTK API](https://webkitgtk.org/reference/webkit2gtk/stable/)。

## 基础浏览扩展验收（2026-10-11）

右侧标签栏支持新增/切换/关闭、标题更新、方向键/Home/End 导航和 24 个
标签上限。每页保留原生导航历史，后台页面不会覆盖活动地址或自行显示。
网页 target=_blank 请求打开新标签；各标签共享独立临时 DataStore，关闭
单页不影响其他标签，清除整个会话重建空白标签并删除临时 Cookie。

直接迁移适配为 macOS 实验构建的 Chrome / Edge，来源配置限制为 Default
或 Profile N，不接收任意文件路径。原生确认绑定主窗口；用户取消后不读取
来源资料。来源只读 SQLite 快照、Safe Storage 解密、应用 Keychain 存储
和 WKHTTPCookieStore 写入均在原生边界，响应只返回数量与说明。密码
列表只返回网站和账户序号，用户选定后仅向同 HTTPS origin 的主 frame
填入，不自动提交，Agent 不获得这些数据或操作。Cookie 保留安全属性，
分区/过期 Cookie 与非 HTTPS 密码跳过；不支持加密格式或域绑定失败停止
迁移。Cookie 写入失败单独说明，不把已保存密码当作全部成功。

验证结果：

- 格式、lint、根/前端类型检查、build:packages、Rust fmt、默认宿主检查通过。
- contracts 69、runtime-client 16、desktop 65、宿主实验功能 21、system-runtime 233 项测试通过。
- 合成数据覆盖 v10 解密、未知加密格式拒绝、v24 Cookie 域摘要校验、只读 SQLite
  快照、非 HTTPS 密码跳过、分区/过期 Cookie 跳过、Secure/HttpOnly/SameSite 保留。
- macOS GUI 验证：两个标签切换保活、网页新窗口请求、标题、键盘切换、关闭相邻
  标签、共享合成 Cookie、清除整个会话后 Cookie 消失、弹窗遮挡原生网页、原生
  导入确认取消后明确显示“未读取浏览器数据”。
- Native frame/hidden 与相同标签状态去重，订阅/定时器保持有界。
- 同一稳定 dev 实例：宿主/Node/主 WebView 在收起和展开两个合成网页、输入框
  无焦点时各四轮 top 均为 0.0% CPU。RSS（收起→展开）分别为 141.0→132.5、
  80.2→80.2、255.2→261.8 MiB。地址栏光标闪烁时宿主/主 WebView 约 1–2%；
  构建触发 HMR 的采样不作为空闲结果。短时数据不代表长稳测试。

真实系统浏览器数据、系统钥匙串授权和真实登录站点**未运行验收**；自动化
验收没有读取用户浏览器 profile、密码库、Cookie 数据库或钥匙串。Windows/Linux
原生迁移与 Surface 仍未实现，Safari/Firefox 格式未实现，正常发布包不启用
实验能力；不得宣称完整浏览器或三平台直接迁移已完成。

实验启动：先执行 `pnpm build:packages`，然后
`pnpm --filter @reflexion-os-studio/desktop exec tauri dev --features browser-spike`。

格式依据：Chromium 的 [macOS OSCrypt 实现](https://chromium.googlesource.com/chromium/src/+/refs/tags/143.0.7497.1/components/os_crypt/sync/os_crypt_mac.mm)；
Cookie 目标边界使用 Apple [WKHTTPCookieStore](https://developer.apple.com/documentation/webkit/wkhttpcookiestore)。

### 2026-10-11 浏览器菜单与布局验收

- 复用 Radix Dropdown Menu；标签栏、胶囊地址栏和导入横幅按右侧面板参考调整。
- macOS 独立临时数据应用实测：菜单显示、键盘创建标签、Escape 关闭和焦点恢复通过。
- 合成 HTTP 页面上展开菜单时原生网页隐藏，关闭后网页恢复；没有读取真实浏览器资料。
- format / lint / 根及前端 typecheck / build:packages / 65 项前端测试通过。
- 菜单关闭、地址框未聚焦时，四轮 top（间隔 3 秒）最后采样 Host / Node / 主 WebView 均为 0.0% CPU。
  ps RSS 分别约 110 / 67 / 131 MiB；本轮未重跑未修改的 Rust 单测，也未做 Windows/Linux 真机验证。
