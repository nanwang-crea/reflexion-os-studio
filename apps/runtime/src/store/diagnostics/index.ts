import type { DatabaseSync } from 'node:sqlite'
import type { RunStore } from '../chat/runs.js'
import type { ToolCallStore } from '../chat/toolCalls.js'
import { DeveloperOverviewQueries } from './overview.js'
import { DeveloperRunQueries } from './runs.js'
import { DeveloperToolQueries } from './tools.js'
import { DeveloperModelQueries } from './models.js'

/** Read projections over existing canonical records; no duplicate tool output. */
export class DeveloperStore {
  readonly overview: DeveloperOverviewQueries
  readonly runs: DeveloperRunQueries
  readonly tools: DeveloperToolQueries
  readonly models: DeveloperModelQueries
  constructor(db: DatabaseSync, runs: RunStore, tools: ToolCallStore) {
    this.overview = new DeveloperOverviewQueries(db)
    this.runs = new DeveloperRunQueries(db, runs)
    this.tools = new DeveloperToolQueries(db, tools)
    this.models = new DeveloperModelQueries(db)
  }
}
