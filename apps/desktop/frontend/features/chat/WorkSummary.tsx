import { useEffect, useRef, useState } from 'react'
import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'

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

interface WorkSummaryProps {
  /** 已合成流式增量的思考文本；空串表示无思考过程。 */
  reasoningText: string
  /** 思考阶段进行中（回答尚未开始流式）。 */
  thinkingStreaming: boolean
  toolCalls: ToolCall[]
  /** 会话内是否有进行中的 Run；配合轨迹行的脉冲状态。 */
  runActive: boolean
  /** 本次运行耗时；未结束或数据缺失时为 null（显示进行中态）。 */
  runDurationMs: number | null
}

/**
 * 工作摘要：思考过程与工具轨迹合并为一个聚合折叠块（对齐 ChatGPT 桌面版）。
 * 进行中显示“思考中…/正在处理…”并自动展开明细；全部结束后折叠为
 * “工作了 X 分 X 秒”一行，点击展开回看思考与工具步骤，最终回答在下方。
 */
export function WorkSummary(props: WorkSummaryProps): React.JSX.Element {
  const active = props.thinkingStreaming || props.toolCalls.some(isInFlight)
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 跟随状态：进行中展开、结束后收起；手动开合在下一次状态切换前有效。
  useEffect(() => {
    setOpen(active)
  }, [active])

  // 思考进行中正文自动滚到底部，让用户持续看到新思考内容。
  useEffect(() => {
    if (!open || !props.thinkingStreaming) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [props.reasoningText, open, props.thinkingStreaming])

  const label = active
    ? props.thinkingStreaming
      ? '思考中…'
      : '正在处理…'
    : props.runDurationMs !== null
      ? `工作了 ${formatDuration(props.runDurationMs)}`
      : '处理完成'

  return (
    <div className="work-summary">
      <button
        type="button"
        className="work-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`work-summary-label${active ? ' shimmer' : ''}`}>
          {label}
        </span>
        <span className={`work-summary-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="work-summary-body">
          {props.reasoningText !== '' && (
            <div className="work-thinking">
              <div className="work-thinking-label">思考</div>
              <div className="work-thinking-text" ref={bodyRef}>
                {props.reasoningText}
              </div>
            </div>
          )}
          {props.toolCalls.length > 0 && (
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

/** 耗时展示：不足一分钟显示秒数，秒数为零的整分/整时省略秒。 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0)
    return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`
  return `${secs} 秒`
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
