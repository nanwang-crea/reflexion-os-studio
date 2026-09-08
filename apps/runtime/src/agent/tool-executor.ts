import {
  type ToolCallRequest,
  type ToolRegistry,
  type ToolResult,
} from '@reflexion-os-studio/agent-core'
import {
  JsonValueSchema,
  type JsonValue,
  type Run,
} from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../events.js'
import type { Store } from '../store/index.js'
import { capToolResultForModel, parseToolResultPayload } from './toolResults.js'
import {
  buildOnceGrant,
  buildSessionGrant,
  requiresRustGrant,
  summarizeArgs,
  type ApprovalGateway,
  type PermissionGate,
} from './permissions.js'
import { finalizeToolCall, type RunExecutionState } from './run-state.js'

export interface ToolExecutorInput {
  store: Store
  state: RunExecutionState
  run: Run
  gate: PermissionGate
  approvals: ApprovalGateway
  workspaceRoot: string | null
  registry: ToolRegistry
  emitter: RunEventEmitter
}

/**
 * 单次工具调用：权限决策 → 调用行落库 → 审批流程（ask）→ 授权凭据签发 →
 * 注册表执行 → 结果截断回填与终态持久化。
 */
export async function executeToolCall(
  input: ToolExecutorInput,
  request: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { store, state, run, emitter } = input
  const args = parseToolArgs(request.arguments)
  const decision = input.gate.decisionFor(request.name)

  // 策略拒绝：落一条失败的调用记录，让模型知道原因而不是静默失败。
  if (decision === 'denied') {
    const row = store.toolCalls.create({
      runId: run.id,
      messageId: state.lastAssistantMessageId,
      toolName: request.name,
      args,
      status: 'failed',
    })
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: request.name,
      args,
    })
    finalizeToolCall(
      store,
      state,
      emitter,
      row.id,
      'failed',
      'permission_denied',
    )
    return {
      content: `权限策略拒绝了 ${request.name}（当前 Profile 不允许该操作）`,
      isError: true,
      code: 'permission_denied',
    }
  }

  // 会话级授权同时覆盖内置操作与动态工具名（MCP 的 serverId/toolName），
  // 因此在 ask 判定处不再按 isToolOperation 过滤，统一走 hasSessionGrant。
  const askNeeded =
    decision === 'ask' &&
    !input.approvals.hasSessionGrant(request.name, {
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
    })
  const row = store.toolCalls.create({
    runId: run.id,
    messageId: state.lastAssistantMessageId,
    toolName: request.name,
    args,
    status: askNeeded ? 'awaiting_approval' : 'running',
  })
  state.toolCallRowIds.add(row.id)
  emitter.next({
    type: 'tool.requested',
    toolCallId: row.id,
    toolName: request.name,
    args,
  })

  // 授权引用：ask 批准后以本次调用为 once 凭据；会话级授权用稳定引用。
  let grant: string | undefined
  if (askNeeded) {
    store.runs.setIntermediateStatus(run.id, 'awaiting_approval')
    let verdict: 'approved' | 'denied'
    try {
      verdict = await input.approvals.request({
        toolCallId: row.id,
        emitter,
        operation: request.name,
        summary: summarizeArgs(request.name, args),
        signal,
        context: {
          sessionId: run.sessionId,
          workspaceRoot: input.workspaceRoot,
        },
      })
    } finally {
      // 并行工具轮次:还有其它调用在等审批时保持 awaiting_approval,
      // 否则才回置 running,避免 Run 状态错报。
      if (!input.approvals.hasPendingRun(run.id)) {
        store.runs.setIntermediateStatus(run.id, 'running')
      }
    }
    if (verdict === 'denied') {
      finalizeToolCall(
        store,
        state,
        emitter,
        row.id,
        'failed',
        'permission_denied',
      )
      return {
        content: `用户拒绝了本次 ${request.name} 操作`,
        isError: true,
        code: 'permission_denied',
      }
    }
    grant = buildOnceGrant({
      grantId: row.id,
      requestId: row.id,
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
      operation: request.name,
    })
    store.toolCalls.markStatus(row.id, 'running', row.id)
  } else if (decision === 'ask') {
    grant = buildSessionGrant({
      grantId: `session:${request.name}`,
      requestId: row.id,
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
      operation: request.name,
    })
    store.toolCalls.markStatus(row.id, 'running', grant)
  } else if (requiresRustGrant(request.name)) {
    // 信任开关放行的写/Shell：决策走 automatic、不经审批，但 Rust 侧
    // require_grant 仍要求非空凭据。签发会话级稳定引用凭据（复用
    // buildSessionGrant 的校验语义），grantId 前缀区分审计来源。
    grant = buildSessionGrant({
      grantId: `trusted:${request.name}`,
      requestId: row.id,
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
      operation: request.name,
    })
    store.toolCalls.markStatus(row.id, 'running', grant)
  }

  const result = await input.registry.call(request, signal, grant)
  state.toolCallRowIds.delete(row.id)
  // 持久化保存完整结果（审计不做盲区），回填模型前只取截断副本。
  const modelResult: ToolResult = {
    ...result,
    content: capToolResultForModel(result.content),
  }
  if (result.isError) {
    const errorCode = result.code ?? 'tool_error'
    finalizeToolCall(store, state, emitter, row.id, 'failed', errorCode)
  } else {
    finalizeToolCall(
      store,
      state,
      emitter,
      row.id,
      'completed',
      null,
      parseToolResultPayload(result.content),
    )
  }
  return modelResult
}

function parseToolArgs(arguments_: string): JsonValue {
  try {
    const parsed: unknown =
      arguments_.trim() === '' ? {} : JSON.parse(arguments_)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}
