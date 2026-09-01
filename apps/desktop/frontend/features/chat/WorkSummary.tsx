import { useEffect, useRef, useState } from 'react'
import type { JsonValue, ToolCall } from '@reflexion-os-studio/runtime-client'
import type { RunPhase } from '../../hooks/useAppBootstrap'
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
  /** Run 级事件驱动阶段；活动间隙保持上一次阶段。 */
  phase: RunPhase | undefined
  toolCalls: ToolCall[]
  /** 会话内是否有进行中的 Run；配合轨迹行的脉冲状态。 */
  runActive: boolean
  /** 本次运行耗时；未结束或数据缺失时为 null（显示进行中态）。 */
  runDurationMs: number | null
}

/**
 * 工作摘要：思考过程与工具轨迹合并为一个聚合折叠块（对齐 ChatGPT 桌面版）。
 * 进行中显示”思考中…/正在作答…”并自动展开明细；最终正文完全落地后才折叠为
 * “工作了 X 分 X 秒”一行，点击展开回看思考与工具步骤。
 *
 * 折叠条件比”工具/思考全部结束”更严格：只要最终回答还在流式打字，过程行就
 * 保持展开；折叠只在整个回复（含正文）全部完成时触发一次，避免来回跳。
 */
export function WorkSummary(props: WorkSummaryProps): React.JSX.Element {
  // Run 活跃但尚未收到首个阶段事件时也保持活动，避免启动空窗闪出“处理完成”。
  const active = props.runActive
  const thinkingActive = active && props.phase === 'thinking'
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 上一次的 active：只在状态翻转时同步 open，避免相同值的 setState 触发重渲染。
  const prevActiveRef = useRef<boolean | null>(null)

  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = active
    // 首次挂载也要同步：摘要可能是在 Run 已开始后才出现。
    if (wasActive === null || wasActive !== active) setOpen(active)
  }, [active])

  const handleToggle = (): void => {
    setOpen((current) => !current)
  }

  // 思考进行中正文自动滚到底部，让用户持续看到新思考内容。
  useEffect(() => {
    if (!open || !thinkingActive) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [props.reasoningText, open, thinkingActive])

  // 文案来自 Run 事件阶段；正文是否有增量不参与阶段判断。
  const label = active
    ? props.phase === 'thinking'
      ? '思考中…'
      : props.phase === 'answering'
        ? '正在作答…'
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
        onClick={handleToggle}
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
