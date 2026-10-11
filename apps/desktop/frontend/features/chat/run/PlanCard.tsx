import { useState } from 'react'
import type {
  Plan,
  PlanStep,
  PlanStepStatus,
} from '@reflexion-os-studio/runtime-client'
import { ChevronIcon, ListIcon } from '../../../ui/icons'
import './plan-card.css'

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

/** Composer 上方的可折叠计划，展开后展示步骤及各自状态。 */
export function PlanCard({ plan }: { plan: Plan }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // 进度口径：completed/skipped/cancelled 均已了结。
  const finished = plan.steps.filter(
    (step) =>
      step.status === 'completed' ||
      step.status === 'skipped' ||
      step.status === 'cancelled',
  ).length
  const active = currentStep(plan.steps)

  return (
    <section
      className={`plan-float plan-${plan.status} ${open ? 'plan-expanded' : 'plan-collapsed'}`}
      aria-label="任务计划"
    >
      <button
        type="button"
        className="plan-float-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="plan-float-eyebrow">
          <ListIcon size={14} />
          执行计划
        </span>
        {!open && (
          <span className="plan-float-preview">
            {plan.status === 'active' && active ? active.title : plan.goal}
          </span>
        )}
        <span className="plan-float-meta">
          <span className="plan-float-dot" aria-hidden="true" />
          <span className="plan-float-status">{statusLabels[plan.status]}</span>
          <span className="plan-float-progress">
            {finished}/{plan.steps.length}
          </span>
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="plan-float-body">
          <p className="plan-float-goal">{plan.goal}</p>
          <ol className="plan-card-steps">
            {plan.steps.map((step, index) => (
              <li
                key={step.id}
                className={`plan-step plan-step-${step.status}`}
              >
                <span className="plan-step-marker" aria-hidden="true">
                  {step.status === 'completed' ? '✓' : index + 1}
                </span>
                <span className="plan-step-title">{step.title}</span>
                {step.status !== 'pending' && (
                  <small>{stepLabels[step.status]}</small>
                )}
              </li>
            ))}
          </ol>
          {plan.summary && <p className="plan-card-summary">{plan.summary}</p>}
        </div>
      )}
    </section>
  )
}
