# CEF 共用浏览器验证

状态：macOS 原型核心链路通过，未迁移产品浏览器。当前 Tauri 2 / Runtime / 权限边界保持不变。

## 目标与验收

右侧展示的浏览器和 Agent 操作的浏览器必须是同一个页面实例，不能通过重新打开 URL 模拟同步。

1. 官方 CEF Rust 示例在保留沙箱的情况下构建并启动。
2. 现有 Playwright 经 CDP 连接该 CEF 的已有页面，完成中文字符串输入、按角色定位点击、无障碍树读取和截图。
3. 固定版本官方 Playwright MCP 在同一上下文中成功取得快照。
4. Tauri 宿主内原生子视图嵌入，验证缩放、焦点、中文输入法、弹窗遮挡、退出和进程回收。
5. 用户接管时停止 Agent 动作，恢复时重新读取页面并废弃旧引用。
6. 三平台安装包、沙箱与签名、空闲 CPU 和内存验收。

前 3 项通过不能替代后 3 项。

## 实验环境

- macOS ARM64；Windows / Linux 本轮无真机环境。
- 官方仓库：<https://github.com/tauri-apps/cef-rs>。
- 固定提交：`163744c8286d5f593d89202c7807751a7898db28`。
- 绑定版本：`154.5.0+154.0.34`。
- Rust：`1.98.0`。
- 示例、下载的原生库、构建产物和独立测试 profile 均在临时目录；不读取用户浏览器资料。
- 首次构建发现命令环境缺少 CMake，已改用临时目录中的 CMake / Ninja，未修改系统全局安装。
- 官方示例的可选菜单 XIB 依赖完整 Xcode 的 `ibtool`；本机只有命令行工具，实验跳过了该菜单资源。此配置不能用来验收复制粘贴快捷键或中文输入法。

## 已取得的实测结果

- 保留默认 sandbox feature 的官方 macOS ARM64 示例成功构建、打包并启动。
- 现有 Playwright CDP 已有上下文连接、页面导航、中文字符串 fill、角色定位点击、无障碍树、截图全部通过。
- 生产版本 `connectBrowserMcp` 连接相同上下文，官方 `browser_snapshot` 返回了合成页面的控件。
- 通过原生窗口输入 ASCII `HUMAN` 并点击后，Playwright 读取到相同 input / output，再继续操作成功。没有重新打开 URL 或复制页面。
- 独立官方示例的原生中文输入法、粘贴快捷键尚未通过；Tauri 嵌入原型中已验证原生全选、中文粘贴及按钮点击，并由 Playwright 读取到同一状态后继续操作。中文输入法组合输入仍未验收。
- 关闭独立示例窗口后主进程正常退出（exit 0）。完整子进程回收仍需另查。
- 示例 debug `.app` 约 326MB；该数值不是正式 release 包增量，也不是压缩安装包大小。
- Tauri 2.11.5 同窗口嵌入通过：左侧 WKWebView 应用界面，右侧为 `RuntimeStyle::ALLOY` 的 CEF 原生子视图，并非截图流或第二个独立浏览器窗口。
- 同窗口 CEF 的导航、中文字符串 fill、点击、无障碍树、截图和生产版 MCP 快照再次全部通过。
- 首次把子视图挂载放在 `.build()` 后时，Tauri 主窗口尚未创建，导致启动失败；将挂载移入 `.setup()` 后启动成功。
- 关闭嵌入窗口后主进程 exit 0；进程列表确认没有残留 `cefembed` / `cefsimple` 主进程或 helper。
- 空闲采样按 `top -l 4 -s 3 -pid <实验主进程> -stats pid,cpu,mem` 执行，主进程后续样本约 3.7%–3.8% CPU；固定消息泵未满足产品性能门槛。本次无修改前对照基线，不将该采样宣称为性能验收通过。
- 以上只证明原型核心链路；固定尺寸之外的缩放与布局、中文组合输入、多标签、弹窗遮挡、权限接线和真实网站矩阵尚未验收。

证据在本机临时目录：`/tmp/reflexion-cef-embed-evidence/result.json`、`handoff.json` 与截图。
嵌入应用在 `/tmp/reflexion-cef-embed-bundle/cefembed.app`；它不属于产品安装包。

## 可复现自动化探针

先构建本项目 Runtime，使探针可使用当前生产版本的 Playwright MCP 连接模块。
启动独立 CEF 示例，启用仅限本机实验的 CDP 端口，然后运行：

```sh
node scripts/cef-spike/verify.mjs http://127.0.0.1:19227
```

探针只应连接专用实验进程：会把其第一个页面导航到合成测试内容。
输出目录可用第二个参数指定，默认为系统临时目录下的 `reflexion-cef-evidence`。
成功时保存截图和检查清单；不连接个人 Chrome、不使用真实网站、不调用模型 API。

原生窗口内全选输入框、粘贴 `人工接管验证` 并点击“应用”后，可运行状态延续检查（不导航、不重建页面）：

```sh
node scripts/cef-spike/resume.mjs http://127.0.0.1:19228 /tmp/reflexion-cef-embed-evidence
```

调试端口仅用于隔离实验，不作为产品新增固定 localhost IPC 方案。
正式接入仍须遵守现有 contracts → runtime-client → Tauri / Runtime 边界，网页不得获得宿主命令权限。

### 原生嵌入探针

在干净、固定提交的官方仓库副本上运行：

```sh
node scripts/cef-spike/prepare.mjs /path/to/cef-rs
```

然后在该副本运行官方 `bundle-cef-app` 工具，目标为 `cefembed`，输出目录设为临时目录。
该探针只支持本机 macOS 验证，固定 Tauri 及其子依赖到当前产品锁文件版本。
初次未固定子依赖的构建解析到 `tauri-runtime 2.12.2` 等新版本，与 `tauri 2.11.5` 编译不兼容，已改为固定版本重试。
构建需要 CMake / Ninja；官方菜单资源已从实验移除，避免依赖本机未安装的 `ibtool`。
嵌入探针 CDP 使用 `127.0.0.1:19228`，自动化探针需传入该地址。

`native/embed.rs` 只是事件循环共存实验，暂用 16ms 调度以验证窗口可运行；
此实现不满足产品空闲零负载要求，不能接入正式应用。
产品化须接上 CEF 的消息调度回调，进行空闲资源、焦点、生命周期与窗口尺寸验收。

可复现准备脚本已在固定提交副本上实际运行，其生成的 `cefembed` 编译通过。探针脚本的语法、ESLint、Prettier 和原型 Rust 格式检查通过。未改动生产依赖、协议、权限或宿主，不把本次原型构建视为正式产品的全量构建/测试；Windows/Linux 真机、签名、公证及正式安装包仍未验收。

## 跨平台设计边界

CEF 原生父窗口类型分别为 macOS NSView、Windows HWND、Linux 原生窗口。
原生子视图的具体可用性及 Linux X11 / Wayland 兼容性必须单独验证，不能从官方“支持平台”推断产品已支持。
macOS 还须验证 NSApplication 与 Tauri 事件循环共存、helper bundle 和签名；Windows 须验证 sandbox 启动方式；Linux 须验证系统库、沙箱及窗口系统。
不得通过 `--no-sandbox` 获得通过结果。
