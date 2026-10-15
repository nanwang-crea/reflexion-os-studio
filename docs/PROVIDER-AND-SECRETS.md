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
