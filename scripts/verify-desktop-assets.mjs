#!/usr/bin/env node
// Run after Rust compilation and before any platform installer is bundled.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopBuildPaths } from './desktop-build-paths.mjs'

export function verifyDesktopAssets(
  root,
  env = process.env,
  platform = process.platform,
  run = spawnSync,
) {
  const { executable } = desktopBuildPaths(root, env, platform)
  const result = run(executable, ['--verify-frontend-assets'], {
    stdio: 'inherit',
    timeout: 30000,
    cwd: dirname(executable),
    env,
  })
  if (result.error || result.status !== 0) {
    const status =
      result.status === null
        ? 'none'
        : `${result.status} (0x${(result.status >>> 0).toString(16).padStart(8, '0')})`
    throw new Error(
      `Embedded frontend verification failed; installer bundling stopped: executable=${executable}, exit=${status}, signal=${result.signal ?? 'none'}${result.error ? `, error=${result.error.message}` : ''}`,
      result.error ? { cause: result.error } : undefined,
    )
  }
  console.log(
    'Embedded frontend verified: index.html and entry JS/CSS are present',
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyDesktopAssets(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}
