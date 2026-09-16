/**
 * 权限内核门面（PERMISSION-MODEL V2）：按职责分文件——
 * presets（三档矩阵 + ask-everything + Danger 旁路决策）、subjects（审批主题
 * 与 digest）、resource-rules / shell-rules（会话规则）、approval-gateway
 * （pending + choices + 规则）、danger-leases（高级 Danger 租约）、grants
 * （ApprovalGrantV2 签发）、summaries（脱敏展示）。业务代码只 import 本门面。
 */

export * from './types.js'
export {
  DEFAULT_PRESET,
  isToolOperation,
  legacyToPreset,
  requiresRustGrant,
  resolveInputPreset,
  PermissionGate,
  type DecisionMode,
  type PermissionGateOptions,
  type PermissionRequest,
} from './presets.js'
export {
  buildApprovalSubject,
  canonicalDigest,
  digestForGrant,
  normalizeRelativePath,
  shellDigest,
  InvalidWorkspacePathError,
  type ShellSubjectInput,
} from './subjects.js'
export {
  buildWorkspacePathRule,
  workspacePathRuleKey,
  WorkspacePathRuleStore,
} from './resource-rules.js'
export {
  buildShellPrefixRule,
  currentShellInterpreter,
  matchesShellPrefixRule,
  MIN_PREFIX_TOKENS,
  prepareShellExecution,
  shellDigestWithSandbox,
  ShellRuleStore,
  type ShellExecutionPrepared,
} from './shell-rules.js'
export {
  classifyShellCommand,
  resolvePrefixCandidate,
  type ShellClassification,
} from './shell-classifier.js'
export {
  extractEscalationTargets,
  MAX_ESCALATION_ROOTS,
  sensitiveRoots,
  touchesSensitive,
  type EscalationTargetOutcome,
} from './escalation.js'
export {
  ApprovalGateway,
  effectGrantScope,
  type ApprovalChoiceEffect,
  type ApprovalOutcome,
  type ApprovalRequestInput,
  type ApprovalScopeRule,
  type ChoiceSpec,
} from './approval-gateway.js'
export { buildApprovalChoices, buildNetworkChoices } from './choices.js'
export {
  DangerLeaseService,
  DANGER_LEASE_TTL_MS,
  DANGER_WARNING,
  type DangerPrepareResult,
} from './danger-leases.js'
export { buildGrantV2, type GrantInput } from './grants.js'
export {
  displayCommand,
  redactSecrets,
  summarizeArgs,
  truncateForDisplay,
} from './summaries.js'
