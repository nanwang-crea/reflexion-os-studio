import { useState } from 'react'
import type {
  Plan,
  PlanStep,
  PlanStepStatus,
} from '@reflexion-os-studio/runtime-client'
import { ChevronIcon, ListIcon } from '../../ui/icons'

const stepLabels: Record<PlanStepStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  skipped: '已跳过',
  cancelled: '已取消',
}

const statusLabels: Record<Plan['status'], string> = {
  active: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

/** 当前正在推进的步骤：优先进行中，其次待处理的第一步。 */
function currentStep(steps: PlanStep[]): PlanStep | null {
  return (
    steps.find((step) => step.status === 'in_progress') ??
    steps.find((step) => step.status === 'pending') ??
    null
  )
}

/**
 * 悬浮常驻的任务计划小卡片（Codex/ChatGPT 式）：只要当前会话有计划就显示在
 * 对话区右上角，不占聊天流宽度、不随滚动被顶走。折叠态只显示目标 + 当前步骤
 * 预览；展开态列出全部步骤，限高内部滚动。
 */
export function PlanCard({ plan }: { plan: Plan }): React.JSX.Element {
  const [open, setOpen] = useState(() => plan.status === 'active')
  // 进度口径：completed/skipped/cancelled 均已了结。
  const finished = plan.steps.filter(
    (step) =>
      step.status === 'completed' ||
      step.status === 'skipped' ||
      step.status === 'cancelled',
  ).length
  const active = currentStep(plan.steps)

  return (
    <section className={`plan-float plan-${plan.status}`} aria-label="任务计划">
      <button
        type="button"
        className="plan-float-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ListIcon size={13} />
        <strong className="plan-float-goal">{plan.goal}</strong>
        <span className="plan-float-meta">
          <span className="plan-float-dot" aria-hidden="true" />
          <span className="plan-float-status">{statusLabels[plan.status]}</span>
          <span className="plan-float-progress">
            {finished}/{plan.steps.length}
          </span>
        </span>
        <ChevronIcon />
      </button>
      {!open && active && (
        <p className="plan-float-current">
          <span className="plan-float-step-label">
            {stepLabels[active.status]}
          </span>
          {active.title}
        </p>
      )}
      {open && (
        <div className="plan-float-body">
          <ol className="plan-card-steps">
            {plan.steps.map((step) => (
              <li
                key={step.id}
                className={`plan-step plan-step-${step.status}`}
              >
                <span aria-hidden="true">
                  {step.status === 'completed' ? '✓' : '○'}
                </span>
                <span>{step.title}</span>
                <small>{stepLabels[step.status]}</small>
              </li>
            ))}
          </ol>
          {plan.summary && <p className="plan-card-summary">{plan.summary}</p>}
        </div>
      )}
    </section>
  )
}
