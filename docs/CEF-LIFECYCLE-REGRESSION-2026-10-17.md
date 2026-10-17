# CEF 生命周期回归（2026-10-17）

## 实现边界

主窗口关闭 → 停止新页面 → 请求关闭所有 CEF 子页面 → 收齐各 Browser ID 的 `OnBeforeClose` → 回调返回后释放容器 → 脱离外层 Wry 容器 → 允许关闭主窗口 → Tauri/Wry 销毁外层渲染资源 → 停止 dispatcher → `CefShutdown` → Runtime 协议退出。

Registry 在关闭确认前持有 Browser，macOS input 持有 GuardView；CEF 只负责自己的子视图。DoClose 延迟拆除子视图/子 HWND，绝不销毁顶层窗口。重复关闭幂等，普通标签关闭不触发应用退出。隐藏标签的 GuardView 脱离父视图但继续持有，激活后重新挂载，防止遮挡和 compositor 未恢复。

所有原生变更和 CEF message loop 共用一个 dispatcher。CEF 回调里的任务延后执行，posted/running 防止嵌套循环和重复投递，停止后丢弃排队任务；消息泵兜底排空有次数上限，空闲不常驻轮询。

外层 Tauri WebView 继续承载 React UI；外部网页只用 CEF。旧 WKWebView 浏览器实现已经移除，不存在两套网页浏览引擎相互切换。

## macOS 原生验收

使用隔离测试数据目录、debug `cef-acceptance` 和本机合成站点，不读取个人浏览器资料或真实凭据。

| 场景                                                     | 结果                                                      |
| -------------------------------------------------------- | --------------------------------------------------------- |
| 连续导航、打开 target=_blank、结果页导航与刷新、关闭子页 | 30 轮通过                                                 |
| 原生界面点击结果、点击标签关闭按钮、恢复原页             | 额外 5 轮通过                                             |
| 百度搜索 CEF 官方、打开百科结果新标签、关闭并恢复搜索页  | 通过，原页正常显示                                        |
| Agent 中文输入/点击、另会话隔离、关闭兄弟页              | 通过                                                      |
| 接管期间拒绝 Agent 导航、交还后保留人工输入、截图        | 通过                                                      |
| 下载保存对话框取消                                       | 通过                                                      |
| 慢速下载保存后取消                                       | 记录 cancelled，18432/122880 字节；目标和临时文件均未残留 |
| 存活网页下关闭主窗口                                     | 正常退出，exit code 0                                     |
| CEF helpers、Node、Rust sidecar 退出                     | 记录的全部测试进程 ID 无残留                              |
| 崩溃报告                                                 | 测试后无新增；最新仍为修复前 17:31:55                     |

driver 最终结果：

```json
{
  "phase": "passed",
  "nativeNavigationRounds": 30,
  "isolation": true,
  "agentInput": true,
  "takeoverBlocksAgent": true,
  "manualStatePreserved": true,
  "screenshot": true
}
```

## release 退出补充诊断

最终 release 退出仍在复验中，下面的尝试不能视为已验证修复。

首轮最终安装包副本能够加载网页、创建和关闭新标签，但存活网页下关闭主窗口时退出码为 134。18:50:19 的报告显示 Rust 无法接住原生异常。LLDB 在 `objc_exception_throw` 处截获的原始对象明确是 `WryWebViewParent0.55.1`：仍有 superview 时进入 dealloc；这不是 renderer 单独退出。

直接在 CefShutdown 后脱离 NSWindow.contentView 的尝试仍触发 Wry drop 时的原生访问错误（18:56:17），证明仅做这一步不足。退出顺序需要同时满足：全部 CEF 页面和自有容器已关闭后，先将外层 Wry 容器脱离 NSWindow，再允许 Tauri 销毁自身 Wry 窗口；Window Destroyed 返回后通过 dispatcher 最后执行 CefShutdown，再进入 Runtime 协议退出。Chromium 的全局 Cocoa 集成必须保持到宿主外层渲染资源销毁完成。没有额外 retain 泄漏，也不捕获/吞掉 AppKit 异常。空窗口与存活网页须分别重测。

检查 Tauri 2.11.5 / tauri-runtime-wry 2.11.4 实现发现 macOS `with_webview` 用 `Retained::into_raw` 创建 WKWebView、manager 和 NSWindow 句柄。视口代码不再走该路径，改在 CEF dispatcher 中从 NSWindow 的原生子视图定位 WKWebView；不额外持有跨生命周期原生句柄。每轮 dispatcher 也建立独立 autorelease pool。

## 闲置崩溃与退出修复（2026-10-17 晚）

崩溃报告（17:17、17:28）与隔离实验共同定位：AppKit 的 `NSView dealloc` 断言对象固定是
`WryWebViewParent`，且**从未打开浏览器面板、无 CEF renderer 进程的闲置进程也会在
35-60 秒内崩溃**；`REFLEXION_DISABLE_CEF` 环境开关跳过 CEF 初始化后闲置 4 分钟以上稳定
存活。断言发生点分布在 CEF 消息循环 pool pop、run loop callout pool pop 和 CefInitialize
内部——释放点不等于成因，成因是 WryWebViewParent 在仍挂在视图树上时被提前释放。

修复：`lifecycle::finish` 在 `window.close()` 之前调用 `container::detach_wry`，把 Wry
渲染子树从嵌入根容器脱离，使 WryWebViewParent 之后必然以无 superview 状态 dealloc，
AppKit 断言无从触发；Window Destroyed 后经 dispatcher 执行 CefShutdown 的顺序保持不变。

验证（release 构建）：闲置 170 秒存活（修复前 35-60 秒必崩）；AppleScript 触发的空窗口
退出干净（无异常、无新增崩溃报告）；宿主单测 50 通过。**带存活网页的关窗退出仍需真人
操作验证**（可访问性权限受限无法自动化），通过后本节才算关闭。

## 资源采样

同一原生测试进程 PID 25067：起始 RSS 232240 KiB（启动期），30 轮与额外界面关闭、下载取消后 RSS 213648 KiB，实站页面关闭后 RSS 164336 KiB。该短期样本未见持续增长；不是长期泄漏证明。

实站页面保持打开时，末次采样宿主 0.3%、网页 renderer 2.8%、GPU helper 1.0%。关闭实站页面后，`top -l 4 -s 3 -stats pid,cpu,mem` 末次采样宿主、Node、CEF helpers、Rust sidecar 全为 0.0%；宿主 top 内存约 114 MB，Node 142 MB。不同工具内存口径不同，不将 top MEM 与 ps RSS 混作同一指标。

## 自动回归与复跑

- Tauri Host 单测：50 通过，包含生命周期、重复关闭、调度合并、重入拒绝、停止后拒绝已投递任务和有界排空。
- Rust System Runtime：236 通过。
- Runtime：743 通过，4 项按既有环境条件跳过。
- runtime-client：25 通过。
- 前端：88 通过；混合换行测试曾在并行编译高负载时触发既有执行时间预算，构建完成后完整重跑通过。
- 前端背景页回归修正了测试观察器自身依赖 RAF 的时序问题：被测 fixture 故意暂停 RAF，Playwright 观察器改用 50ms 轮询；产品仍以无轮询方式同步。

原生 debug 回归先启动 Vite，再编译带 `cef-acceptance` 的宿主。启用额外 30 轮：

```sh
REFLEXION_DATA_DIR=/private/tmp/reflexion-cef-lifecycle-qa \
CEF_ACCEPTANCE_OUTPUT=/private/tmp/cef-lifecycle-result.json \
CEF_NATIVE_REGRESSION=1 \
apps/desktop/src-tauri/target/debug/reflexion-desktop
```

按结果文件中的阶段完成接管、人工修改、交还；在 `await-user-browser` 阶段用普通用户标签打开结果中的合成 URL；在下载阶段取消系统对话框。30 轮使用受信测试 harness 的 CDP 连接，另外的原生界面关闭与实站回归必须操作产品窗口验证，不能用 CDP 关闭代替。

本次是 macOS ARM 实测。Windows 共用生命周期与调度器、使用主线程 DestroyWindow 关闭子 HWND，但尚无 Windows 真机 GUI 验收；Linux 保持既有明确不可用与系统浏览器回退。本次不包含长时压测、真实登录、IME、高 DPI、签名或公证。若 CEF 永不回报关闭，主窗口会保持等待，不用提前强杀伪装优雅关闭。

## 用户提供的 19:07 报告复核

报告来自本轮 QA 副本 PID 75574，并非用户安装目录的应用。反汇编确认 CEF 模块偏移 0x8c4f074 是 Zombie 消息检测器主动写空地址的失败路径。LLDB 在该检测器写入前截获的诊断为：`Zombie <WryWebViewParent0.55.1> received -release`。保存的首次释放记录和当前释放栈分别落在 autorelease pool 排空与 Wry WebView drop。

独立原生根容器的初次 release 复验仍失败；截至此记录，退出故障尚未解决，安装包不能作为修复完成版本交付。当前正在追踪重挂载、布局和关闭前的引用计数。导航与单测通过不能替代这一项 release 失败。
