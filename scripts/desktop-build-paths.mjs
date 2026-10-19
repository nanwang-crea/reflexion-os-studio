import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Resolve the executable Tauri just built, before Windows replaces it with CEF bootstrap. */
export function desktopBuildPaths(
  root,
  env = process.env,
  platform = process.platform,
) {
  const host = join(root, 'apps', 'desktop', 'src-tauri')
  const target = env.CARGO_TARGET_DIR
    ? resolve(host, env.CARGO_TARGET_DIR)
    : join(host, 'target')
  const profile = env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release'
  const executable = `reflexion-desktop${platform === 'win32' ? '.exe' : ''}`
  const triple = env.CARGO_BUILD_TARGET ?? env.TAURI_ENV_TARGET_TRIPLE
  const candidates = [
    ...(triple
      ? [{ path: join(target, triple, profile, executable), triple }]
      : []),
    ...(!env.CARGO_BUILD_TARGET
      ? [{ path: join(target, profile, executable) }]
      : []),
  ]
    .filter((candidate) => existsSync(candidate.path))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
  if (!candidates.length)
    throw new Error(`Compiled desktop executable not found under ${target}`)
  return {
    host,
    target,
    profile,
    executable: candidates[0].path,
    triple: candidates[0].triple,
  }
}
