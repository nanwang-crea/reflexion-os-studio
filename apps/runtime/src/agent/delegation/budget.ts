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
    if (
      this.settings.maxChildRuns !== null &&
      this.created >= this.settings.maxChildRuns
    ) {
      throw new ChildLimitError(
        'child_limit_runs',
        `整棵委派树的子 Agent 数量超过上限 ${this.settings.maxChildRuns}`,
      )
    }
    if (
      this.settings.maxParallelChildren !== null &&
      this.active >= this.settings.maxParallelChildren
    ) {
      throw new ChildLimitError(
        'child_limit_parallel',
        `整棵委派树的并发子 Agent 数超过上限 ${this.settings.maxParallelChildren}`,
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
