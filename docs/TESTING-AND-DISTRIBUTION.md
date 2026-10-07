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

Tauri Host 从打包资源目录或开发目录解析 sidecar（`resource_dir/pkg/` 优先，仓库相对路径回退），并用版本 manifest 校验 Runtime/Rust 兼容性。生产包需记录 sidecar 版本、平台和架构；日志写 stderr/诊断文件，不进入协议 stdout。

打包（已实现，Phase 1B 内）：`pnpm build` / `pnpm build:desktop` 产出自包含安装包——

1. `scripts/prepare-package.sh`（tauri build 的 beforeBuildCommand 自动调用）：`bundle-runtime.mjs` 用 esbuild 把 TS Runtime 打成单文件 `runtime.mjs`；`fetch-node-dist.mjs` 下载官方 Node 发行版（默认 v22.21.1，`REFLEXION_NODE_VERSION` 可覆盖，SHA256 校验，缓存 `.cache/node-dist/`）并提取 `node`/`node.exe`；拷贝 `reflexion-system-runtime`（release）进 `package-resources/`。
2. `bundle.resources` 把 `package-resources/` 打进安装包资源目录（`pkg/`），宿主编译时按 `pkg/runtime/runtime.mjs`、`pkg/node/bin/node(.exe)`、`pkg/bin/reflexion-system-runtime(.exe)` 解析，目标机器无需预装 Node，也不依赖仓库目录。
3. `bundle.active = true`，targets 按平台配置（macOS: .app/.dmg；Windows: NSIS .exe；Linux: .deb/AppImage），产物在 `apps/desktop/src-tauri/target/release/bundle/`。

冒烟：直接运行安装包内二进制，确认两个 sidecar 从包内路径启动、宿主退出后无孤儿进程。签名、公证、自动更新、回滚、崩溃报告和备份恢复在 Phase 6 完善；Windows/Linux 安装包需在对应平台构建（Tauri 不支持交叉打包），随包 Node 版本按平台分别下载。

Windows 当前仅分发已验证可正常启动的 NSIS 安装包，CI 只上传
`bundle/nsis/*.exe`。MSI 与 portable ZIP 已停止生成和上传。

## 工作区跨平台回归检查

Windows/macOS CI 在上传安装包前执行 `node scripts/smoke-workspace.mjs --packaged`：
使用随包 Node、runtime.mjs 与 Rust sidecar，在独立工作目录及含中文/空格的项目路径下，
验证 System Runtime 就绪、目录加载、嵌套路径、文件读取、文件变更监听、Git diff 和协议关停。
Windows 继续只上传 NSIS；Linux 保持 deb/AppImage 目标，尚未加入当前安装包 CI 矩阵。
这项检查验证打包资源本身，不能替代安装后通过 Tauri 宿主启动的真机验收。

2026-10-07 检查修复了以下问题：

- 项目目录移除尾部斜杠会破坏 Windows 盘符根与 POSIX 根；现保留原生根格式，
  Windows 读取旧项目时兼容旧版误存的 `C:`，不改写历史数据库。
- 文件服务未就绪时文件树无提示；现在区分服务未就绪、加载失败与空目录。
- 单个目录条目的类型/元数据读取失败会阻断整页；现在保留可枚举条目，
  失败项标记结果不完整，根目录本身不可枚举仍报错。
- 原生目录输入的反斜杠可能进入列表返回路径；现在协议路径按组件统一用 `/`。
- 目录监听根与事件路径的 canonical/verbatim 形式不同会丢掉事件；现在统一根，
  并用最长现存祖先兼容创建和删除事件，仍拒绝工作区外事件。
- Git PATH 搜索缺少 Windows `git.exe`，回退安装路径还硬编码 C 盘；现在尝试
  原生可执行名及系统 ProgramFiles 目录，Git 后台调用隐藏控制台。
- 索引根读取失败曾被吞成零文件成功；现在报告失败，子目录跳过则标记结果不完整。

仅有“文件树为空”不足以确认某台 Windows 机器的直接故障原因。新版若显示系统文件服务
未就绪，应检查启动日志中的 `system runtime` 状态；若显示目录读取错误，则按对应路径
或权限错误继续定位。Windows/Linux 的实际安装启动、目录权限及平台沙箱仍需对应真机验证。

## 分栏与原生控件样式

侧栏宽度按窗口最多占 30%；工作区按主区可用宽度限制，为聊天保留 360px，
主区不足 720px 时至少保留一半。保存的宽度作为用户偏好，窗口/DPI 变化时由 CSS
自动限制实际宽度；拖动/方向键从当前渲染宽度继续调整，不从过大的历史宽度计算。
macOS、Windows、Linux 共用此布局，不依赖屏幕物理像素或平台分支。

checkbox/radio 不再套用文本输入框的 padding/min-height；保留原生交互并统一为 16px。
所有 select 的折叠控件与展开菜单统一主题、字体、边框和间距，窄容器内换行。真机验收覆盖窗口缩放、切换不同 DPI 屏幕、分隔条拖动与
键盘操作、复选框勾选和下拉菜单选择，不能用单个平台浏览器截图代替三平台验收。

### 跨平台共享选择控件

所有业务下拉统一使用 `components/forms/Select.tsx`（Radix Select），弹层在 portal 中渲染；空字符串选项与分组选项均须保持业务语义。Checkbox/Radio 保留原生 input 行为，通过共享 CSS 绘制外观。验收需检查键盘导航、Escape/焦点恢复、禁用项、长选项、滚动、窄窗口与 DPI；指令页取消项目切换时保持原值。三平台真机验收仍需分别执行。

### 嵌套菜单与输入法回归

运行配置弹层使用 portal 与视口边界定位，点击其下拉选项不关闭父面板；Escape 先关闭下拉，再关闭配置并恢复触发按钮焦点。确认弹窗使用 `dialog.showModal()` 阻止背景交互，初始焦点为取消，关闭恢复原触发控件。Composer 工具栏允许换行。所有文本编辑快捷键统一通过 `isComposing` 检查，覆盖 Safari 的 keyCode 229，候选词确认/取消不得触发保存、重发或取消编辑。

浏览器夹具检查已覆盖鼠标选择嵌套模板、分层 Escape、确认弹窗背景隔离与焦点恢复，以及 194px 工具栏的长模型名称换行；不能替代 Windows/Linux 真机输入法和 DPI 验收。

后续检查发现：已修复工作区读取丢失 CRLF/末尾换行：`workspace.read_file` 默认保留选中行的原始 UTF-8 文本（`preserveLineEndings=false` 可兼容分行展示），模型 `file.read` 默认仍为分行文本。编辑器仅在 `readComplete=true` 时允许保存，末段分页不再误发整文件覆盖凭据；编辑时保留原 UTF-8 BOM。回归覆盖 LF/CRLF、无末尾换行、多个末尾空行、空文件、BOM、分页重组、revision 回写与读取边界。另已将两处测试动态导入从手拼 `file://` 改为 `pathToFileURL()`，兼容 Windows 盘符与含空格路径。

### Markdown 原文分页回归

预览将读取窗口按 LF/CRLF 转为逻辑行，去除末尾分隔符产生的虚拟空项，同时保留真实空行。否则首批 2000 行会被计成 2001 行，下一批跳行并可能破坏代码围栏。追加读取用代次绑定同步锁；重载时重置锁，旧请求完成不得清除新请求的加载状态。回归覆盖 LF/CRLF、空行和跨批围栏，浏览器夹具验证 offset 2000→4000、并发调用去重与旧请求返回隔离。

后续审计的混合换行与危险访问弹窗问题已修复，见下面的回归要求。

### 混合换行与危险访问模态回归

Monaco 缓冲区的 LF/CRLF 差异不作为脏状态；保存时对本次加载的原文与编辑文本按行比较（格式基准不随保存改变，撤销删除仍能恢复被删行的原分隔符），未修改行保留原分隔符，替换行沿用对应行，新行沿用邻近行。UTF-8 BOM 与用户选择的末尾空行保持。比较先锚定未变的首尾行，再使用 jsdiff；每次比较限制 2000 个增删行与 50ms；原始基准累计差异超限时，改用最近一次成功保存的内容作为基准，让分次保存能继续推进。两次比较都无法安全完成时拒绝写入并保留草稿，提示分次保存。差异计算仅在保存时执行，原文件未变时不写磁盘。

普通确认与危险访问共享 `useModalDialog`，通过 showModal 隔离背景并恢复关闭前焦点；危险访问第一步聚焦取消，第二步聚焦返回。保留两段确认、第二步 Enter 不触发启用和平台不支持时拒绝启用的规则，模态期间应用级保存/关闭标签快捷键不作用于背景。浏览器模拟权限接口已验证初始/分步焦点、Escape 恢复、聚焦启用后按 Enter 不调用接口、不支持平台禁用按钮，以及两次明确点击才调用启用。没有对真实权限状态做变更。

危险授权弹窗的 prepare / enable / disable 请求绑定本次打开与会话代次。关闭、重开、切换会话或卸载后，旧响应不得切换步骤、清除新请求的 busy 状态或调用成功与关闭回调；同步锁防止同一轮重复点击。disable 失败须显示错误并释放忙状态以便重试。`danger-dialog.test.mjs` 用受控 hook 生命周期和延迟 RPC 验证组件逻辑，不执行真实危险授权；OS 原生模态与键盘行为仍需真机验收。

### 工作区快照与导航回归

行号引用只更新定位 nonce，查看器 key 使用项目、路径与独立 reloadNonce；只有明确放弃/保存草稿后的 Git 切换或拉取重载可更新 reloadNonce。测试断言脏文件行号跳转不改变挂载 key。

workspace.read_file 的 readToken 对应不可变的根目录、路径、revision 与完整读取状态。workspace.write_file 使用该 token 并返回成功写入的新 token；编辑器持有自身 token，预览刷新、分页与其他编辑器读取都不能推进它。未知/跨文件 token 和不完整快照拒绝；无 token 的既有文件覆盖由 Rust 拒绝。凭据簿最多 1024 项，失效时保留草稿并要求重新加载。端到端回归验证外部修改后即使预览读到新版本，旧编辑器仍不能覆盖它。

项目会话、委派与会话内容刷新同时检查请求序号和当前上下文，旧请求不能覆盖其他项目/会话或清空后的页面。workspace-state.test.mjs 覆盖乱序响应和行号定位；它验证受控 hook 与组件输出，三平台 WebView 交互仍需真机验收。
