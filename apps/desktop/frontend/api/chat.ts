import { request } from './client'

/** 发送消息并启动一次回复；providerId/model 缺省时由 Runtime 回退默认配置。 */
export function sendMessage(input: {
  sessionId: string
  content: string
  providerId?: string
  model?: string
}): Promise<{ messageId: string; runId: string }> {
  return request<{ messageId: string; runId: string }>('message.send', input)
}

export function cancelRun(runId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('run.cancel', { runId })
}

export function retryRun(runId: string): Promise<{
  messageId: string
  runId: string
  retryOfRunId: string
}> {
  return request<{ messageId: string; runId: string; retryOfRunId: string }>(
    'run.retry',
    { runId },
  )
}
