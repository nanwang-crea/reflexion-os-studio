# Provider and Secrets

Phase 1A 首先支持 OpenAI-compatible Chat Provider。配置包括 `providerId`、`baseUrl`、`model`、streaming/tool-calling 能力、请求超时、重试次数、上下文/输出上限和可选代理。Provider 负责模型请求和流式事件，不负责 Session、Run、审批、Tool 或数据库。

Provider 以 `capabilities`（`chat | embedding | image | video`）声明能力类型，决定其可参与的负载；Agent 工具循环通过 canonical `ToolSpec` 声明工具，由 OpenAI-compatible 适配层投影为 function calling 方言，`tool_calls` 流式增量按 index 聚合。embedding/image/video Provider 随 Phase 2/5 接入，协议先行。

API Key 最终保存位置为系统 Keychain/安全存储。**MVP 阶段的实现**为 Runtime 本地密钥文件（数据目录下 `secrets.json`，0600 权限，`provider.configure` 的 `secret` 为只写参数，落盘后仅以 `secretRef` 引用），Keychain 接入在 Phase 6 替换存储后端，协议不变。SQLite、Event Log、普通日志、Chat 消息和 Tool 输出只保存 secret reference，不保存明文；secret 不进入任何响应、事件或日志。Runtime 使用时自行读取；UI 始终遮罩。支持缺失凭据提示、更新、删除和轮换。

Provider 错误统一映射为稳定的 `configuration`、`authentication`、`rate_limit`、`timeout`、`network`、`unsupported`、`provider` 类型。重试只对明确可重试错误生效；流式响应已经产生 Tool Call 或外部副作用后不自动重试整个 Run。

## 模型参数配置

Provider 保存默认 `temperature`、`maxTokens`、`contextWindow`、`contextBudget` 和 `reasoningEffort`。
`provider_models` 按 `(provider_id, model)` 保存模型独立覆盖、`reasoningEffortSupported` 和 `reasoningOptions`（显示名称与实际发送值）；
`provider.model.list/configure/delete` 经同一 Runtime 请求门面与宿主白名单调用。
省略字段保留原值，`null` 表示继承 Provider 默认；删除模型配置恢复全部继承，删除 Provider 级联删除配置。
模型配置命令要求模型在 Provider 已保存的模型列表中；发送与重试仍保留显式指定模型 ID 的兼容行为。

发送、排队出队、重试和编辑重发统一按「模型覆盖 → Provider 默认 → 适配器默认」解析参数；
消息命令不再接收采样参数。对话页可传非持久化的 `reasoningEffort` 请求意图，
省略使用配置默认，`null` 表示服务端默认（不发送参数）；仅在能力允许时覆盖执行期配置，不写入 Run/Message。根 Run 使用解析后的配置装配执行，子 Agent 继承父 Run 配置。
思考强度仅在模型明确声明支持时发送，实际发送值按模型的 `reasoningOptions` 校验，不再固定为三个等级；
旧配置由 v43 加法迁移保留 `low/medium/high`。选项列表禁止空项与重复值，默认等级必须属于列表。
继承的 Provider 默认不属于列表时不发送参数；显式请求不支持的等级返回配置错误。
Chat Completions 投影为 `reasoning_effort`，Responses 投影为 `reasoning.effort`。
当前 Anthropic 适配器不发送该参数，设置页禁用对应能力开关。

设置页提供 Provider 默认参数与模型独立配置；对话模型选择器继续按 Provider 分组，
每个模型可填写“显示名称=实际发送值”，如“极高=xhigh”；关闭思考只能配置服务端明确支持的值，与不发送参数不同。
切换模型时重置思考强度为模型/Provider 默认；支持列表变化使选择失效时回退默认，不支持时显示禁用状态。
模型和 effort 控件复用 Radix Select，实际参数由 Runtime 解析，存储与解析使用
TypeScript/SQLite，macOS、Windows 和 Linux 共用相同实现，不引入平台专属依赖。

Chat Completions 将 assistant 的非空思考正文回填为 `reasoning_content`，覆盖工具续轮、文本续写与持久化历史重建；无思考的旧消息省略该字段。canonical 消息与上下文帧保留 reasoning 并计入 token 估算，Responses / Anthropic 回传供应商原生 continuation，不能从展示正文伪造签名或加密数据。该链路为平台无关 TypeScript，macOS / Windows / Linux 使用相同实现。

## 思考回传

- OpenAI Chat：assistant 的非空 `reasoning` 投影为 `reasoning_content`。
- Responses：请求 `include: ["reasoning.encrypted_content"]`，保存完整 reasoning/message/function_call output items，下一轮按原顺序回传，保留原始 call_id 与 reasoning item id。
- Anthropic：按 block index 聚合 thinking、signature_delta 与 redacted_thinking，连同原始 text/tool_use 顺序保存并回传；tool_result 置于后续 user 消息，多工具结果合并，不混入 assistant。
- 原生 continuation 绑定 API 格式、端点与模型，只在来源匹配时回放。展示思考正文不替代缺失的原生数据；旧历史没有签名/加密信息时不伪造。
- Schema v49 新增可空 `messages.provider_continuation_json`，与正文/思考终态一起写入，重启后历史重建保留。旧库只加列，不改写历史；Retry 清空该字段。
- 上下文帧与循环保留原生数据，估算包含原生载荷；带签名的 assistant 正文不做局部截断。既有历史摘要/整帧省略策略仍会淘汰旧轮次。

三种适配器使用平台无关 TypeScript/SQLite，macOS、Windows、Linux 共用同一链路。

历史原生工具别名会在当前工具映射之前预留，避免工具列表变化后把同名清洗别名解析为另一个工具；历史别名冲突时明确返回协议错误。切换到 Chat Completions 时，不把其他协议原生思考的展示摘要回填为 reasoning_content，也不生成空 assistant 消息。

Provider 错误与重试诊断会先去除本次请求密钥，再截断或发布，避免上游错误回显泄漏完整密钥或其被截断的前缀。

流式请求 timeoutMs 表示建立连接/等待响应头及相邻数据块之间的空闲超时，不是持续输出的总时长上限。请求失败、正常结束、用户取消和重试前都须释放计时器与旧 reader；收到协议终态即结束读取，不等待上游关闭 HTTP 连接。子 Agent 的整体执行上限仍由 maxChildTimeoutSec 控制，失败实例仍计入委派树数量预算，不能自动返还以绕过上限。

## 模型思考能力发现（2026-10-19）

模型配置区打开时读取供应商 Models API，并提供手动刷新。Runtime 通过已保存的供应商地址、协议与请求头读取元数据，不发送补全探测，不读取其他供应商凭据；禁止跟随重定向，整次刷新 10 秒超时，响应体与分页有界。Claude 使用 `/v1/models` 与其原生鉴权，OpenAI 兼容协议在已配置 API 基址追加 `/models`，包括 OpenRouter 的参数元数据。

思考支持、强度调节和等级列表分别记录；未知为 `null`，不能视为“不支持”。优先级为手动覆盖 → 缓存的供应商能力 → 精确模型 ID 与官方域名匹配的内置能力表 → 未知。内置表覆盖部分 OpenAI o 系列、GPT-4.1、GPT-5/5.1/5.2，不按名称前缀猜测其他型号或中转站能力。仅声明 reasoning 参数但没有具体等级的接口仍显示等级未知，不能自动假定 low/medium/high。能力表依据 [OpenAI 模型文档](https://developers.openai.com/api/docs/models/gpt-5.2)；元数据字段依据 [Claude Models](https://platform.claude.com/docs/en/api/models) 与 [OpenRouter Models](https://openrouter.ai/docs/api/api-reference/models/get-models)。

自动检测结果单独缓存于 `provider_models`，不覆盖手动能力或运行参数。v51 迁移将既有配置保留为手动模式；新配置默认自动识别，显式手动字段仍兼容旧调用方。恢复默认会移除该模型覆盖与缓存；重新刷新可再次获取元数据。供应商地址、协议、密钥引用或请求头更改时失效检测缓存；刷新期间供应商变更则丢弃结果。失败保留缓存并显示提示，不回传供应商响应正文。设置、Composer、角色模板与执行使用同一有效配置投影；Anthropic 模型能力可展示，但现有适配器仍不发送思考强度参数。

实现使用跨平台 Node fetch/SQLite，不引入平台分支或新增系统依赖；macOS、Windows、Linux 行为相同，真实供应商与三平台 GUI 仍需单独验收。

本次验证：format、lint、根级/前端 typecheck、build:packages、Rust fmt/test（237 项）、Tauri check 与 macOS .app/DMG 打包通过。契约 83 项、Runtime Client 28 项、供应商/角色/Store 相关 Runtime 71 项通过；前端完整套件最终 86/86（含模型选择 5 项）；首次并行构建期间出现的聊天记录导入菜单超时，单独与完整重跑均通过。macOS 合成供应商 GUI 验证了自动识别、未知状态、手动覆盖、刷新保留覆盖、恢复自动与 Composer 同步。dev 四次采样受到并行构建影响，最终样本宿主/渲染/Runtime CPU 分别为 0%/0.4%/0%；RSS 受热更新及并行构建影响，本次不据此宣称内存无回归，未完成修改前后内存基准和长稳验证。Windows/Linux 与真实供应商调用未验收。
