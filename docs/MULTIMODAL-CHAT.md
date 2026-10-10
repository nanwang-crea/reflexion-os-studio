# 多模态 Chat：图片输入

2026-10-09：按本次用户明确要求接入图片对话；这是 Phase 5 的 Chat 子集，媒体生成、视频、音频和 Workflow 仍未实现。

## 使用与范围

在落地页或聊天输入框点击「添加图片」，或粘贴截图。支持 PNG、JPEG、WebP、GIF，每条最多 4 张、每张最多 4MB。图片缩略图可移除；发送后展示文件名、大小和图片，点击放大，Escape 关闭并恢复焦点。只发送图片时自动补充「请分析这些图片。」。发送失败保留草稿和图片。

选择供应商提供的视觉模型。现有 Provider 没有模型级能力发现，不能仅凭模型名称可靠判断视觉支持；输入框提示使用视觉模型，不把 image 生成能力误当作图片理解能力。不支持图片的模型返回供应商错误，沿用 Run 错误与重试入口。

## 数据与边界

- 新增契约命令 `asset.upload_image`：浏览器 FileReader 读取用户选择的图片，经 runtime-client → Tauri 白名单 → Runtime 上传。没有任意本地路径读取参数。
- 复用 Asset Store，图片文件放在 `assets/sessions/<sessionId>/<assetId>`，元数据绑定 session，project 可为空。v39 保留旧项目资产并增加可空 session 外键；删除会话/项目级联元数据并清理内容，启动巡检补偿孤儿。
- `message.send.imageAssetIds` 最多 4 个唯一引用，Runtime 验证所属会话、格式与状态。消息 `parts_json` 保存 text/image 块；图片原文不进入消息、事件或 SQLite。排队快照仅含引用；队列仍是内存态，重启丢弃待发送消息，与已有行为一致。
- 已用于消息或仍在发送队列中的资产不能单独删除，避免破坏历史及待发送消息；编辑重发保留原图片，重试从原用户消息重建。当前不提供编辑已发送图片集合的 UI。
- Agent Core 的 user/frame 保留图片引用，上下文压缩与 Frame 转换不丢失最近图片；按每张 4096 token 粗估预算（非供应商精确计费）。Checkpoint 的 source hash 包含引用，摘要文本标注图片数量，不读取图片内容；更早的图片可随历史帧裁剪。
- 仅在模型调用边界读取保留的图片，校验所属会话、文件签名与元数据，生成临时 base64 原生输入块，不写回上下文。单请求图片 base64 合计上限 24MiB，超限明确提示新建会话；丢失或损坏图片明确失败，不静默作为纯文本发送。预览与模型读取在分配缓冲区前限制文件大小、校验数据目录边界并拒绝文件符号链接；读取过程中限制字节数，避免文件变化造成无界读取。
- 上传校验 base64 编码、大小、MIME 与 PNG/JPEG/WebP/GIF 文件签名。文件签名不等于完整解码验证；浏览器/供应商负责完整解码并显示失败。SVG、远程 URL 和其他格式不进入图片输入。

## Provider 原生格式

- OpenAI Chat（及兼容服务）：`image_url` + base64 data URL，`detail: auto`。
- OpenAI Responses：`input_image` + base64 data URL，正文为 `input_text`。
- Anthropic Messages：`image` + `source: { type: base64, media_type, data }`。

纯文本消息维持字符串格式，工具调用格式不变。不引入模型 SDK 或额外媒体服务依赖。格式依据 [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision) 与 [Claude Vision](https://platform.claude.com/docs/zh-CN/build-with-claude/vision)。

## 跨平台与验证

macOS、Windows、Linux 均使用 WebView 的文件选择/剪贴板、FileReader、受控 data/blob 图片与 Node path.join 存储，不依赖 POSIX shell 或原生图片库。Tauri HTML 文件拖放可能被宿主拦截，首版只承诺选择和粘贴。生产 CSP 已允许 data/blob 图片。

自动验证覆盖上传拒绝、会话隔离、资产清理、历史重载、Frame 往返、排队快照、编辑重发、重试、v38 升级和三种协议实际 HTTP 请求；真实供应商调用不使用用户密钥。Windows/Linux 真机和真实模型视觉调用需在对应环境补验，不能据 macOS 构建宣称三平台验收完成。

## 2026-10-09 验证记录

- 格式、lint、根/前端 typecheck、packages 构建、Rust fmt/check、Tauri 宿主 check 和最终 macOS 应用包/DMG 构建通过；白名单一致性通过。
- Contracts 63、Agent Core 44、Runtime Client 12、Desktop 60、Runtime 426、Rust 221：共 826 项通过。Runtime 的 4 项 Windows 批处理启动器真机测试在 macOS 按平台跳过。
- 实体 schema 超过 500 行，按项目规范等价拆入 entities/chat、tools、integrations、workspace 与 agents，保留 entities.ts 公共门面。与 HEAD 比较，公开导出完全相同，87 个未修改 schema 的 JSON Schema 投影完全相同；AssetRef/QueueEntry 仅按图片需求扩展。
- 完整回归修正了旧测试夹具：历史分页响应补齐 positions/nextBefore、数据库版本推进 v39、资产清理桩补齐 session 方法、Git 各动作使用独立 requestId。未改变这些领域的生产行为。
- 安装包 GUI 使用临时数据目录与本地模拟 Provider：原生图片选择、待发送缩略图、纯图片发送、消息图片/文件名/大小、历史图片、放大、Escape 关闭均已操作验证。模拟 Provider 收到 2 个 image_url 块（旧历史图片与本次图片），响应和图片均在会话显示。包内 Node/System Runtime 路径正确。
- 事件/渲染审查：图片读取 effect 只依赖 assetId；草稿 URL 在移除/成功发送/卸载时释放；没有新轮询、常驻计时器或流式事件订阅，沿用原有流式合帧。
- 资源方法：top -l 4 -s 3 -stats pid,cpu,mem，并用 ps -o rss 读取 RSS。开发版 Host/Node 以及同时启动的两份开发 WebView 候选进程四次 CPU 均为 0%。安装包空会话基线与图片会话使用相同进程及采样方法：空会话 CPU Host 0–0.9%、WebView 0–1.3%、Node 0%；两张图片会话三者四次均 0%。空会话→图片会话 RSS（MiB）Host 81.5→88.2、WebView 49.6→125.6、Node 21.0→33.6；两组 top 内存 footprint 约 149→142MiB（WebView）。RSS 与 footprint 口径不同，这些短采样仅证明未出现持续空转，不能证明长期无泄漏。该基线为同构建空会话，不是变更前版本的性能基线。
- 未执行：Windows/Linux 真机、真实视觉模型推理、剪贴板图片人工验收，以及大量大图长时间压力测试。模拟协议测试不等于真实模型视觉能力验收。

## 本次代码 Review 修复

- 消息已接受后，刷新失败只显示通知，不再让 Composer 保留已发送草稿；实际发送失败仍保留草稿。上传过程中切换会话后，发送完成不覆盖当前选择。
- `asset.delete` 检查待发送队列；移除队列项后可删除未用于消息的图片。删除资产先同步移除元数据，再异步清理内容，防止检查引用后等待磁盘 IO 期间被新消息使用；清理失败由启动巡检补偿。
- 预览读取改为有界缓冲区与文件句柄读取，并拒绝符号链接、数据目录外路径和敏感路径。
- 补充 6 项回归：刷新失败、发送失败、导航切换、排队删除、删除/发送竞态、超限文件与符号链接读取。全量回归及 macOS 应用/DMG 构建通过。打包会重写共享 dist，最终测试在打包完成后执行。
- 本轮未新增订阅、流式刷新或常驻定时器；未重复 GUI/空闲资源实测，沿用上面的已有实测记录。Windows/Linux 真机及真实视觉模型调用仍未执行。

## 2026-10-10 截图读取与发送前预览修复

- 修复刚发送图片即报“历史图片已丢失或损坏”：内部 Asset 读取误用了外部工具的敏感根策略，默认/配置的数据目录整体被拒绝。现在仅允许 canonical 数据目录的 assets 子树，并保留凭据文件名拒绝、符号链接拒绝和有界读取；外部工具仍拒绝整个运行时数据目录。
- 新增使用 canonical REFLEXION_DATA_DIR 的截图上传→预览读取→模型输入重建回归；临时目录的 /var→/private/var 别名此前掩盖了此回归。修复前该测试失败，修复后通过。
- 待发送图片缩略图支持点击放大，与已发送图片复用 ImagePreview。支持 Escape/关闭按钮，关闭后焦点回到缩略图；图片替换或移除时不保留失效预览。缩略图样式仅作用于缩略图，避免限制放大图尺寸。
- 实际组件浏览器验收：点击打开、Escape、再次打开、关闭按钮与焦点恢复均通过。截图输入使用合成测试图片，未读取用户实际图片或 Provider 密钥；未进行系统剪贴板图片人工验收。
- 验证：格式/lint/根与前端 typecheck、packages 构建、Rust fmt、宿主 check 通过；前端 60、Runtime 全量测试文件顺序执行 459、Rust 221 项通过，4 项 Windows 测试按平台跳过。初次并行运行遇到既有 diff 时间预算与进程重启限时测试失败，顺序重跑通过。
- macOS 应用与 DMG 重新构建通过；契约/宿主白名单一致性检查通过。
- 旧应用进程须重新启动以加载修复；若图片文件仍在，可直接重试失败消息。Windows/Linux 真机和真实视觉模型调用仍待验收。
