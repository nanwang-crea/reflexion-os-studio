import type {
  WorkflowJsonSchema,
  WorkflowJsonValue,
} from '@reflexion-os-studio/contracts'

/** Canonical key order for schema equality and immutable input fingerprints. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

/** Semantic constraints supplement the contracts' strict supported-key schema. */
export function jsonSchemaIssues(schema: WorkflowJsonSchema): string[] {
  const issues: string[] = []
  const visit = (item: WorkflowJsonSchema, path: string): void => {
    const allowed = new Set(['type', 'enum'])
    if (item.type === 'object') {
      for (const key of ['properties', 'required', 'additionalProperties'])
        allowed.add(key)
      const required = item.required ?? []
      if (new Set(required).size !== required.length)
        issues.push(`${path}: duplicate required property`)
      for (const key of required)
        if (!Object.hasOwn(item.properties ?? {}, key))
          issues.push(`${path}: required property missing: ${key}`)
      for (const [key, child] of Object.entries(item.properties ?? {}))
        visit(child, `${path}.${key}`)
    } else if (item.type === 'array') {
      for (const key of ['items', 'minItems', 'maxItems']) allowed.add(key)
      if (!item.items) issues.push(`${path}: array items required`)
      else visit(item.items, `${path}[]`)
    } else if (item.type === 'string') {
      allowed.add('minLength')
      allowed.add('maxLength')
    } else if (item.type === 'number' || item.type === 'integer') {
      allowed.add('minimum')
      allowed.add('maximum')
    }
    for (const key of Object.keys(item))
      if (!allowed.has(key))
        issues.push(`${path}: ${key} incompatible with ${item.type}`)
    for (const [min, max] of [
      [item.minimum, item.maximum],
      [item.minLength, item.maxLength],
      [item.minItems, item.maxItems],
    ])
      if (min !== undefined && max !== undefined && min > max)
        issues.push(`${path}: invalid range`)
    if (
      item.enum?.some(
        (value) => !matchesJsonSchema(value, { ...item, enum: undefined }),
      )
    )
      issues.push(`${path}: enum incompatible with schema`)
  }
  visit(schema, '$')
  return issues
}

export function matchesJsonSchema(
  value: WorkflowJsonValue,
  schema: WorkflowJsonSchema,
): boolean {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value)))
    return false
  switch (schema.type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      )
    case 'string': {
      if (typeof value !== 'string') return false
      const length = [...value].length
      return (
        (schema.minLength === undefined || length >= schema.minLength) &&
        (schema.maxLength === undefined || length <= schema.maxLength)
      )
    }
    case 'array':
      return (
        Array.isArray(value) &&
        schema.items !== undefined &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every((item) => matchesJsonSchema(item, schema.items!))
      )
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false
      const properties = schema.properties ?? {}
      if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key)))
        return false
      return Object.entries(value).every(([key, item]) =>
        Object.hasOwn(properties, key)
          ? matchesJsonSchema(item, properties[key])
          : schema.additionalProperties !== false,
      )
    }
  }
}
