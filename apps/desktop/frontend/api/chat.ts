import { request } from './client'

/** 发送消息并启动一次回复；providerId/model 缺省时由 Runtime 回退默认配置。 */
export function sendMessage(input: {
  sessionId: string
  content: string
  providerId?: string
  model?: string
  /** 工具权限 Profile；缺省 workspace（Runtime 侧默认）。 */
  permissionMode?: 'workspace' | 'read-only'
}): Promise<{ messageId: string; runId: string }> {
  return request<{ messageId: string; runId: string }>('message.send', input)
}

export function cancelRun(runId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('run.cancel', { runId })
}

export function resolveApproval(input: {
  toolCallId: string
  decision: 'approved' | 'denied'
  scope: 'once' | 'session'
}): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('approval.resolve', input)
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
