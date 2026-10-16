import { BrowserScreenshotResults } from '../images/BrowserScreenshotResults'
import { toolLabel } from '../tools/labels'
import { PlanSnapshotSchema } from '@reflexion-os-studio/runtime-client'
import { PlanReview } from '../interactions/PlanReview'
import { useState } from 'react'
import { groupToolCalls, describeToolGroup } from './tool-groups'
import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  awaiting_approval: '等待审批',
  awaiting_user_input: '等待回答',
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
      {groupToolCalls(props.calls).map((group) =>
        group.kind === 'single' ? (
          <ToolTraceItem
            key={group.calls[0].id}
            call={group.calls[0]}
            runActive={props.runActive}
          />
        ) : (
          <details
            className={`tool-trace-group ${group.kind}`}
            key={group.calls[0].id}
          >
            <summary className="tool-trace-row">
              {describeToolGroup(group)}
            </summary>
            <div className="tool-trace-group-body">
              {group.calls.map((call) => (
                <ToolTraceItem
                  key={call.id}
                  call={call}
                  runActive={props.runActive}
                />
              ))}
            </div>
          </details>
        ),
      )}
    </div>
  )
}

function ToolTraceItem(props: {
  call: ToolCall
  runActive: boolean
}): React.JSX.Element {
  const { call } = props
  const data = call.output?.data
  const snapshot = PlanSnapshotSchema.safeParse(
    data && typeof data === 'object' && !Array.isArray(data)
      ? data.planSnapshot
      : undefined,
  )
  const [open, setOpen] = useState(false)
  const label = toolLabel(call)
  const inFlight = props.runActive && isInFlight(call)
  // 参数与结果/错误都展示：失败调用的 errorCode 不能被参数遮蔽。
  const detail = [formatArgs(call.args), formatResult(call)]
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
        <span className="trace-summary">
          {summarizeArgs(call.args, call.toolName)}
        </span>
        {showStatus && <span className="trace-status">{statusText}</span>}
      </button>
      {call.toolName === 'exit_plan_mode' && snapshot.success && (
        <PlanReview snapshot={snapshot.data} historical />
      )}
      {open && <BrowserScreenshotResults call={call} />}
      {open && detail !== '' && <pre className="trace-detail">{detail}</pre>}
    </div>
  )
}

function isInFlight(call: ToolCall): boolean {
  return (
    call.status === 'pending' ||
    call.status === 'awaiting_approval' ||
    call.status === 'awaiting_user_input' ||
    call.status === 'running'
  )
}

/** 一行摘要：文件显示路径，shell 显示命令，其余回退参数 JSON。 */
function summarizeArgs(args: JsonValue, toolName: string): string {
  if (
    toolName === 'browser.execute' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  )
    return args.mode === 'script'
      ? '动作脚本'
      : `动作计划 · ${Array.isArray(args.steps) ? args.steps.length : 0} 步`

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

function formatResult(call: ToolCall) {
  if (call.errorCode !== null) {
    const detail = call.output?.content
    return detail
      ? `失败（${call.errorCode}）：${truncate(detail)}`
      : `失败（${call.errorCode}）`
  }
  const result = call.output?.data ?? call.result
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
