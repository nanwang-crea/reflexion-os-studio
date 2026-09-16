import type { ShellInterpreter } from '@reflexion-os-studio/contracts'

/**
 * Shell 保守分类器（§9.2/§9.3）：本期只为"简单单命令"生成可复用的前缀规则。
 * 判定必须按**实际执行解释器**（macOS/Linux `/bin/sh -c` → posix-sh；
 * Windows `cmd.exe /C` → windows-cmd），与执行器同批切换，禁止不一致。
 *
 * 保守原则：任何无法可靠解释的形态（未闭合引号、转义歧义、动态展开）一律
 * 判"不可复用"（只允许一次）。宁可少授权，不可错授权。
 */

export const MIN_PREFIX_TOKENS = 2

/** 可执行名 + 稳定子命令形态：`git`、`cargo-test` 之类；flag 不是子命令。 */
const STABLE_SUBCOMMAND = /^[A-Za-z][A-Za-z0-9._-]*$/

/** 解释器/包装器/元命令：其参数是"另一条命令"，前缀授权无意义。 */
const WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'cmd',
  'powershell',
  'pwsh',
  'eval',
  'exec',
  'env',
  'nohup',
  'xargs',
  'time',
  'sudo',
  'su',
  'doas',
])

/** 删除/破坏/特权类命令：永远只允许一次（即使形态简单）。 */
const DESTRUCTIVE_EXECUTABLES = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'dd',
  'mkfs',
  'format',
  'del',
  'erase',
  'rd',
  'move',
  'chmod',
  'chown',
  'kill',
  'pkill',
  'killall',
  'reg',
  'sc',
  'net',
  'diskpart',
])

export interface ShellClassification {
  reusable: boolean
  /** 解析出的 token（解析失败时为 []）；rule 匹配与 prefix 校验共用。 */
  tokens: string[]
  /** 默认前缀候选（tokens 前 2 项，仅当可复用）；null = 不提供 session prefix。 */
  defaultCandidate: string[] | null
  /** 不可复用原因（进入审批卡详情，不含机密）。 */
  reason: string | null
}

/** POSIX 保守 tokenizer：普通引号/转义空格可解析；出现任何组合/展开/重定向即失败。 */
function tokenizePosix(command: string): { tokens: string[] } | null {
  // 结构性操作符（含后台 &、换行、here-doc）与重定向：先于 tokenize 拒绝。
  if (/[;|&<>\n\r]/.test(command)) return null
  if (command.includes('`') || command.includes('$')) return null
  if (command.includes('\\')) return null // 行内转义语义按 sh 规则复杂，保守拒绝
  if (/[\u0000\u001f]/.test(command)) return null
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let sawAny = false
  for (const char of command) {
    if (char === "'") {
      if (inDouble) {
        current += char
      } else {
        inSingle = !inSingle
        sawAny = true
      }
      continue
    }
    if (char === '"') {
      if (inSingle) {
        current += char
      } else {
        inDouble = !inDouble
        sawAny = true
      }
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (inSingle || inDouble) return null // 未闭合引号
  if (current !== '') tokens.push(current)
  if (!sawAny && tokens.length === 0) return null
  return { tokens }
}

/** Windows cmd 保守 tokenizer：`&`/`|`/重定向/转义/`%VAR%`/延迟展开一律失败。 */
function tokenizeCmd(command: string): { tokens: string[] } | null {
  if (/[&|<>()^\n\r%!]/.test(command)) return null
  if (command.includes('"')) {
    // 引号必须成对且不跨 token 粘连（`a"b c"` 形态拒绝）。
    const quotes = command.split('"').length - 1
    if (quotes % 2 !== 0) return null
  }
  const tokens: string[] = []
  let current = ''
  let inDouble = false
  for (const char of command) {
    if (char === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inDouble && /\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (inDouble) return null
  if (current !== '') tokens.push(current)
  if (tokens.length === 0) return null
  return { tokens }
}

function hasShellFlagToken(tokens: string[]): boolean {
  // `sh -c` / `bash -c` / `python -c` 类：可执行后紧跟 -c/--command。
  return (
    tokens.length >= 2 &&
    (tokens[1] === '-c' ||
      tokens[1] === '--command' ||
      tokens[1] === '/C' ||
      tokens[1] === '/c' ||
      tokens[1] === '/K')
  )
}

/** 破坏性子命令组合（简单 token 检查）：git push --force / reset --hard / clean。 */
function isDestructiveCombo(tokens: string[]): boolean {
  const [head, second, ...rest] = tokens
  if (head === undefined || second === undefined) return false
  const lower = head.toLowerCase()
  if (lower === 'git') {
    if (second === 'clean') return true
    if (second === 'reset' && rest.includes('--hard')) return true
    if (
      second === 'push' &&
      rest.some(
        (token) =>
          token === '-f' ||
          token === '--force' ||
          token === '--force-with-lease' ||
          (token.startsWith('-') &&
            token.includes('f') &&
            !token.includes('--')),
      )
    ) {
      return true
    }
    return false
  }
  if (lower === 'npm' || lower === 'pnpm' || lower === 'yarn') {
    return (
      second === 'publish' || second === 'unpublish' || second === 'deprecate'
    )
  }
  return false
}

export function classifyShellCommand(
  command: string,
  interpreter: ShellInterpreter,
): ShellClassification {
  const failure = (reason: string): ShellClassification => ({
    reusable: false,
    tokens: [],
    defaultCandidate: null,
    reason,
  })
  const trimmed = command.trim()
  if (trimmed === '') return failure('空命令')
  const tokenized =
    interpreter === 'windows-cmd'
      ? tokenizeCmd(trimmed)
      : tokenizePosix(trimmed)
  if (tokenized === null) {
    return failure(
      interpreter === 'windows-cmd'
        ? '命令含 cmd 组合符/重定向/展开或无法可靠解析，不能生成可复用前缀'
        : '命令含多命令/重定向/展开或无法可靠解析，不能生成可复用前缀',
    )
  }
  const { tokens } = tokenized
  if (tokens.length < MIN_PREFIX_TOKENS) {
    return failure('单 token 命令不生成会话前缀（至少可执行文件 + 子命令）')
  }
  if (hasShellFlagToken(tokens)) {
    return failure('解释器 -c / cmd /C 形态会执行任意代码，不能生成可复用前缀')
  }
  const head = tokens[0].toLowerCase()
  if (WRAPPERS.has(head) || DESTRUCTIVE_EXECUTABLES.has(head)) {
    return failure(`${tokens[0]} 属包装器/破坏/特权命令，只允许一次`)
  }
  if (!/^[A-Za-z][A-Za-z0-9._/@-]*$/.test(tokens[0])) {
    return failure('可执行名含非常规字符，不能生成可复用前缀')
  }
  if (!STABLE_SUBCOMMAND.test(tokens[1])) {
    return failure('第二个 token 不是稳定子命令（flag/路径），只允许一次')
  }
  if (isDestructiveCombo(tokens)) {
    return failure(
      '破坏性子命令组合（force push / reset --hard / clean 等），只允许一次',
    )
  }
  return {
    reusable: true,
    tokens,
    defaultCandidate: [tokens[0], tokens[1]],
    reason: null,
  }
}

/**
 * 校验模型提出的 prefix_rule 与实际命令 token 匹配（§9.1/§9.3）：
 * 长度 ≥2、逐 token 全等、必须是实际命令的前缀；不合规回退默认候选。
 * 模型不能借 prefix_rule 扩大授权：候选永远 ≤ 实际 token 前缀。
 */
export function resolvePrefixCandidate(
  classification: ShellClassification,
  proposed: unknown,
): string[] | null {
  if (!classification.reusable) return null
  if (Array.isArray(proposed) && proposed.length > 0) {
    const valid =
      proposed.length >= MIN_PREFIX_TOKENS &&
      proposed.length <= classification.tokens.length &&
      proposed.every(
        (token, index) =>
          typeof token === 'string' && token === classification.tokens[index],
      )
    if (valid) return proposed.map(String)
    // 校验失败：仍可"允许一次"，不能创建 session rule。
    return null
  }
  return classification.defaultCandidate
}
