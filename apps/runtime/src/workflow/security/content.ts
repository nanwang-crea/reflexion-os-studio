import type {
  WorkflowDefinition,
  WorkflowValues,
} from '@reflexion-os-studio/contracts'

// Known credential shapes only: arbitrary hashes and source identifiers are not credentials.
const CREDENTIAL_SHAPES = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{24,}\b/i,
]
function assertText(text: string): void {
  if (CREDENTIAL_SHAPES.some((pattern) => pattern.test(text)))
    throw new Error('workflow_sensitive_content')
}
export function assertWorkflowValuesSafe(values: WorkflowValues): void {
  assertText(JSON.stringify(values))
}
export function assertWorkflowDefinitionSafe(
  definition: WorkflowDefinition,
): void {
  assertText(JSON.stringify(definition))
}
