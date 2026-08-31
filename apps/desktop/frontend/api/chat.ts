import { request } from './client'

/** 发送结果：会话空闲时立即开始(queued=false)；忙碌时自动入队(queued=true)。 */
export interface SendMessageResult {
  queued: boolean
  messageId: string | null
  runId: string | null
  queueId: string | null
  position: number | null
}

/** 发送消息并启动一次回复；providerId/model 缺省时由 Runtime 回退默认配置。 */
export function sendMessage(input: {
  sessionId: string
  content: string
  providerId?: string
  model?: string
  /** 工具权限 Profile；缺省 workspace（Runtime 侧默认）。 */
  permissionMode?: 'workspace' | 'read-only'
}): Promise<SendMessageResult> {
  return request<SendMessageResult>('message.send', input)
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
