import type {
  WorkflowValues,
  RuntimeEvent,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { WorkflowAgentExecutor } from './types.js'

export interface WorkflowServiceDeps {
  store: Store
  executor: WorkflowAgentExecutor
  availableTools: (projectId: string) => ReadonlySet<string>
  validateResources: (
    projectId: string,
    values: WorkflowValues,
    signal?: AbortSignal,
  ) => Promise<void>
  notify: (event: RuntimeEvent) => void
  clearPermissionDomain: (id: string) => void
}
