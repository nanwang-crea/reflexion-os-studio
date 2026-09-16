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
  /** 本次发送的权限预设快照；缺省 workspace-read（Runtime 侧默认）。 */
  permissionPreset?: 'workspace-read' | 'workspace-write' | 'workspace-full'
}): Promise<SendMessageResult> {
  return request<SendMessageResult>('message.send', input)
}

export function cancelRun(runId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('run.cancel', { runId })
}

/** 审批裁决：只回传 Runtime 下发的 choiceId（授权 effect 由服务端解析）。 */
export function resolveApproval(input: {
  toolCallId: string
  choiceId: string
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
