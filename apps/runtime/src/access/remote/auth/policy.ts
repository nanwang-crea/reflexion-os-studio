import type { RuntimeEvent } from '@reflexion-os-studio/contracts'
import type { Store } from '../../../store/index.js'
import { CommandError } from '../../../agent/errors.js'
import type { RequestPrincipal } from '../../requests/gateway.js'

const sessionMethods = new Set([
  'session.get',
  'session.execution_mode.set',
  'message.send',
  'message.edit_resend',
  'danger.disable',
  'queue.list',
  'queue.update',
  'queue.remove',
  'queue.send_now',
  'queue.resume',
  'queue.pause',
  'asset.upload_image',
  'asset.upload_document',
  'delegation.list',
])
export class RemoteAccessPolicy {
  constructor(private readonly store: Store) {}
  runBelongs(runId: string, sessionId: string): boolean {
    let current: string | null = runId
    for (let depth = 0; current && depth < 8; depth++) {
      const run = this.store.runs.get(current)
      if (!run) return false
      if (run.sessionId === sessionId) return true
      current = run.parentRunId
    }
    return false
  }
  readonly authorize = (
    principal: RequestPrincipal,
    method: string,
    params: Record<string, unknown>,
  ): void => {
    if (principal.kind === 'desktop') return
    if (principal.accessScope !== 'all_sessions') return this.deny()
    this.authorizeAllSessions(method, params)
  }
  private authorizeAllSessions(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === 'session.list') return
    if (method === 'session.create') {
      const projectId = params.projectId
      if (
        projectId === undefined ||
        projectId === null ||
        (typeof projectId === 'string' && this.store.projects.get(projectId))
      )
        return
      return this.deny()
    }
    if (method === 'workspace.list_dir' || method === 'workspace.read_file') {
      const projectId = params.projectId
      if (
        typeof projectId === 'string' &&
        this.store.projects.get(projectId)?.folderPath
      )
        return
      return this.deny()
    }
    if (
      method === 'session.get' &&
      this.store.sessions.get(String(params.sessionId))
    )
      return
    if (
      method === 'operation.get' &&
      ['message.send', 'message.edit_resend', 'run.retry'].includes(
        String(params.method),
      ) &&
      typeof params.targetRequestId === 'string' &&
      params.targetRequestId.length <= 256
    )
      return
    if (method === 'delegation.tree') {
      const run = this.store.runs.get(String(params.rootRunId))
      if (run) return
    }
    if (method === 'delegation.cancel') {
      if (this.store.delegations.get(String(params.delegationId))) return
    }
    if (sessionMethods.has(method)) {
      const target = String(params.sessionId ?? '')
      if (!this.store.sessions.get(target)) return this.deny()
      if (
        params.messageId &&
        this.store.messages.get(String(params.messageId))?.sessionId !== target
      )
        return this.deny()
      for (const id of [
        ...((params.attachmentAssetIds ?? []) as string[]),
        ...((params.imageAssetIds ?? []) as string[]),
      ])
        this.requireAsset(id)
      return
    }
    if (method === 'runtime.get_status' || method === 'remote.catalog') return
    if (method === 'skill.list' || method === 'agent_template.list') return
    if (method === 'run.cancel' || method === 'run.retry') {
      if (this.store.runs.get(String(params.runId))) return
      return this.deny()
    }
    if (method === 'approval.resolve') {
      const call = this.store.toolCalls.get(String(params.toolCallId))
      if (call && this.store.runs.get(call.runId)) return
      return this.deny()
    }
    if (method === 'interaction.respond') {
      const interaction = this.store.interactions.get(
        String(params.interactionId),
      )
      if (interaction && this.store.runs.get(interaction.runId)) return
      return this.deny()
    }
    if (method === 'asset.read' || method === 'asset.delete') {
      this.requireAsset(String(params.assetId))
      return
    }
    this.deny()
  }
  eventBelongs(event: RuntimeEvent, sessionId: string): boolean {
    // No runtime/global/provider/configuration events are broadcast remotely.
    if (event.scope === 'session') return event.sessionId === sessionId
    if (event.scope === 'run') return this.runBelongs(event.runId, sessionId)
    return false
  }
  private requireAsset(id: string): void {
    const asset = this.store.assetStore.get(id)
    if (
      !asset ||
      !(
        (asset.sessionId && this.store.sessions.get(asset.sessionId)) ||
        (asset.runId && this.store.runs.get(asset.runId)) ||
        this.store.messages.referencesAsset(id)
      )
    )
      this.deny()
  }
  private deny(): never {
    throw new CommandError('forbidden', '设备无权访问该资源或命令')
  }
}
