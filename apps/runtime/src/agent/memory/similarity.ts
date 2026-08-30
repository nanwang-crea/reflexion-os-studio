/**
 * 轻量文本相似度：字符二元组 Jaccard。
 * 用于合并决策前找出与候选相似的既有记忆——桌面级数据量（数千条）下
 * 线性扫描足够快，且对中文短文本比 FTS 整句短语匹配更鲁棒。
 */

/** 2-gram 集合；长度不足 2 的文本退化为整串单元素。 */
export function charBigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '').toLowerCase()
  if (normalized.length < 2) {
    return normalized === '' ? new Set() : new Set([normalized])
  }
  const grams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2))
  }
  return grams
}

export function jaccardSimilarity(a: string, b: string): number {
  const gramsA = charBigrams(a)
  const gramsB = charBigrams(b)
  if (gramsA.size === 0 || gramsB.size === 0) return 0
  let intersection = 0
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection += 1
  }
  return intersection / (gramsA.size + gramsB.size - intersection)
}

export const SIMILARITY_THRESHOLD = 0.35
