import { useState } from 'react'
import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'

const TOOL_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.glob': '查找文件',
  'file.grep': '搜索内容',
  'file.write': '写入文件',
  'file.edit': '编辑文件',
  'file.delete': '删除文件',
  'file.move': '移动文件',
  'file.mkdir': '创建目录',
  'shell.execute': '执行命令',
  'web.fetch': '网络抓取',
  'skill.use': '加载技能',
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

interface ToolTraceProps {
  calls: ToolCall[]
  runActive: boolean
}

/** 工具轨迹：紧凑单行，点开看参数与结果/错误明细。 */
export function ToolTrace(props: ToolTraceProps): React.JSX.Element {
  if (props.calls.length === 0) return <></>
  return (
    <div className="tool-trace">
      {props.calls.map((call) => (
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
  const [open, setOpen] = useState(false)
  const label = TOOL_LABELS[call.toolName] ?? call.toolName
  const inFlight = props.runActive && isInFlight(call)
  // 参数与结果/错误都展示：失败调用的 errorCode 不能被参数遮蔽。
  const detail = [
    formatArgs(call.args),
    formatResult(call.result, call.errorCode),
  ]
    .filter((section): section is string => section !== null)
    .join('\n')
  // 只在进行中/等待审批/失败时显示状态文案；完成的靠绿色状态点即可。
  const showStatus =
    call.errorCode !== null || (props.runActive && isInFlight(call))
  const statusText =
    call.errorCode !== null
      ? '失败'
      : (STATUS_LABELS[call.status] ?? call.status)
  return (
    <div className={`tool-trace-item status-${call.status}`}>
      <button
        type="button"
        className="tool-trace-row"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`trace-dot ${inFlight ? 'pulse' : ''}`} aria-hidden />
        <span className="trace-name">{label}</span>
        <span className="trace-summary">{summarizeArgs(call.args)}</span>
        {showStatus && <span className="trace-status">{statusText}</span>}
      </button>
      {open && detail !== '' && <pre className="trace-detail">{detail}</pre>}
    </div>
  )
}

function isInFlight(call: ToolCall): boolean {
  return (
    call.status === 'pending' ||
    call.status === 'awaiting_approval' ||
    call.status === 'running'
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
