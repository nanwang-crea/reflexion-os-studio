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
): Promise<ToolResult> {
  const { store, state, emitter, run } = input
  const invoke = () => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    input.beforeToolInvoke?.(request.name)
    return input.registry.call(request, signal, grant, rowId)
  }
  const result =
    input.mutationCoordinator &&
    (isMutatingTool(request.name) ||
      (input.workflowRunId !== undefined && request.name.includes('/')))
      ? await input.mutationCoordinator.run(invoke)
      : await invoke()
  state.toolCallRowIds.delete(rowId)
  const output = normalizeToolOutput(result, projectId, request.name)
  // 持久化保存完整结果（审计不做盲区），回填模型前只取截断副本。
  const modelResult: ToolResult = {
    ...result,
    content: capToolResultForModel(result.content),
  }
  if (result.isError) {
    const errorCode = result.code ?? 'tool_error'
    finalizeToolCall(store, state, emitter, rowId, 'failed', errorCode, output)
  } else {
    finalizeToolCall(store, state, emitter, rowId, 'completed', null, output)
    const receipt = store.mutationReceipts.record({
      rootRunId: input.rootRunId,
      workflowRunId: input.workflowRunId,
      runId: run.id,
      delegationId: run.delegationId,
      agentInstanceId: run.agentId,
      toolCallId: rowId,
      toolName: request.name,
      output,
    })
    if (receipt && input.workflowRunId) {
      const attempt = store.workflowAttempts.byAgentRun(run.id)
      if (attempt?.status === 'running')
        store.workflowAttempts.update({ ...attempt, effectStatus: 'recorded' })
    }
  }
  return modelResult
}
