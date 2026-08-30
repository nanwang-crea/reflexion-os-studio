import { useEffect, useState } from 'react'
import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'

const TOOL_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.write': '写入文件',
  'file.edit': '编辑文件',
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
 * 工具轨迹组：一条 assistant 消息发起的工具调用合并成一个可折叠单元。
 * 有调用进行中时组自动展开、组头显示当前调用；全部结束后自动折叠为
 * “编辑了 N 个文件 · 执行了 N 条命令”式一行摘要（与思考面板同构：
 * 用户手动开合在下次状态切换前有效）。
 */
export function ToolTraceCard(props: ToolTraceCardProps): React.JSX.Element {
  const activeCall = props.toolCalls.find(isInFlight)
  const active = activeCall !== undefined
  const [open, setOpen] = useState(false)

  // 跟随状态：进行中展开、结束后收起；手动开合在下一次状态切换前有效。
  useEffect(() => {
    setOpen(active)
  }, [active])

  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-group-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {active ? (
          <>
            <span className="trace-dot pulse" aria-hidden />
            <span className="tool-group-label">
              {TOOL_LABELS[activeCall.toolName] ?? activeCall.toolName}{' '}
              {summarizeArgs(activeCall.args)}
            </span>
          </>
        ) : (
          <span className="tool-group-label">
            {summarizeCompleted(props.toolCalls)}
          </span>
        )}
        <span className={`tool-group-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="tool-trace">
          {props.toolCalls.map((call) => (
            <ToolTraceItem
              key={call.id}
              call={call}
              runActive={props.runActive}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolTraceItem(props: {
  call: ToolCall
  runActive: boolean
}): React.JSX.Element {
  const { call } = props
  const label = TOOL_LABELS[call.toolName] ?? call.toolName
  const inFlight = props.runActive && isInFlight(call)
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

function isInFlight(call: ToolCall): boolean {
  return (
    call.status === 'pending' ||
    call.status === 'awaiting_approval' ||
    call.status === 'running'
  )
}

/** 完成态摘要：按类别计数，未使用的类别不出现，失败数量追加在末尾。 */
function summarizeCompleted(calls: ToolCall[]): string {
  let filesEdited = 0
  let filesRead = 0
  let commands = 0
  let others = 0
  let failed = 0
  for (const call of calls) {
    if (call.status === 'failed') failed += 1
    if (call.toolName === 'file.edit' || call.toolName === 'file.write') {
      filesEdited += 1
    } else if (call.toolName.startsWith('file.')) {
      filesRead += 1
    } else if (call.toolName === 'shell.execute') {
      commands += 1
    } else {
      others += 1
    }
  }
  const parts: string[] = []
  if (filesEdited > 0) parts.push(`编辑了 ${filesEdited} 个文件`)
  if (filesRead > 0) parts.push(`读取了 ${filesRead} 个文件`)
  if (commands > 0) parts.push(`执行了 ${commands} 条命令`)
  if (others > 0) parts.push(`${others} 个操作`)
  if (failed > 0) parts.push(`失败 ${failed} 个`)
  return parts.join(' · ')
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
