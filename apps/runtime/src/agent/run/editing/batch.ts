import { randomUUID } from 'node:crypto'
import {
  FileEditBatchInputSchema,
  FileEditBatchResultSchema,
  type FileEditBatchResult,
} from '@reflexion-os-studio/contracts'
import type {
  ToolCallRequest,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import { buildApprovalSubject } from '../../permissions/index.js'
import { fileResourceKeys } from '../../delegation/resource-locks.js'
import { finalizeRejectedTool, finalizeToolCall } from '../run-state.js'
import { normalizeToolOutput, capToolResultForModel } from '../toolResults.js'
import { executeToolCall } from '../tool-executor.js'
import type { ToolExecutorInput } from '../tool-executor-types.js'
import { executeToolBatch, type SchedulerDeps } from '../tool-scheduler.js'

/** Charge the parent orchestration plus every concrete edit before executing anything. */
export function toolCallCost(request: ToolCallRequest): number {
  if (request.name !== 'file.edit_batch') return 1
  try {
    const parsed = FileEditBatchInputSchema.safeParse(
      JSON.parse(request.arguments),
    )
    return parsed.success ? 1 + parsed.data.files.length : 1
  } catch {
    return 1
  }
}

export async function executeFileEditBatch(
  input: ToolExecutorInput,
  scheduler: Pick<SchedulerDeps, 'guard'>,
  request: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { store, state, run, emitter } = input
  const projectId = store.sessions.get(run.sessionId)?.projectId ?? null
  const validation = input.registry.validateRequest(request)
  const reject = (content: string) =>
    finalizeRejectedTool(
      input,
      request,
      { content, isError: true, code: 'invalid_request' },
      {},
      projectId,
    )
  if (!validation.ok)
    return finalizeRejectedTool(
      input,
      request,
      validation.result,
      {},
      projectId,
    )
  const parsed = FileEditBatchInputSchema.safeParse(validation.args)
  if (!parsed.success) return reject('多文件编辑参数无效，尚未写入任何文件')
  const seen = new Set<string>()
  const calls: ToolCallRequest[] = []
  // Reject invalid or duplicate paths and disallowed child tools before any edits.
  for (const file of parsed.data.files) {
    const keys = fileResourceKeys(file)
    if (!keys.length || seen.has(keys[0]))
      return reject(
        '多文件编辑要求不同的工作区相对路径；同文件修改请合并为一个 edits，尚未写入任何文件',
      )
    seen.add(keys[0])
    const call = {
      id: randomUUID(),
      name: 'file.edit',
      arguments: JSON.stringify(file),
    }
    const child = input.registry.validateRequest(call)
    if (!child.ok)
      return finalizeRejectedTool(
        input,
        request,
        child.result,
        validation.args,
        projectId,
      )
    try {
      buildApprovalSubject(call.name, child.args)
    } catch {
      return reject('多文件编辑包含无效路径，尚未写入任何文件')
    }
    calls.push(call)
  }
  let parentId = state.precreatedToolCallRows.get(request.id)
  if (!parentId) {
    const row = store.toolCalls.create({
      runId: run.id,
      messageId: state.lastAssistantMessageId,
      toolName: request.name,
      args: validation.args,
    })
    parentId = row.id
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: request.name,
      args: validation.args,
    })
  }
  store.toolCalls.markStatus(parentId, 'running')
  state.toolCallRowIds.add(parentId)
  // Child rows remain in audit/UI but are not fabricated model declarations in history.
  const childState = {
    ...state,
    lastAssistantMessageId: null,
    precreatedToolCallRows: new Map<string, string>(),
  }
  for (let index = 0; index < calls.length; index++) {
    const row = store.toolCalls.create({
      runId: run.id,
      messageId: null,
      toolName: 'file.edit',
      args: parsed.data.files[index],
    })
    childState.precreatedToolCallRows.set(calls[index].id, row.id)
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: 'file.edit',
      args: row.args,
    })
  }
  const rowIds = calls.map((call) =>
    childState.precreatedToolCallRows.get(call.id)!,
  )
  const buildData = () =>
    FileEditBatchResultSchema.parse({
      atomicAcrossFiles: false,
      results: rowIds.map((id, index) => {
        const row = store.toolCalls.get(id)!
        const terminal = ['completed', 'failed', 'cancelled'].includes(
          row.status,
        )
        return {
          path: parsed.data.files[index].path,
          toolCallId: id,
          status: terminal ? row.status : 'not_executed',
          output: row.output,
        }
      }),
    })
  const checkpoint = () => {
    const data = buildData()
    store.toolCalls.recordProgressOutput(
      parentId,
      normalizeToolOutput(
        { content: batchSummary(data), data, isError: false },
        projectId,
        request.name,
      ),
    )
  }
  checkpoint()
  let failure: unknown
  try {
    await executeToolBatch(
      {
        ...input,
        ...scheduler,
        state: childState,
        executeOne: (call, childSignal) =>
          executeToolCall(
            { ...input, state: childState },
            call,
            childSignal,
          ).finally(checkpoint),
      },
      calls,
      signal,
    )
  } catch (error) {
    failure = error
  }
  const data = buildData()
  const result: ToolResult = {
    content: batchSummary(data),
    data,
    isError: data.results.some((entry) => entry.status !== 'completed'),
    replayUnsafe: data.results.some((entry) => entry.status === 'completed'),
  }
  finalizeToolCall(
    store,
    state,
    emitter,
    parentId,
    signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed',
    result.isError ? 'batch_partial_failure' : null,
    normalizeToolOutput(result, projectId, request.name),
  )
  if (failure) throw failure
  return { ...result, content: capToolResultForModel(result.content) }
}

/** Keep full canonical children on disk/UI; send only outcomes and bounded recovery hints. */
function batchSummary(data: FileEditBatchResult): string {
  return JSON.stringify({
    atomicAcrossFiles: false,
    results: data.results.map((entry) => ({
      path: entry.path,
      toolCallId: entry.toolCallId,
      status: entry.status,
      summary:
        entry.status === 'completed'
          ? '编辑已完成，不要重放'
          : (entry.output?.content.slice(0, 4000) ?? '未执行修改'),
    })),
  })
}
