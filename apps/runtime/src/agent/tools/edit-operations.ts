export function parseEditOperation(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('each edit must be an object')
  }
  const input = value as Record<string, unknown>
  const kind = input.kind
  if (typeof kind !== 'string') throw new Error('edit.kind is required')
  const text = (key: string, allowEmpty = true): string => {
    const result = input[key]
    if (typeof result !== 'string' || (!allowEmpty && result.length === 0)) {
      throw new Error(`invalid ${kind}.${key}`)
    }
    return result
  }
  const rawCount = input.expectedCount
  const expectedCount =
    typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.max(1, Math.trunc(rawCount))
      : undefined
  if (kind === 'replace') {
    return {
      kind,
      oldText: text('oldText', false),
      newText: text('newText'),
      ...(expectedCount === undefined ? {} : { expectedCount }),
    }
  }
  if (kind === 'insert_before' || kind === 'insert_after') {
    return {
      kind,
      anchor: text('anchor', false),
      content: text('content'),
      ...(expectedCount === undefined ? {} : { expectedCount }),
    }
  }
  if (kind === 'replace_range') {
    const startLine = input.startLine
    const endLine = input.endLine
    if (
      typeof startLine !== 'number' ||
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      typeof endLine !== 'number' ||
      !Number.isInteger(endLine) ||
      endLine < startLine
    ) {
      throw new Error('replace_range requires 1-based startLine <= endLine')
    }
    return {
      kind,
      startLine,
      endLine,
      expectedText: text('expectedText'),
      newText: text('newText'),
    }
  }
  throw new Error(`unsupported edit kind: ${kind}`)
}
