import type { PermissionPreset } from '@reflexion-os-studio/contracts'
import { toolImageParts } from '../context/tool-images.js'
import type {
  ToolCallRequest,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { ToolExecutorInput } from './tool-executor-types.js'
import { capToolResultForModel, normalizeToolOutput } from './toolResults.js'
import { finalizeToolCall } from './run-state.js'
import { isMutatingTool } from '../delegation/mutations.js'

/** Invoke only after approval; persist effect marker before any external operation. */
export async function invokeAdmittedTool(
  input: ToolExecutorInput,
  request: ToolCallRequest,
  signal: AbortSignal,
  grant: string | undefined,
  rowId: string,
  projectId: string | null,
  admittedPreset: PermissionPreset = input.gate.preset,
): Promise<ToolResult> {
  const { store, state, emitter, run } = input
  const invoke = () => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (input.gate.preset !== admittedPreset)
      return Promise.resolve({
        content:
          '角色权限已变更，本次调用未执行；请根据当前权限重新发起并完成审批',
        isError: true,
        code: 'permission_changed',
      })
    input.beforeToolInvoke?.(request.name)
    const started = performance.now()
    return input.registry.call(request, signal, grant, rowId).finally(() => {
      const elapsed = performance.now() - started
      state.metrics?.add('toolExecutionMs', elapsed)
      if (request.name === 'shell.execute')
        state.metrics?.add('shellExecutionMs', elapsed)
    })
  }
  const result =
    input.mutationCoordinator && isMutatingTool(request.name)
      ? await input.mutationCoordinator.run(invoke, {
          keys: mutationKeys(input, request),
          signal,
          onWait: (ms) => state.metrics?.add('mutationWaitMs', ms),
        })
      : await invoke()
  state.toolCallRowIds.delete(rowId)
  const output = normalizeToolOutput(result, projectId, request.name)
  // 持久化保存完整结果（审计不做盲区），回填模型前只取截断副本。
  const modelResult: ToolResult = {
    ...result,
    content: capToolResultForModel(result.content),
  }
  delete modelResult.images
  const images = toolImageParts(
    store,
    run.sessionId,
    run.id,
    request.name,
    output,
  )
  if (images.length) modelResult.images = images
  if (result.isError) {
    const errorCode = result.code ?? 'tool_error'
    finalizeToolCall(store, state, emitter, rowId, 'failed', errorCode, output)
  } else {
    finalizeToolCall(store, state, emitter, rowId, 'completed', null, output)
    store.mutationReceipts.record({
      rootRunId: input.rootRunId,
      runId: run.id,
      delegationId: run.delegationId,
      agentInstanceId: run.agentId,
      toolCallId: rowId,
      toolName: request.name,
      output,
    })
  }
  return modelResult
}

function mutationKeys(
  input: ToolExecutorInput,
  request: ToolCallRequest,
): string[] {
  const validation = input.registry.validateRequest(request)
  if (!validation.ok || validation.tool.execution?.concurrentSafe !== true)
    return []
  try {
    return validation.tool.execution.resourceKeys?.(validation.args) ?? []
  } catch {
    return []
  }
}
