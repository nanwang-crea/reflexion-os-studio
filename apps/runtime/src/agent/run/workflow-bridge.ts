import type { RunLauncher, LaunchOptions } from '../launcher.js'
import type { Store } from '../../store/index.js'
import type { SystemRuntimeClient } from '../../system.js'
import type { McpManager } from '../../mcp/manager.js'
import { INHERITABLE_CHILD_TOOLS } from '../delegation/instance.js'

export function createWorkflowBridge(
  store: Store,
  launcher: RunLauncher,
  system: SystemRuntimeClient | null,
  mcp: McpManager | null,
) {
  return {
    launch(input: LaunchOptions): void {
      launcher.launch({
        ...input,
        childRunStarter: undefined,
        isolatedContext: true,
      })
    },
    tools(projectId: string): ReadonlySet<string> {
      const hasWorkspace = Boolean(store.projects.get(projectId)?.folderPath)
      return new Set([
        ...INHERITABLE_CHILD_TOOLS.filter(
          (tool) =>
            !['task', 'ask_user'].includes(tool) &&
            (!(tool.startsWith('file.') || tool.startsWith('shell.')) ||
              (hasWorkspace && system?.available)),
        ),
        ...(mcp
          ?.allTools()
          .map((tool) => `${tool.serverId}/${tool.toolName}`) ?? []),
      ])
    },
  }
}
