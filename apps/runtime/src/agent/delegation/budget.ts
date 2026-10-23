import { childLimit, limitSettingsHint } from '../run/budgets.js'
import type { AgentSettings, Delegation } from '@reflexion-os-studio/contracts'
import { ChildLimitError } from '../errors.js'

export interface DelegationBudgetLease {
  release(): void
  rollback(): void
}

/** One coordinator is shared by every descendant of a top-level run. */
export class DelegationBudgetCoordinator {
  private active: number

  constructor(
    readonly rootRunId: string,
    private readonly settings: AgentSettings,
    existing: readonly Pick<Delegation, 'status'>[] = [],
  ) {
    this.active = existing.filter((item) =>
      ['pending', 'running'].includes(item.status),
    ).length
  }

  acquire(): DelegationBudgetLease {
    const maxRuns = childLimit(this.settings, 'maxChildRuns')
    if (maxRuns !== null && this.active >= maxRuns) {
      throw new ChildLimitError(
        'child_limit_runs',
        `整棵委派树中未结束的子 Agent 数量达到上限 ${maxRuns}。${limitSettingsHint('整棵委派树的活跃子 Agent 上限', '子 Agent 委派')}`,
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
    this.active += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.active -= 1
    }
    return {
      release,
      rollback: release,
    }
  }
}
