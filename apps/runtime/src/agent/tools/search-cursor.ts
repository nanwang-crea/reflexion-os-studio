interface SearchCursor {
  version: 1
  tool: 'glob' | 'grep'
  fingerprint: string
  offset: number
}

export function encodeSearchCursor(
  tool: SearchCursor['tool'],
  fingerprint: string,
  offset: number,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      tool,
      fingerprint,
      offset,
    } satisfies SearchCursor),
  ).toString('base64url')
}

export function decodeSearchCursor(
  value: unknown,
  tool: SearchCursor['tool'],
  fingerprint: string,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 1000)
    throw new Error('invalid search cursor')
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as Partial<SearchCursor>
    if (
      parsed.version !== 1 ||
      parsed.tool !== tool ||
      parsed.fingerprint !== fingerprint ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset! < 0
    )
      throw new Error()
    return parsed.offset
  } catch {
    throw new Error('cursor does not match this search')
  }
}
