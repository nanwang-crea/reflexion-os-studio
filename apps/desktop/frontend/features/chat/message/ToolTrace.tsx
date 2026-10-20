import { FileEditBatchDetails } from '../tools/FileEditBatchDetails'
import { BrowserScreenshotResults } from '../images/BrowserScreenshotResults'
import { toolLabel } from '../tools/labels'
import { summarizeToolArgs } from '../tools/summaries'
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
                  showDetails
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
  showDetails?: boolean
}): React.JSX.Element {
  const { call } = props
  const data = call.output?.data
  const snapshot = PlanSnapshotSchema.safeParse(
    data && typeof data === 'object' && !Array.isArray(data)
      ? data.planSnapshot
      : undefined,
  )
  const [expanded, setExpanded] = useState(false)
  const open = props.showDetails || expanded
  const label = toolLabel(call)
  const inFlight = props.runActive && isInFlight(call)
  // 参数与结果/错误都展示：失败调用的 errorCode 不能被参数遮蔽。
  const detail = [formatArgs(call.args), formatResult(call)]
    .filter((section): section is string => section !== null)
    .join('\n')
  // 只在进行中/等待审批/失败时显示状态文案；完成的靠绿色状态点即可。
  const showStatus =
    call.errorCode !== null ||
    call.status === 'failed' ||
    call.status === 'cancelled' ||
    (props.runActive && isInFlight(call))
  const statusText =
    call.errorCode !== null
      ? '失败'
      : (STATUS_LABELS[call.status] ?? call.status)
  const row = (
    <>
      <span className={`trace-dot ${inFlight ? 'pulse' : ''}`} aria-hidden />
      <span className="trace-name">{label}</span>
      <span className="trace-summary">{summarizeToolArgs(call)}</span>
      {showStatus && <span className="trace-status">{statusText}</span>}
    </>
  )
  return (
    <div className={`tool-trace-item status-${call.status}`}>
      {props.showDetails ? (
        <div className="tool-trace-row">{row}</div>
      ) : (
        <button
          type="button"
          className="tool-trace-row"
          aria-expanded={open}
          onClick={() => setExpanded((current) => !current)}
        >
          {row}
        </button>
      )}
      {call.toolName === 'exit_plan_mode' && snapshot.success && (
        <PlanReview snapshot={snapshot.data} historical />
      )}
      {open && <BrowserScreenshotResults call={call} />}
      {open && call.toolName === 'file.edit_batch' && (
        <FileEditBatchDetails call={call} />
      )}
      {open && call.toolName !== 'file.edit_batch' && detail !== '' && (
        <pre className="trace-detail">{detail}</pre>
      )}
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
  const result = call.output?.data ?? call.output?.content ?? call.result
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
