# Provider and Secrets

Phase 1A 首先支持 OpenAI-compatible Chat Provider。配置包括 `providerId`、`baseUrl`、`model`、streaming/tool-calling 能力、请求超时、重试次数、上下文/输出上限和可选代理。Provider 负责模型请求和流式事件，不负责 Session、Run、审批、Tool 或数据库。

API Key 最终保存位置为系统 Keychain/安全存储。**MVP 阶段的实现**为 Runtime 本地密钥文件（数据目录下 `secrets.json`，0600 权限，`provider.configure` 的 `secret` 为只写参数，落盘后仅以 `secretRef` 引用），Keychain 接入在 Phase 6 替换存储后端，协议不变。SQLite、Event Log、普通日志、Chat 消息和 Tool 输出只保存 secret reference，不保存明文；secret 不进入任何响应、事件或日志。Runtime 使用时自行读取；UI 始终遮罩。支持缺失凭据提示、更新、删除和轮换。

Provider 错误统一映射为稳定的 `configuration`、`authentication`、`rate_limit`、`timeout`、`network`、`unsupported`、`provider` 类型。重试只对明确可重试错误生效；流式响应已经产生 Tool Call 或外部副作用后不自动重试整个 Run。
