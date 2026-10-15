import { childLimit, limitSettingsHint } from '../run/budgets.js'
import type { AgentSettings } from '@reflexion-os-studio/contracts'
import { ChildLimitError } from '../errors.js'

export interface DelegationBudgetLease {
  release(): void
  rollback(): void
}

/** One coordinator is shared by every descendant of a top-level run. */
export class DelegationBudgetCoordinator {
  private created: number
  private active = 0

  constructor(
    readonly rootRunId: string,
    private readonly settings: AgentSettings,
    alreadyCreated = 0,
  ) {
    this.created = alreadyCreated
  }

  acquire(): DelegationBudgetLease {
    const maxRuns = childLimit(this.settings, 'maxChildRuns')
    if (maxRuns !== null && this.created >= maxRuns) {
      throw new ChildLimitError(
        'child_limit_runs',
        `整棵委派树的子 Agent 数量达到累计创建上限 ${maxRuns}。${limitSettingsHint('整棵委派树的子 Agent 总数', '子 Agent 委派')}`,
      )
    }
    if (
      this.settings.maxParallelChildren !== null &&
      this.active >= this.settings.maxParallelChildren
    ) {
      throw new ChildLimitError(
        'child_limit_parallel',
        `整棵委派树的并发子 Agent 数达到上限 ${this.settings.maxParallelChildren}。请等待现有任务完成，或前往「设置 → Agent 运行时 → 子 Agent 委派」调整「并行子 Agent 数」（最多 8 个）。`,
      )
    }
    this.created += 1
    this.active += 1
    let active = true
    return {
      release: () => {
        if (!active) return
        active = false
        this.active -= 1
      },
      rollback: () => {
        if (!active) return
        active = false
        this.active -= 1
        this.created -= 1
      },
    }
  }
}
