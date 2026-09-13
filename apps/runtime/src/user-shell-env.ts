import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * P1 环境继承（替代原 S1"每命令 -lc"方案，对齐 VS Code/Claude Code 快照做法）：
 * GUI（Finder/图标）启动链的 PATH 只有系统目录，shell 工具与 MCP spawn 找不到
 * nvm/homebrew/conda 等用户工具。这里在 Runtime 启动时跑一次
 * `$SHELL -ilc 'env -0'` 取用户真实环境快照，合并进 process.env，
 * 之后 spawn 的一切子进程（Rust sidecar、MCP server、shell 命令）自然继承。
 * 失败/超时只记 degraded 日志，不阻塞启动（与沙箱降级同一纪律）。
 */

export type UserShellEnvStatus =
  | 'applied'
  | 'ok'
  | 'skipped-platform'
  | 'skipped-shell'
  | 'timeout'
  | 'failed'
  | 'empty'

export interface UserShellEnvProbe {
  status: UserShellEnvStatus
  env: Record<string, string>
}

const PROBE_TIMEOUT_MS = 2_000
const DUMP_COMMAND = 'env -0'
/** 会话噪声类变量：即使缺失也不从快照导入（终端属性、shell 内部状态、sudo 残留）。 */
const NEVER_IMPORT = new Set([
  '_',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PROMPT',
  'RPROMPT',
  'SUDO_COMMAND',
  'SUDO_USER',
  'SUDO_UID',
  'SUDO_GID',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
])

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseEnvDump(dump: string): Record<string, string> {
  const result: Record<string, string> = {}
  const records = dump.includes('\0') ? dump.split('\0') : dump.split('\n')
  const consume = (record: string): boolean => {
    const separator = record.indexOf('=')
    if (separator <= 0) return false
    const key = record.slice(0, separator)
    if (!KEY_PATTERN.test(key)) return false
    result[key] = record.slice(separator + 1)
    return true
  }
  for (const record of records) {
    if (record === '') continue
    if (consume(record)) continue
    // rc 噪声不带换行结尾时会与首条记录粘连：按换行拆开逐段重试。
    for (const line of record.split('\n')) consume(line)
  }
  return result
}

/**
 * 合并策略：PATH = 快照条目在前、现值在后（按目录去重）；
 * 其余变量只补当前缺失的，绝不覆盖 Runtime 已显式设置的值。
 */
export function mergeUserEnv(
  target: NodeJS.ProcessEnv,
  snapshot: Record<string, string>,
): { added: string[]; pathPrepended: number } {
  const added: string[] = []
  let pathPrepended = 0
  const currentEntries = (target.PATH ?? '').split(':').filter(Boolean)
  const seen = new Set(currentEntries)
  const snapshotPath = (snapshot.PATH ?? '').split(':').filter(Boolean)
  const prepend = snapshotPath.filter((entry) => !seen.has(entry))
  pathPrepended = prepend.length
  if (pathPrepended > 0) {
    target.PATH = [...prepend, ...currentEntries].join(':')
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'PATH' || NEVER_IMPORT.has(key)) continue
    if (value === '' || target[key] !== undefined) continue
    target[key] = value
    added.push(key)
  }
  return { added, pathPrepended }
}

export function resolveProbeShell(): string | null {
  if (process.platform === 'win32') return null
  const shell = process.env.SHELL
  if (!shell || !isAbsolute(shell) || !existsSync(shell)) return null
  try {
    accessSync(shell, constants.X_OK)
  } catch {
    return null
  }
  return shell
}

export function probeUserShellEnv(
  options: { shell?: string | null; timeoutMs?: number } = {},
): Promise<UserShellEnvProbe> {
  const shell =
    options.shell === undefined ? resolveProbeShell() : options.shell
  if (!shell) return Promise.resolve({ status: 'skipped-shell', env: {} })
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-i', '-l', '-c', DUMP_COMMAND], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve({ status: 'failed', env: {} })
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const finish = (
      status: UserShellEnvStatus,
      env: Record<string, string>,
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, env })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
      finish('timeout', {})
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => finish('failed', {}))
    child.on('close', (code) => {
      const env = parseEnvDump(Buffer.concat(chunks).toString('utf8'))
      if (Object.keys(env).length === 0) {
        finish(code === 0 ? 'empty' : 'failed', {})
        return
      }
      finish('ok', env)
    })
  })
}

export async function applyUserShellEnv(
  log: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`)
  },
): Promise<UserShellEnvStatus> {
  try {
    if (process.platform === 'win32') return 'skipped-platform'
    const probe = await probeUserShellEnv()
    if (probe.status !== 'ok') {
      log(
        `[runtime] user shell env not applied (${probe.status}); ` +
          'inherited env stays launchd-minimal',
      )
      return probe.status
    }
    const { added, pathPrepended } = mergeUserEnv(process.env, probe.env)
    log(
      `[runtime] user shell env applied (+${pathPrepended} PATH entries, ` +
        `+${added.length} vars, shell=${process.env.SHELL ?? '?'})`,
    )
    return 'applied'
  } catch (error) {
    log(
      `[runtime] user shell env probe crashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return 'failed'
  }
}
