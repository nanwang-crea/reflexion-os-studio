# 流式模型请求重试设计

## 目标

当模型响应流在已经产生增量后发生任意读取、解析或协议错误时，自动重新发起完整请求，而不是直接失败。重试与请求建立阶段的网络错误、HTTP 429/5xx 共用同一 `maxRetries` 预算。

用户主动取消不重试；重试耗尽后才将本轮消息和 Run 标记为失败。

## 架构与数据流

`streamChatCompletion` 将每次 HTTP 请求和 SSE 消费封装为独立 attempt。每个 attempt 使用独立的内容、推理内容、工具调用、完成原因和 usage 累积状态。

- 请求建立失败：沿用现有网络错误重试逻辑。
- HTTP 429/5xx：沿用现有状态码重试逻辑。
- 响应流读取、SSE 解析或协议错误：消耗同一重试预算，丢弃当前 attempt 的全部结果后重新发送完整请求。
- 成功结束：只返回最后一次 attempt 的完整结果。
- `AbortError`：立即抛出，不重试。
- 超时错误及其他流错误：按流错误重试；重试耗尽后抛出最终错误。

重试回调继续发送 `run.retrying`，并使用已有的 attempt、maxRetries、reason 字段。

## 前端可见行为与消息回滚

Runner 在每次流重试前清除当前 assistant 草稿的本地增量和持久化 pending 内容，并重置 chunk 序号，然后发送：

1. `run.retrying`
2. `message.reset`，携带当前 `messageId`

前端收到 `message.reset` 后清空该 assistant 消息的正文、reasoning 和相关临时流状态，再接收下一次 attempt 的增量。不会创建新的 assistant message，因此消息 ID、Run 关联和审计链保持稳定。

如果重试最终失败，Runner 仅在失败路径统一 finalize 当前消息为 `failed`，避免把中间 attempt 的部分内容留在最终 UI 或数据库中。

## 协议变更

在 contracts 中新增 `message.reset` 事件，至少包含 `messageId`。同步更新 Runtime 事件类型、Tauri/runtime-client 转发类型以及前端事件 reducer/消息状态处理。

事件必须遵循现有 newline-delimited JSON 协议；不得把原始异常详情写入协议之外的敏感字段。

## 错误处理

- 用户取消优先级高于自动重试：任何 attempt 等待退避或读取流期间收到调用方取消，都立即结束为 cancelled。
- 重试退避沿用现有退避序列，并使用可取消 signal。
- 流错误要保留原始错误用于最终失败信息，但不得因重试日志泄露 API key 或请求体。
- 工具调用只有在完整流成功结束并返回后才交给 agent loop；中途失败的部分工具调用全部丢弃，不能执行。

## 测试

新增或调整测试覆盖：

- 流开始后发生读取错误，按 `maxRetries` 重试并最终返回完整成功结果。
- 流错误重试期间发出正确的 `onRetry` 原因、次数和最大次数。
- 流错误在重试耗尽后失败，不返回中间内容。
- 流错误期间用户取消不重试，并保持 `AbortError` 语义。
- Runner 在重试前发出 `run.retrying` 和 `message.reset`，并重置草稿/序号。
- Runner 最终失败时只持久化最终失败状态，不残留中间 attempt 内容。
- 现有请求建立网络错误、429/5xx、认证错误和用户取消测试继续通过。
