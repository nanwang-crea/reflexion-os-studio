import { isAbsolute, basename, dirname, join, resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Windows 环境键不区分大小写，配置中的 PATH 必须覆盖系统的 Path。 */
export function mcpEnvironment(
  overrides: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...base, ...overrides }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of [
    ...Object.entries(base),
    ...Object.entries(overrides),
  ]) {
    const previous = Object.keys(env).find(
      (entry) => entry.toLowerCase() === key.toLowerCase(),
    )
    if (previous) delete env[previous]
    env[key] = value
  }
  return env
}

function windowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const extKey = Object.keys(env).find((key) => key.toLowerCase() === 'pathext')
  const extensions = /\.[^\\/]+$/.test(command)
    ? ['']
    : (env[extKey ?? ''] ?? '.EXE;.CMD;.BAT;.COM').split(';')
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? ['']
      : [process.cwd(), ...(env[pathKey ?? ''] ?? '').split(';')].map((path) =>
          path.replace(/^"(.*)"$/, '$1'),
        )
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension.toLowerCase())
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/** 仅适配经过安装布局与入口元数据验证的 npm/npx；不解释任意批处理正文。 */
export async function resolveMcpLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const original = { command, args }
  if (platform !== 'win32' || !/^(npm|npx)(\.cmd)?$/i.test(basename(command)))
    return original
  const launcher = windowsCommand(command, env)
  if (!launcher || !/\.cmd$/i.test(launcher)) return original
  const name = basename(launcher)
    .toLowerCase()
    .replace(/\.cmd$/, '')
  const directory = dirname(launcher)
  const packageDirectories = [join(directory, 'node_modules', 'npm')]
  if (basename(directory).toLowerCase() === '.bin') {
    packageDirectories.push(resolve(directory, '..', 'npm'))
  }
  for (const packageDirectory of packageDirectories) {
    const manifestPath = join(packageDirectory, 'package.json')
    const cli = join(packageDirectory, 'bin', `${name}-cli.js`)
    try {
      if (
        !isFile(cli) ||
        statSync(manifestPath).size > 64 * 1024 ||
        statSync(launcher).size > 64 * 1024
      )
        continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string
        bin?: Record<string, string>
      }
      const shim = readFileSync(launcher, 'utf8')
        .replace(/\\/g, '/')
        .toLowerCase()
      if (
        manifest.name !== 'npm' ||
        manifest.bin?.[name] !== `bin/${name}-cli.js` ||
        !shim.includes(`npm/bin/${name}-cli.js`) ||
        !shim.includes('%*')
      )
        continue
      const siblingNode = join(directory, 'node.exe')
      const node = isFile(siblingNode)
        ? siblingNode
        : (windowsCommand('node.exe', env) ?? process.execPath)
      let selectedCli = cli
      // 官方启动器优先选择全局 prefix 下更新过的 npm，保留这项行为。
      if (shim.includes('npm-prefix.js')) {
        const prefixScript = join(packageDirectory, 'bin', 'npm-prefix.js')
        if (!isFile(prefixScript)) return original
        try {
          const { stdout } = await execFileAsync(node, [prefixScript], {
            env,
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 64 * 1024,
          })
          const prefix = stdout.trim()
          if (isAbsolute(prefix)) {
            const globalPackage = join(prefix, 'node_modules', 'npm')
            const globalManifestPath = join(globalPackage, 'package.json')
            if (statSync(globalManifestPath).size <= 64 * 1024) {
              const globalManifest = JSON.parse(
                readFileSync(globalManifestPath, 'utf8'),
              ) as { name?: string; bin?: Record<string, string> }
              const globalCli = join(globalPackage, 'bin', `${name}-cli.js`)
              if (
                globalManifest.name === 'npm' &&
                globalManifest.bin?.[name] === `bin/${name}-cli.js` &&
                isFile(globalCli)
              )
                selectedCli = globalCli
            }
          }
        } catch {
          // 与官方脚本一致：prefix 查询失败或全局 CLI 不存在时使用本地 CLI。
        }
      }
      return { command: node, args: [selectedCli, ...args] }
    } catch {
      // 未验证的布局保留原启动方式，不猜测入口或绕过自定义脚本。
    }
  }
  return original
}
