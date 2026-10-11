# Provider and Secrets

Phase 1A 首先支持 OpenAI-compatible Chat Provider。配置包括 `providerId`、`baseUrl`、`model`、streaming/tool-calling 能力、请求超时、重试次数、上下文/输出上限和可选代理。Provider 负责模型请求和流式事件，不负责 Session、Run、审批、Tool 或数据库。

Provider 以 `capabilities`（`chat | embedding | image | video`）声明能力类型，决定其可参与的负载；Agent 工具循环通过 canonical `ToolSpec` 声明工具，由 OpenAI-compatible 适配层投影为 function calling 方言，`tool_calls` 流式增量按 index 聚合。embedding/image/video Provider 随 Phase 2/5 接入，协议先行。

API Key 最终保存位置为系统 Keychain/安全存储。**MVP 阶段的实现**为 Runtime 本地密钥文件（数据目录下 `secrets.json`，0600 权限，`provider.configure` 的 `secret` 为只写参数，落盘后仅以 `secretRef` 引用），Keychain 接入在 Phase 6 替换存储后端，协议不变。SQLite、Event Log、普通日志、Chat 消息和 Tool 输出只保存 secret reference，不保存明文；secret 不进入任何响应、事件或日志。Runtime 使用时自行读取；UI 始终遮罩。支持缺失凭据提示、更新、删除和轮换。

Provider 错误统一映射为稳定的 `configuration`、`authentication`、`rate_limit`、`timeout`、`network`、`unsupported`、`provider` 类型。重试只对明确可重试错误生效；流式响应已经产生 Tool Call 或外部副作用后不自动重试整个 Run。

## 模型参数配置

Provider 保存默认 `temperature`、`maxTokens`、`contextWindow`、`contextBudget` 和 `reasoningEffort`。
`provider_models` 按 `(provider_id, model)` 保存模型独立覆盖和 `reasoningEffortSupported`；
`provider.model.list/configure/delete` 经同一 Runtime 请求门面与宿主白名单调用。
省略字段保留原值，`null` 表示继承 Provider 默认；删除模型配置恢复全部继承，删除 Provider 级联删除配置。
模型配置命令要求模型在 Provider 已保存的模型列表中；发送与重试仍保留显式指定模型 ID 的兼容行为。

发送、排队出队、重试和编辑重发统一按「模型覆盖 → Provider 默认 → 适配器默认」解析参数；
消息命令不再接收采样参数。对话页可传非持久化的 `reasoningEffort` 请求意图，
省略使用配置默认，`null` 表示自动；仅在能力允许时覆盖执行期配置，不写入 Run/Message。根 Run 使用解析后的配置装配执行，子 Agent 继承父 Run 配置。
思考强度仅在模型明确声明支持时发送，取值为 `low/medium/high`；
Chat Completions 投影为 `reasoning_effort`，Responses 投影为 `reasoning.effort`。
当前 Anthropic 适配器不发送该参数，设置页禁用对应能力开关。

设置页提供 Provider 默认参数与模型独立配置；对话模型选择器继续按 Provider 分组，
切换模型时重置思考强度为模型/Provider 默认，不支持时显示禁用的自动状态。
模型和 effort 控件复用 Radix Select，实际参数由 Runtime 解析，存储与解析使用
TypeScript/SQLite，macOS、Windows 和 Linux 共用相同实现，不引入平台专属依赖。
