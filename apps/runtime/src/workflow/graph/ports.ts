import {
  WorkflowValueSchema,
  type WorkflowPort,
  type WorkflowValue,
  type WorkflowValues,
  type WorkflowValidationIssue,
} from '@reflexion-os-studio/contracts'
import { canonicalJson, matchesJsonSchema } from './json-schema.js'

export function compatiblePorts(from: WorkflowPort, to: WorkflowPort): boolean {
  if (from.type !== to.type) return false
  if (from.type === 'json' && to.type === 'json')
    return canonicalJson(from.schema) === canonicalJson(to.schema)
  if (from.type === 'resource' && to.type === 'resource')
    return from.resourceKind === to.resourceKind
  return true
}

/** This checks the value shape only; resource access/revision needs Runtime preflight. */
export function matchesPort(value: WorkflowValue, port: WorkflowPort): boolean {
  if (value.type !== port.type) return false
  if (port.type === 'json' && value.type === 'json')
    return matchesJsonSchema(value.value, port.schema)
  if (port.type === 'resource' && value.type === 'resource')
    return value.value.kind === port.resourceKind
  return true
}

export function validatePortValues(
  ports: readonly WorkflowPort[],
  values: WorkflowValues,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  for (const key of Object.keys(values))
    if (!ports.some((port) => port.key === key))
      issues.push({
        code: 'unknown_output',
        path: key,
        message: 'Unknown port',
      })
  for (const port of ports) {
    if (!Object.hasOwn(values, port.key)) {
      if (port.required)
        issues.push({
          code: 'missing_value',
          path: port.key,
          message: 'Required value missing',
        })
      continue
    }
    const parsed = WorkflowValueSchema.safeParse(values[port.key])
    if (!parsed.success || !matchesPort(parsed.data, port))
      issues.push({
        code: 'invalid_value',
        path: port.key,
        message: 'Value does not match port',
      })
  }
  return issues
}
