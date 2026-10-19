import type { RunPerformance } from '@reflexion-os-studio/runtime-client'
import './performance.css'

export function RunPerformanceDetails({
  metrics,
}: {
  metrics?: RunPerformance | null
}) {
  if (!metrics) return null
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
  const entries = [
    ['总耗时', seconds(metrics.elapsedMs)],
    ['模型调用', `${metrics.modelCalls} 轮 · ${seconds(metrics.modelMs)}`],
    [
      '请求重试',
      `${metrics.requestRetries} 次 / ${metrics.requestAttempts} 次请求`,
    ],
    [
      '平均首数据等待',
      metrics.firstDataSamples
        ? seconds(metrics.firstDataWaitMs / metrics.firstDataSamples)
        : '未记录',
    ],
    ['审批等待（累计）', seconds(metrics.approvalWaitMs)],
    ['写锁等待（累计）', seconds(metrics.mutationWaitMs)],
    [
      '工具执行（累计）',
      `${metrics.toolCalls} 次 · ${seconds(metrics.toolExecutionMs)}`,
    ],
    ['其中 Shell 执行', seconds(metrics.shellExecutionMs)],
    ['工具批次耗时', seconds(metrics.toolBatchMs)],
    [
      '工具失败',
      `${metrics.toolFailures} 次，含编辑失败 ${metrics.editFailures} 次`,
    ],
    ['提前读取', `${metrics.streamedReads} 次`],
  ]
  return (
    <details className="run-performance">
      <summary>耗时明细</summary>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>并行工具与模型读取可能重叠，各项耗时不能直接相加。</p>
    </details>
  )
}
