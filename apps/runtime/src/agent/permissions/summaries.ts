import type { JsonValue } from '@reflexion-os-studio/contracts'

/**
 * 脱敏展示摘要（§7.1/§15）：displayCommand / summary 只用于 UI 与审计摘要，
 * 授权身份永远用 digest。机密形态（key=value、flag 值、Bearer、常见 token
 * 前缀）先行替换再截断；宁可多遮，不可漏遮。
 */

export const DISPLAY_MAX_CHARS = 400

const SECRET_PATTERNS: ReadonlyArray<
  [RegExp, string | ((match: string) => string)]
> = [
  // KEY=VALUE / --key value 形态的凭据参数（大小写不敏感）。
  [
    /(--?(?:password|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|accesskey|auth[-_]?token|credential)(?:[\s=]+|[\s]?))(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1***',
  ],
  // 环境变量赋值：SOME_TOKEN=... / SECRET=...
  [
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g,
    (match: string) => match.slice(0, match.indexOf('=') + 1) + '***',
  ],
  // HTTP 认证头与常见 token 字面量。
  [/\b(?:bearer|basic)\s+[A-Za-z0-9+/=._~%-]{8,}/gi, '$1 ***'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
  // URL 内嵌凭据：scheme://user:pass@host
  [/(:\/\/)([^/\s:@]+):([^@\s/]+)@/g, '$1$2:***@'],
]

/** 对命令/路径等展示文本做机密形态脱敏。 */
export function redactSecrets(text: string): string {
  let output = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement as never)
  }
  // 控制字符（含换行/退格）压成空格：防展示层注入样式文本。
  return output.replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

/** 截断到展示上限（脱敏之后执行；截断标记可见）。 */
export function truncateForDisplay(text: string): string {
  return text.length > DISPLAY_MAX_CHARS
    ? `${text.slice(0, DISPLAY_MAX_CHARS)}…（已截断）`
    : text
}

export function displayCommand(command: string): string {
  return truncateForDisplay(redactSecrets(command))
}

/**
 * 审批卡摘要文本：文件操作显示路径，move 显示 from→to，shell 显示脱敏命令，
 * 其余回退参数 JSON（脱敏 + 截断）。支持 MCP 动态工具名。
 */
export function summarizeArgs(toolName: string, args: JsonValue): string {
  const label = truncateForDisplay(redactSecrets(toolName))
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined
  if (record !== undefined) {
    if (typeof record.path === 'string') {
      return `${label}: ${truncateForDisplay(redactSecrets(record.path))}`
    }
    if (typeof record.from === 'string' && typeof record.to === 'string') {
      return `${label}: ${truncateForDisplay(redactSecrets(record.from))} → ${truncateForDisplay(redactSecrets(record.to))}`
    }
    if (typeof record.command === 'string') {
      return `${label}: ${displayCommand(record.command)}`
    }
  }
  return `${label}: ${truncateForDisplay(
    redactSecrets(JSON.stringify(args).slice(0, 200)),
  )}`
}
