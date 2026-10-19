import {
  FileEditBatchResultSchema,
  type ToolCall,
} from '@reflexion-os-studio/runtime-client'

const labels = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  not_executed: '未执行',
}

/** Display only canonical per-file results; successful files survive partial failure. */
export function FileEditBatchDetails({ call }: { call: ToolCall }) {
  const parsed = FileEditBatchResultSchema.safeParse(call.output?.data)
  if (!parsed.success)
    return (
      <pre className="trace-detail">
        {call.output?.content ?? '等待逐文件执行结果'}
      </pre>
    )
  return (
    <div className="trace-detail">
      {parsed.data.results.map((entry) => (
        <details key={entry.toolCallId}>
          <summary>
            {entry.path} · {labels[entry.status]}
          </summary>
          <pre>
            {entry.output?.content.slice(0, 2000) ?? '此文件未执行修改'}
            {(entry.output?.content.length ?? 0) > 2000
              ? '\n…结果过长，预览已截断'
              : ''}
          </pre>
        </details>
      ))}
    </div>
  )
}
