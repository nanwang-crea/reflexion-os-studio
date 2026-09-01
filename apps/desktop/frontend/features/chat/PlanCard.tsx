import type { Plan, PlanStepStatus } from '@reflexion-os-studio/runtime-client'

const labels: Record<PlanStepStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
}

export function PlanCard({ plan }: { plan: Plan }): React.JSX.Element {
  return (
    <section className={`plan-card plan-${plan.status}`} aria-label="任务计划">
      <div className="plan-card-header">
        <strong>{plan.goal}</strong>
        <span>{plan.status === 'active' ? '进行中' : plan.status}</span>
      </div>
      <ol className="plan-card-steps">
        {plan.steps.map((step) => (
          <li key={step.id} className={`plan-step plan-step-${step.status}`}>
            <span aria-hidden="true">
              {step.status === 'completed' ? '✓' : '○'}
            </span>
            <span>{step.title}</span>
            <small>{labels[step.status]}</small>
          </li>
        ))}
      </ol>
      {plan.summary && <p className="plan-card-summary">{plan.summary}</p>}
    </section>
  )
}
