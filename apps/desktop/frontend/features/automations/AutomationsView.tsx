import { BoxIcon } from '../../ui/icons'

/**
 * 自动化占位：定时任务 / 工作流编排将在后续版本提供。
 * Phase 1A 不实现调度引擎，仅占位提示避免误解为不可用。
 */
export function AutomationsView(): React.JSX.Element {
  return (
    <div className="automations-view">
      <header className="panel-head">
        <h1>自动化</h1>
        <p className="panel-sub">定时任务与工作流编排将在后续版本提供。</p>
      </header>

      <div className="placeholder-card">
        <div className="placeholder-icon" aria-hidden="true">
          <BoxIcon />
        </div>
        <h2>Workflow 引擎尚未开放</h2>
        <p className="placeholder-text">
          “自动化”将以可拖拽的节点图呈现：触发器 → Agent 节点 → 工具节点 →
          文件输出。你可以提前在 Composer 里执行单步任务，自动化会在你能
          稳定复现的时候把流程沉淀下来。
        </p>
        <ul className="placeholder-list">
          <li>⏰ 定时任务：按 cron / 间隔触发 Run</li>
          <li>🔁 工作流：顺序 / 并行 / 条件分支</li>
          <li>📦 产物：把结果落到文件 / 通知 / 数据库</li>
        </ul>
        <button type="button" className="ghost" disabled>
          订阅版本更新
        </button>
      </div>
    </div>
  )
}
