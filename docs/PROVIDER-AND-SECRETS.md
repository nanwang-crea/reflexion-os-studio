# Provider and Secrets

Phase 1A 首先支持 OpenAI-compatible Chat Provider。配置包括 `providerId`、`baseUrl`、`model`、streaming/tool-calling 能力、请求超时、重试次数、上下文/输出上限和可选代理。Provider 负责模型请求和流式事件，不负责 Session、Run、审批、Tool 或数据库。

API Key 使用系统 Keychain 保存。SQLite、Event Log、普通日志、Chat 消息和 Tool 输出只保存 secret reference，不保存明文。Runtime 使用时由 Host 受控注入；UI 始终遮罩。支持缺失凭据提示、更新、删除和轮换。

Provider 错误统一映射为稳定的 `configuration`、`authentication`、`rate_limit`、`timeout`、`network`、`unsupported`、`provider` 类型。重试只对明确可重试错误生效；流式响应已经产生 Tool Call 或外部副作用后不自动重试整个 Run。
