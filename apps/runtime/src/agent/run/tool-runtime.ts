import { PermissionGate } from '../permissions/index.js'
import { createToolRegistry } from '../tools/index.js'
import type { PermissionPreset, Session } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { LaunchDeps, LaunchOptions } from '../launcher.js'

/** Assemble stateful tool implementations once, with live authorization views. */
export function createRunToolRuntime(
  deps: LaunchDeps,
  input: LaunchOptions,
  preset: PermissionPreset,
) {
  const { run, session, assistantMessage, emitter } = input
  const sessionId = run.sessionId
  const workspaceRoot = resolveWorkspaceRoot(deps.store, session)
  const registry = createToolRegistry({
    store: deps.store,
    sessionId,
    messageId: assistantMessage.id,
    runId: run.id,
    emitter,
    interactions: deps.interactions,
    system: deps.system,
    workspaceRoot,
    projectId: session.projectId,
    skills: deps.skills,
    skillTools: deps.skillTools,
    mcp: deps.mcp,
    browser: deps.browser,
    childRunStarter: input.childRunStarter,
    allowedTools: input.allowedTools,
    resolveAllowedTools: input.resolvePermissions
      ? () => input.resolvePermissions!().allowedTools
      : undefined,
  })
  const gate = new PermissionGate({
    browserApproval: () =>
      deps.store.browserSettings.get().agentBrowserApproval,
    get preset() {
      return input.resolvePermissions?.().permissionPreset ?? preset
    },
    hasWorkspace: workspaceRoot !== null,
    approvalOverride:
      input.approvalOverride ?? deps.approvals.approvalOverrideFor(sessionId),
    dangerActive: () => deps.danger.isActive(sessionId),
    executionMode: () =>
      deps.store.sessions.get(sessionId)?.executionMode ?? 'execute',
  })
  return { registry, gate, workspaceRoot }
}

/** 会话的工作区根：项目 folderPath；独立会话/空路径返回 null（工具被拒绝）。 */
export function resolveWorkspaceRoot(
  store: Store,
  session: Session,
): string | null {
  if (session.projectId === null) return null
  const project = store.projects.get(session.projectId)
  if (!project || project.folderPath === '') return null
  return project.folderPath
}
