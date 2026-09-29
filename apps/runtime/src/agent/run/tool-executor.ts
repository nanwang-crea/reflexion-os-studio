import type { SystemRuntimeClient } from '../../system.js'
import {
  type ToolCallRequest,
  type ToolRegistry,
  type ToolResult,
} from '@reflexion-os-studio/agent-core'
import {
  JsonValueSchema,
  type ApprovalRisk,
  type ApprovalSubject,
  type JsonValue,
  type Run,
  type SandboxPolicy,
  type ToolCall,
} from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import type { Store } from '../../store/index.js'
import { capToolResultForModel, normalizeToolOutput } from './toolResults.js'
import {
  buildApprovalChoices,
  buildApprovalSubject,
  buildGrantV2,
  buildNetworkChoices,
  InvalidWorkspacePathError,
  isToolOperation,
  prepareShellExecution,
  preflightShellExecution,
  requiresRustGrant,
  currentShellInterpreter,
  shellDigestWithSandbox,
  summarizeArgs,
  type ApprovalGateway,
  type ApprovalOutcome,
  type ChoiceSpec,
  type ShellSubjectInput,
  type PermissionGate,
} from '../permissions/index.js'
import {
  finalizeToolCall,
  finalizeRejectedTool,
  type RunExecutionState,
} from './run-state.js'
import {
  argsRecord,
  buildApprovalContext,
  fileSandboxFor,
  riskFor,
  requestToolApproval,
} from './tool-execution-context.js'
import {
  isMutatingTool,
  type RootMutationCoordinator,
} from '../delegation/mutations.js'
import { agentContextForRun } from './agent-context.js'

export interface ToolExecutorInput {
  store: Store
  state: RunExecutionState
  run: Run
  gate: PermissionGate
  approvals: ApprovalGateway
  workspaceRoot: string | null
  registry: ToolRegistry
  emitter: RunEventEmitter
  /** Rust 沙箱 provider 标识（"none"/"seatbelt"/"bwrap"/"windows-token"）。 */
  system?: SystemRuntimeClient | null
  sandboxProvider: string | null
  permissionDomainId: string
  rootRunId: string
  mutationCoordinator?: RootMutationCoordinator
}

/**
 * 单次工具调用（统一编排，§12）：
 * parse args → build subject → evaluate permission（preset 矩阵 + 会话规则 +
 * Danger 旁路）→ request approval when needed（choice 驱动）→ issue exact
 * grant（ApprovalGrantV2，绑定实际请求）→ registry.call → finalize tool call。
 */
export async function executeToolCall(
  input: ToolExecutorInput,
  request: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { store, state, run, emitter } = input
  const projectId = store.sessions.get(run.sessionId)?.projectId ?? null
  const finalizeRejected = (result: ToolResult, args: JsonValue): ToolResult =>
    finalizeRejectedTool(input, request, result, args, projectId)
  // Tool schema is the single admission boundary. Invalid input is rejected before
  // subject construction or approval, so UI/audit/execution all see one meaning.
  const validation = input.registry.validateRequest(request)
  if (!validation.ok) {
    return finalizeRejected(validation.result, {})
  }
  const args = validation.args
  const record = argsRecord(args)
  const dangerActive = input.gate.dangerActive

  // ---- Shell 执行维度先于 subject：分类、提权根与 digest 由权限内核准备。----
  const prepared =
    request.name === 'shell.execute'
      ? await preflightShellExecution(
          prepareShellExecution({
            args,
            record,
            preset: input.gate.preset,
            dangerActive,
          }),
          input.system,
          input.workspaceRoot,
          signal,
        )
      : undefined
  if (prepared !== undefined && !prepared.ok) {
    return finalizeRejected(
      {
        content: prepared.content,
        isError: true,
        code: prepared.code,
      },
      args,
    )
  }
  const escalation = prepared?.escalation ?? false
  const networkRequested = prepared?.networkRequested ?? false
  const shellInput: ShellSubjectInput | undefined = prepared?.shellInput
  const shellTokens: string[] = prepared?.tokens ?? []
  const escalationRoots: string[] = prepared?.escalationRoots ?? []
  const shellSandbox: SandboxPolicy = shellInput?.sandbox ?? 'workspace-write'

  // ---- subject 构造（非法资源路径审批前拒绝）。----
  let built: { subject: ApprovalSubject; digest: string }
  try {
    built = buildApprovalSubject(request.name, args, shellInput)
  } catch (error) {
    if (error instanceof InvalidWorkspacePathError) {
      return finalizeRejected(
        {
          content: `工具参数被拒绝：${error.message}。file.* 只接受工作区相对路径。`,
          isError: true,
          code: 'invalid_request',
        },
        args,
      )
    }
    throw error
  }

  const sandbox: SandboxPolicy = shellInput
    ? shellSandbox
    : fileSandboxFor(request.name)

  const decision = input.gate.decisionFor({
    toolName: request.name,
    subject: built.subject,
    escalation,
  })

  // 预创建 ToolCall 行消费（无预建行时按需创建）。
  const precreatedId = state.precreatedToolCallRows.get(request.id)
  const ensureRow = (status: 'running' | 'awaiting_approval'): ToolCall => {
    if (precreatedId !== undefined) {
      store.toolCalls.markStatus(precreatedId, status)
      const row = store.toolCalls.get(precreatedId)
      if (row !== null) return row
    }
    return store.toolCalls.create({
      runId: run.id,
      messageId: state.lastAssistantMessageId,
      toolName: request.name,
      args,
      status,
    })
  }

  const denyResult = (rowId: string, message: string): ToolResult => {
    const result: ToolResult = {
      content: message,
      isError: true,
      code: 'permission_denied',
    }
    finalizeToolCall(
      store,
      state,
      emitter,
      rowId,
      'failed',
      'permission_denied',
      normalizeToolOutput(result, projectId, request.name),
    )
    return result
  }

  // ---- 策略拒绝：落一条失败的调用记录，让模型知道原因而不是静默失败。----
  if (decision === 'denied') {
    const deniedRow =
      precreatedId !== undefined
        ? (store.toolCalls.get(precreatedId) ??
          store.toolCalls.create({
            runId: run.id,
            messageId: state.lastAssistantMessageId,
            toolName: request.name,
            args,
            status: 'pending',
          }))
        : store.toolCalls.create({
            runId: run.id,
            messageId: state.lastAssistantMessageId,
            toolName: request.name,
            args,
            status: 'pending',
          })
    emitter.next({
      type: 'tool.requested',
      toolCallId: deniedRow.id,
      toolName: request.name,
      args,
    })
    return denyResult(
      deniedRow.id,
      `权限策略拒绝了 ${request.name}（当前档位不允许该操作；工作区外访问需要显式提权审批）`,
    )
  }

  // ---- 会话规则免问：只决定"是否免问"，grant 仍按当前请求重新签发。----
  const scope = {
    sessionId: input.permissionDomainId,
    workspaceRoot: input.workspaceRoot,
  }
  let sessionRuleHit = false
  if (decision === 'ask' && !dangerActive) {
    if (shellInput && built.subject.kind === 'shell-command') {
      sessionRuleHit =
        input.approvals.matchShellPrefixRule(scope, {
          interpreter: shellInput.interpreter,
          cwd: shellInput.cwd,
          // 分类 token 与实际命令同源；不可解析命令 tokens 为空 → 必然不命中。
          tokens: shellTokens,
          sandbox: shellSandbox === 'danger' ? 'workspace-write' : shellSandbox,
          network: shellInput.network,
        }) !== null
    } else if (built.subject.kind === 'workspace-path') {
      sessionRuleHit = input.approvals.hasWorkspacePathRule(
        scope,
        built.subject.operation,
        built.subject.path,
      )
    } else if (!isToolOperation(request.name)) {
      sessionRuleHit = input.approvals.hasSessionOperationGrant(
        request.name,
        scope,
      )
    }
  }
  let askNeeded = decision === 'ask' && !sessionRuleHit && !dangerActive

  const row = ensureRow(askNeeded ? 'awaiting_approval' : 'running')
  if (precreatedId === undefined) {
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: request.name,
      args,
    })
  }
  state.toolCallRowIds.add(row.id)

  const context = buildApprovalContext({
    workspaceRoot: input.workspaceRoot,
    sandbox,
    sandboxProvider: prepared?.sandboxProvider ?? input.sandboxProvider,
    network: networkRequested,
    escalation,
    justification:
      typeof record.justification === 'string'
        ? record.justification
        : undefined,
    agent: agentContextForRun(store, run, input.rootRunId),
  })

  const requestApprovalWith = (
    toolCallId: string,
    operation: string,
    summary: string,
    subject: ApprovalSubject,
    risk: ApprovalRisk,
    choices: ChoiceSpec[],
  ): Promise<ApprovalOutcome> =>
    requestToolApproval(input, {
      toolCallId,
      emitter,
      operation,
      summary,
      subject,
      risk,
      context,
      choices,
      signal,
      scope,
    })

  const requestApproval = (
    toolCallId: string,
    operation: string,
    summary: string,
    subject: ApprovalSubject,
    risk: ApprovalRisk,
  ): Promise<ApprovalOutcome> =>
    requestApprovalWith(
      toolCallId,
      operation,
      summary,
      subject,
      risk,
      buildApprovalChoices({
        toolName: operation,
        subject,
        sandbox,
        network: networkRequested,
        escalation,
        scope,
        shell:
          shellInput && operation === 'shell.execute'
            ? {
                cwd: shellInput.cwd,
                interpreter: shellInput.interpreter,
                prefix: shellInput.prefixCandidate ?? [],
              }
            : undefined,
      }),
    )

  // ---- 网络审批独立链路（W6 收敛）：once 批准只进当前精确 grant；会话复用
  // 只命中"同一命令前缀 + network=true"规则；无可靠前缀的复合命令给不出
  // 会话网络授权（批准 git fetch 不能放行无关 curl）。----
  let sandboxNetwork = false
  if (networkRequested) {
    if (dangerActive) {
      // Danger lease 自动放行网络，grant 仍显式记录 sandboxNetwork=true。
      sandboxNetwork = true
    } else if (
      shellInput &&
      input.approvals.matchShellPrefixRule(scope, {
        interpreter: shellInput.interpreter,
        cwd: shellInput.cwd,
        tokens: shellTokens,
        sandbox: shellSandbox === 'danger' ? 'workspace-write' : shellSandbox,
        network: true,
      }) !== null
    ) {
      sandboxNetwork = true
    } else {
      const outcome = await requestApprovalWith(
        `${row.id}:network`,
        'sandbox_network',
        summarizeArgs(request.name, args),
        built.subject,
        'elevated',
        buildNetworkChoices({
          scope,
          sandbox,
          cwd: shellInput?.cwd ?? '.',
          interpreter: shellInput?.interpreter ?? currentShellInterpreter(),
          prefixCandidate:
            shellInput && !escalation ? shellInput.prefixCandidate : null,
          displayCommand: shellInput?.displayCommand ?? '',
        }),
      )
      if (outcome.decision === 'denied') {
        return denyResult(row.id, '用户拒绝了本次命令联网请求')
      }
      sandboxNetwork = true
      // 网络卡若选择"本会话允许该前缀联网"，规则已覆盖命令审批本身：
      // 复查命中则免掉主卡（会话网络授权语义 = 前缀 + 网络 + 维度全等）。
      if (shellInput && !sessionRuleHit) {
        sessionRuleHit =
          input.approvals.matchShellPrefixRule(scope, {
            interpreter: shellInput.interpreter,
            cwd: shellInput.cwd,
            tokens: shellTokens,
            sandbox:
              shellSandbox === 'danger' ? 'workspace-write' : shellSandbox,
            network: true,
          }) !== null
        if (sessionRuleHit) askNeeded = false
      }
    }
  }

  // ---- 审批（ask 且未命中会话规则）→ choice 驱动。----
  let grantSource: 'once' | 'session-rule' | 'preset' | 'danger-lease' =
    dangerActive ? 'danger-lease' : 'preset'
  // 最终生效档位/摘要：审批 choice 可能显式扩写（once sandboxOverride），
  // grant 的 digest 必须按**最终**字段重算（Rust 用 grant.sandbox 复核）。
  let effectiveSandbox = sandbox
  let effectiveDigest = built.digest
  if (askNeeded) {
    const outcome = await requestApproval(
      row.id,
      request.name,
      summarizeArgs(request.name, args),
      built.subject,
      riskFor(built.subject, escalation, networkRequested, request.name),
    )
    if (outcome.decision === 'denied') {
      return denyResult(row.id, `用户拒绝了本次 ${request.name} 操作`)
    }
    grantSource = outcome.grantScope === 'session' ? 'session-rule' : 'once'
    if (
      outcome.effect.kind === 'once' &&
      outcome.effect.sandboxOverride === 'workspace-write' &&
      effectiveSandbox === 'read-only'
    ) {
      effectiveSandbox = 'workspace-write'
      if (shellInput) {
        effectiveDigest = shellDigestWithSandbox(shellInput, effectiveSandbox)
      }
    }
  } else if (sessionRuleHit) {
    grantSource = 'session-rule'
  }

  // ---- 精确调用 grant：ask 通过或 Rust 约束项都签发绑定当前请求的 V2 凭据。----
  let grant: string | undefined
  if (askNeeded || requiresRustGrant(request.name)) {
    grant = buildGrantV2({
      grantId: `${grantSource}:${row.id}`,
      requestId: row.id,
      sessionId: run.sessionId,
      workspaceRoot: input.workspaceRoot,
      operation: request.name,
      source: grantSource,
      subjectDigest: effectiveDigest,
      sandbox: effectiveSandbox,
      escalationRoots: escalation ? escalationRoots : undefined,
      sandboxNetwork,
    })
    store.toolCalls.markStatus(row.id, 'running', grant)
  }

  const invoke = () => input.registry.call(request, signal, grant, row.id)
  const result =
    input.mutationCoordinator && isMutatingTool(request.name)
      ? await input.mutationCoordinator.run(invoke)
      : await invoke()
  state.toolCallRowIds.delete(row.id)
  const output = normalizeToolOutput(result, projectId, request.name)
  // 持久化保存完整结果（审计不做盲区），回填模型前只取截断副本。
  const modelResult: ToolResult = {
    ...result,
    content: capToolResultForModel(result.content),
  }
  if (result.isError) {
    const errorCode = result.code ?? 'tool_error'
    finalizeToolCall(store, state, emitter, row.id, 'failed', errorCode, output)
  } else {
    finalizeToolCall(store, state, emitter, row.id, 'completed', null, output)
    store.mutationReceipts.record({
      rootRunId: input.rootRunId,
      runId: run.id,
      delegationId: run.delegationId,
      agentInstanceId: run.agentId,
      toolCallId: row.id,
      toolName: request.name,
      output,
    })
  }
  return modelResult
}

export function parseToolArgs(arguments_: string): JsonValue {
  try {
    const parsed: unknown =
      arguments_.trim() === '' ? {} : JSON.parse(arguments_)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}
