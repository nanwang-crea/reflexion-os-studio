export const ESTIMATED_HEIGHT = 180
export const OVERSCAN = 600

export function buildOffsets(
  keys: string[],
  heights: ReadonlyMap<string, number>,
): number[] {
  const offsets = [0]
  for (const key of keys)
    offsets.push(offsets.at(-1)! + (heights.get(key) ?? ESTIMATED_HEIGHT))
  return offsets
}

export function indexAt(offsets: number[], position: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (offsets[mid] <= position) low = mid
    else high = mid - 1
  }
  return Math.min(low, Math.max(0, offsets.length - 2))
}

export function visibleRange(
  offsets: number[],
  top: number,
  height: number,
): [number, number] {
  return [
    indexAt(offsets, Math.max(0, top - OVERSCAN)),
    Math.min(offsets.length - 1, indexAt(offsets, top + height + OVERSCAN) + 1),
  ]
}
