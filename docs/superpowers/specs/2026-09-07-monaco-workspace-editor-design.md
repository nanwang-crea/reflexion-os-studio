# Monaco 工作区编辑器替换设计

## 目标

将工作区文件查看与 Git Diff 统一迁移到 Monaco，提供接近 VS Code 的跨平台编辑体验。`ContentView` 使用 Monaco 单文件编辑器，`DiffViewer` 使用 Monaco DiffEditor；Markdown 预览继续保留，Markdown 原文与代码块使用 Monaco 只读模式。

本次支持 macOS、Windows、Linux，Monaco 及其 worker 必须离线随前端构建，不依赖 CDN。前端仍只能通过既有 API 层、runtime-client 和 Rust workspace 边界访问文件。

## 方案

采用 `@monaco-editor/react` 作为 React 封装，并直接引入 `monaco-editor`。新增工作区编辑器基础层，隔离 Monaco 初始化、语言映射、模型生命周期和组件适配：

- `features/workspace/editor/MonacoEditor.tsx`：单文件查看与编辑。
- `features/workspace/editor/MonacoDiffEditor.tsx`：只读双栏 Diff。
- `features/workspace/editor/monaco.ts`：统一初始化、worker、主题和全局配置。
- `features/workspace/editor/language.ts`：文件扩展名到 Monaco language ID 的映射。
- `features/workspace/editor/types.ts`：编辑器组件输入输出类型。

`FileViewerPanel` 继续负责标签与视图分发，`ContentView` 和 `DiffViewer` 负责工作区数据状态与编辑器组合；编辑器组件不直接访问 Runtime。

## 文件编辑流程

1. 打开文件后通过 workspace API 获取内容，以规范化 workspace URI 创建 Monaco model。
2. 根据文件扩展名设置语言；未知扩展名使用纯文本语言。
3. 默认以只读模式打开。用户点击编辑后切换为可编辑。
4. Monaco model 内容变化后计算 dirty 状态，并在文件标签显示未保存状态。
5. 保存调用 `writeFile(projectId, path, content)`，经过 runtime-client、Runtime 和 Rust workspace 边界完成路径及权限校验。
6. 保存成功后更新基线内容并清除 dirty 状态；失败时保留编辑内容并允许重试。
7. 关闭 dirty 标签时提供保存、放弃、取消三个选项。
8. 只读 Profile、无写权限文件和 Git Diff 视图不可编辑。

前端不直接访问 Node API、文件系统或 Rust command。保存不执行 Git 暂存或提交。

## Diff 流程

`DiffViewer` 使用 Monaco DiffEditor，左侧为原始内容，右侧为工作区当前内容。数据仍经现有 `gitDiff` API 获取。Diff 默认只读，保留语言识别、语法高亮、行号、折叠、差异背景和差异导航；不支持直接修改或保存。

Git 状态列表继续由 `GitChanges` 展示，点击文件后打开 Diff 标签。删除现有 `alignContents`、`parseDiff` 及其专用双栏行渲染，仅保留 API 数据适配和标签交互。

## Markdown 与 JSON

Markdown 预览模式继续使用现有 Markdown 渲染。Markdown 原文和消息中的代码块使用 Monaco 只读实例，代码块语言由 Markdown fence 的语言标识决定；不引入富文本编辑器或自定义 tokenizer。

JSON 使用 Monaco JSON language service，支持语法高亮、折叠和格式错误标记。JSON 格式化预览的现有行为保持不变。

## 跨平台与构建

- 使用 `@monaco-editor/react` 的统一 React 接口。
- 通过 Vite 配置 Monaco worker，worker 随前端离线打包。
- 不使用 CDN、远程动态加载或平台专属路径。
- worker 配置必须兼容 Tauri WebView 的 macOS、Windows、Linux。
- 使用项目深色视觉规范配置 Monaco 和 Diff 主题。
- 禁用联网功能与遥测。
- 文件路径只用于规范化 model URI 标识，不通过手工拼接平台分隔符构造路径。

## 性能与降级

- 普通文件完整启用 Monaco 编辑能力。
- 超过项目阈值的文件进入大文件只读模式，关闭编辑、诊断及高开销能力。
- 极大文件或 Monaco model 创建失败时，降级到安全的纯文本只读展示，避免阻塞工作区。
- 文件标签关闭时销毁对应 model；Diff model 在标签关闭时释放。
- Markdown 消息代码块限制 Monaco 实例数量，避免大量短代码块造成额外开销。

阈值应集中配置并在实现计划中明确，不得散落在各组件中。

## 状态与错误处理

编辑器状态包括 `loading`、`ready`、`dirty`、`saving` 和 `error`。保存期间禁止重复保存；保存失败保留当前内容并展示错误。文件读取、保存和 Diff 获取错误沿用现有 workspace 错误展示机制。

检测到外部文件变化时，如果当前 model 未修改可提示重新加载；如果 model dirty，不得静默覆盖本地内容，必须提示用户选择保留本地内容或重新加载。

## API 与权限

若当前 workspace API 尚无写文件能力，新增 `writeFile(projectId, path, content)`，并同步更新 contracts、runtime-client、Runtime facade 与 Rust workspace command。Rust 侧负责 workspace 边界、路径校验和写入；既有 Profile 与审批策略继续生效。协议和错误响应不得包含 secret。

## 测试与验收

- 语言映射覆盖 TypeScript、TSX、JSON、Markdown、Python、Rust、Go、Shell、SQL、CSS 和 HTML。
- 文件打开、只读、编辑、撤销、重做、搜索、折叠和保存正常。
- dirty 文件关闭时保存、放弃、取消行为正确。
- 保存失败保留内容并可重试。
- Diff 正确展示新增、删除、修改和多行差异，并有语法高亮。
- JSON 显示格式错误标记与折叠。
- Markdown 预览、原文和代码块均正常。
- 只读 Profile 与 Diff 不可编辑。
- 多标签 model 隔离，切换和关闭后状态正确，关闭释放 model。
- Monaco worker 不依赖 CDN，macOS、Windows、Linux 构建资源均能加载。
- 超大文件不冻结 UI，并正确进入降级模式。

按 `AGENTS.md` 执行 format、lint、typecheck、前端 typecheck、构建及 Rust 检查。

## 本次不做

- 实时协作。
- LSP 服务端集成。
- Git 暂存、提交和冲突解决。
- AI 补全与 Agent 编辑。
- 插件系统、终端集成和浏览器 DevTools。
- Monaco 之外的第二套语法高亮库。
