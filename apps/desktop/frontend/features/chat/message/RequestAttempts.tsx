import './request-attempts.css'
import { memo, useState } from 'react'
import type { Message } from '@reflexion-os-studio/runtime-client'
import { CopyButton } from '../../../components/CopyButton'
import { MarkdownCore } from '../../../components/markdown/md-core'
import { ReasoningBlock } from './ReasoningBlock'

type Attempt = NonNullable<Message['requestAttempts']>[number]

/** Diagnostic history is separate from the current answer and model context. */
export const RequestAttempts = memo(function RequestAttempts({
  message,
}: {
  message: Message
}) {
  const attempts = message.requestAttempts ?? []
  if (!attempts.length) return null
  return (
    <details className="request-attempts">
      <summary>请求记录（{attempts.length} 次）</summary>
      {attempts.map((attempt) => (
        <AttemptRow key={attempt.id} attempt={attempt} />
      ))}
    </details>
  )
})

function AttemptRow({ attempt }: { attempt: Attempt }) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        第 {attempt.attempt} 次 ·{' '}
        {attempt.status === 'failed' && attempt.receivedBytes === 0
          ? '失败'
          : labels[attempt.status]}{' '}
        · {(attempt.durationMs / 1000).toFixed(1)} 秒
      </summary>
      {open && (
        <>
          <p>
            阶段：{phases[attempt.phase]} · 接收 {attempt.receivedBytes} 字节 ·
            最长等待 {(attempt.maxIdleMs / 1000).toFixed(1)} 秒
            {attempt.firstDataMs !== undefined &&
              ` · 首批数据 ${(attempt.firstDataMs / 1000).toFixed(1)} 秒`}
            {attempt.firstTextMs !== undefined &&
              ` · 首段正文 ${(attempt.firstTextMs / 1000).toFixed(1)} 秒`}
            {attempt.firstReasoningMs !== undefined &&
              ` · 首段思考 ${(attempt.firstReasoningMs / 1000).toFixed(1)} 秒`}
            {attempt.responseStatus !== undefined &&
              ` · HTTP ${attempt.responseStatus}`}
          </p>
          {attempt.providerRequestId && (
            <p>请求 ID：{attempt.providerRequestId}</p>
          )}
          {attempt.errorMessage && <p role="note">{attempt.errorMessage}</p>}
          {attempt.reasoning && (
            <ReasoningBlock text={attempt.reasoning} active={false} />
          )}
          {attempt.content && (
            <>
              <p>
                本次尝试未完成，以下内容仅供参考。
                <CopyButton text={attempt.content} />
              </p>
              <MarkdownCore text={attempt.content} />
            </>
          )}
        </>
      )}
    </details>
  )
}
const labels = {
  running: '进行中',
  completed: '已完成',
  failed: '已中断',
  cancelled: '已取消',
  interrupted: '进程中断',
}

const phases = { connect: '建立请求', response: '读取响应', stream: '接收输出' }
