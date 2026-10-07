import { diffArrays } from 'diff'

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, '\n')
}

/** 保存时映射原文行：未修改行保留原分隔符，替换行沿用对应行，新行沿用邻近行。 */
export function preserveLineEndings(original: string, edited: string): string {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const source = original.replace(/^\uFEFF/, '')
  const target = normalizeLineEndings(edited.replace(/^\uFEFF/, ''))
  const endings = source.match(/\r\n|\r|\n/g) ?? []
  const fallback = endings[0] ?? '\n'
  if (new Set(endings).size <= 1) return bom + target.replace(/\n/g, fallback)

  const before = normalizeLineEndings(source).split('\n')
  const after = target.split('\n')
  // 先锚定首尾未变行，避免重复行被错误地匹配到另一处，也缩小差异计算范围。
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1
  // 差异计算只在保存时执行并有界；无法完成时拒绝写入，保留草稿。
  const middle = diffArrays(
    before.slice(prefix, before.length - suffix),
    after.slice(prefix, after.length - suffix),
    { timeout: 50, maxEditLength: 2000 },
  )
  if (!middle)
    throw new Error('修改范围过大，无法安全保留混合换行；请分次保存。')
  const changes = [
    { value: before.slice(0, prefix), added: false, removed: false },
    ...middle,
    {
      value: before.slice(before.length - suffix),
      added: false,
      removed: false,
    },
  ]
  const output: string[] = []
  let oldIndex = 0
  let newIndex = 0
  let removedStart = 0
  let removedCount = 0
  for (const change of changes) {
    if (change.removed) {
      removedStart = oldIndex
      removedCount = change.value.length
      oldIndex += removedCount
      continue
    }
    for (let index = 0; index < change.value.length; index += 1) {
      const ending = change.added
        ? ((index < removedCount ? endings[removedStart + index] : undefined) ??
          endings[(removedCount > 0 ? removedStart : oldIndex) - 1] ??
          endings[oldIndex] ??
          fallback)
        : (endings[oldIndex + index] ?? fallback)
      output.push(change.value[index])
      if (newIndex < after.length - 1) output.push(ending)
      newIndex += 1
    }
    if (!change.added) oldIndex += change.value.length
    removedCount = 0
  }
  return bom + output.join('')
}
