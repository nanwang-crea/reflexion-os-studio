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
    const { sessionId } = principal
    if (!this.store.sessions.get(sessionId)) return this.deny()
    if (
      method === 'session.get' &&
      this.sessionBelongs(String(params.sessionId), sessionId)
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
    if (
      method === 'delegation.tree' &&
      this.runBelongs(String(params.rootRunId), sessionId)
    )
      return
    if (method === 'delegation.cancel') {
      const delegation = this.store.delegations.get(String(params.delegationId))
      if (delegation && this.runBelongs(delegation.parentRunId, sessionId))
        return
      return this.deny()
    }
    if (sessionMethods.has(method)) {
      if (params.sessionId !== sessionId) return this.deny()
      if (
        params.messageId &&
        this.store.messages.get(String(params.messageId))?.sessionId !==
          sessionId
      )
        return this.deny()
      for (const id of [
        ...((params.attachmentAssetIds ?? []) as string[]),
        ...((params.imageAssetIds ?? []) as string[]),
      ])
        this.requireAsset(id, sessionId)
      return
    }
    if (method === 'runtime.get_status' || method === 'remote.catalog') return
    if (
      (method === 'skill.list' || method === 'agent_template.list') &&
      (params.projectId ?? null) ===
        this.store.sessions.get(sessionId)?.projectId
    )
      return
    if (method === 'run.cancel' || method === 'run.retry') {
      if (!this.runBelongs(String(params.runId), sessionId)) return this.deny()
      return
    }
    if (method === 'approval.resolve') {
      const call = this.store.toolCalls.get(String(params.toolCallId))
      if (!call || !this.runBelongs(call.runId, sessionId)) return this.deny()
      return
    }
    if (method === 'interaction.respond') {
      const interaction = this.store.interactions.get(
        String(params.interactionId),
      )
      if (!interaction || !this.runBelongs(interaction.runId, sessionId))
        return this.deny()
      return
    }
    if (method === 'asset.read' || method === 'asset.delete') {
      this.requireAsset(String(params.assetId), sessionId)
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
  private sessionBelongs(candidate: string, root: string): boolean {
    if (candidate === root) return true
    return this.store.runs
      .listBySession(candidate)
      .some((run) => this.runBelongs(run.id, root))
  }
  private requireAsset(id: string, sessionId: string): void {
    const asset = this.store.assetStore.get(id)
    if (
      !asset ||
      !(
        asset.sessionId === sessionId ||
        (asset.runId && this.runBelongs(asset.runId, sessionId))
      )
    )
      this.deny()
  }
  private deny(): never {
    throw new CommandError('forbidden', '设备无权访问该资源或命令')
  }
}
