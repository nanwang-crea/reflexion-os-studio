// 对实际随包二进制检查 DLL 导入；CI 的预装 VC++ 运行库会掩盖动态依赖。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCrtDependencies } from './windows/crt-dependencies.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP Windows CRT dependency check on this platform')
  process.exit(0)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = join(
  root,
  'apps/desktop/src-tauri/package-resources/bin/reflexion-system-runtime.exe',
)
if (!existsSync(binary)) throw new Error(`Packaged sidecar missing: ${binary}`)

function execute(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
    )
  }
  return result.stdout
}

let dumpbin
const fromPath = spawnSync('where.exe', ['dumpbin.exe'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10_000,
})
if (fromPath.status === 0) dumpbin = fromPath.stdout.trim().split(/\r?\n/)[0]
if (!dumpbin) {
  const programFiles =
    process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
  if (!programFiles)
    throw new Error('Visual Studio tools directory unavailable')
  const vswhere = join(
    programFiles,
    'Microsoft Visual Studio/Installer/vswhere.exe',
  )
  if (!existsSync(vswhere))
    throw new Error('vswhere.exe unavailable; install MSVC build tools')
  const paths = execute(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-find',
    'VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe',
  ])
  dumpbin = paths
    .trim()
    .split(/\r?\n/)
    .find((path) => existsSync(path))
}
if (!dumpbin)
  throw new Error(
    'dumpbin.exe unavailable; cannot verify packaged dependencies',
  )
const dependencies = verifyCrtDependencies(
  execute(dumpbin, ['/nologo', '/dependents', binary]),
)
console.log(
  `PASS packaged Windows sidecar has no dynamic CRT imports: ${dependencies.join(', ')}`,
)
