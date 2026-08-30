import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'

const TOOL_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.write': '写入文件',
  'shell.execute': '执行命令',
  get_current_time: '获取时间',
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  awaiting_approval: '等待审批',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const RESULT_PREVIEW_MAX_CHARS = 2000

interface ToolTraceCardProps {
  toolCalls: ToolCall[]
  /** 会话内是否有进行中的 Run；进行中时未完结调用显示脉冲状态。 */
  runActive: boolean
}

/**
 * 工具轨迹卡：展示一条 assistant 消息发起的工具调用（名称、状态、参数与结果）。
 * 数据来自 session.get 返回的会话级 toolCalls，Run 期间随 tool 事件刷新。
 */
export function ToolTraceCard(props: ToolTraceCardProps): React.JSX.Element {
  return (
    <div className="tool-trace">
      {props.toolCalls.map((call) => (
        <ToolTraceItem key={call.id} call={call} runActive={props.runActive} />
      ))}
    </div>
  )
}

function ToolTraceItem(props: {
  call: ToolCall
  runActive: boolean
}): React.JSX.Element {
  const { call } = props
  const label = TOOL_LABELS[call.toolName] ?? call.toolName
  const inFlight =
    props.runActive &&
    (call.status === 'pending' ||
      call.status === 'awaiting_approval' ||
      call.status === 'running')
  // 参数与结果/错误都展示：失败调用的 errorCode 不能被参数遮蔽。
  const detail = [
    formatArgs(call.args),
    formatResult(call.result, call.errorCode),
  ]
    .filter((section): section is string => section !== null)
    .join('\n')
  return (
    <details className={`tool-trace-item status-${call.status}`}>
      <summary>
        <span className={`trace-dot ${inFlight ? 'pulse' : ''}`} aria-hidden />
        <span className="trace-name">{label}</span>
        <span className="trace-summary">{summarizeArgs(call.args)}</span>
        <span className="trace-status">
          {STATUS_LABELS[call.status] ?? call.status}
        </span>
      </summary>
      {detail !== '' && <pre className="trace-detail">{detail}</pre>}
    </details>
  )
}

/** 一行摘要：文件显示路径，shell 显示命令，其余回退参数 JSON。 */
function summarizeArgs(args: JsonValue): string {
  if (
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    typeof (args as Record<string, unknown>).path === 'string'
  ) {
    return (args as Record<string, string>).path
  }
  if (
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    typeof (args as Record<string, unknown>).command === 'string'
  ) {
    return (args as Record<string, string>).command
  }
  const text = JSON.stringify(args)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function formatArgs(args: JsonValue): string | null {
  if (
    args === null ||
    (typeof args === 'object' && Object.keys(args).length === 0)
  ) {
    return null
  }
  return truncate(`参数：${JSON.stringify(args, null, 2)}`)
}

function formatResult(result: JsonValue | null, errorCode: string | null) {
  if (errorCode !== null) {
    return `失败（${errorCode}）`
  }
  if (result === null) return null
  const text =
    typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return truncate(`结果：${text}`)
}

function truncate(text: string): string {
  return text.length > RESULT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, RESULT_PREVIEW_MAX_CHARS)}…`
    : text
}
