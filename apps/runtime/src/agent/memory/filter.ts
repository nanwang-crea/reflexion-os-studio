/**
 * 记忆管线共享工具：宽松 JSON 解析与机密形态过滤。
 * 提取器产出的候选必须过机密过滤才能落库（secret 纪律：机密只存在于 secrets.json）。
 */

/** 从 LLM 输出中提取首个 JSON 数组/对象；容忍代码块围栏与前后杂文字。 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.search(/[[{]/)
  if (start === -1) return null
  const opener = trimmed[start]
  const closer = opener === '[' ? ']' : '}'
  const end = trimmed.lastIndexOf(closer)
  if (end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

const SECRET_PATTERNS: RegExp[] = [
  // 常见密钥前缀形态：OpenAI/AWS/GitHub/私有部署 Key 等。
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Bearer / 赋值形态的凭据。
  /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i,
  /(?:密码|密钥|令牌|口令)\s*[:：=]\s*\S{6,}/,
  // 高熵长串（base64/hex 凭据常见形态）。
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/,
  /\b[a-f0-9]{64}\b/,
]

/** 形态上像机密的内容直接丢弃：宁可漏存一条记忆，不可落盘一个凭据。 */
export function containsSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}
