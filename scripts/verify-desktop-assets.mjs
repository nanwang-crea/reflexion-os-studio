#!/usr/bin/env node
// Run after Rust compilation and before any platform installer is bundled.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = join(root, 'apps', 'desktop', 'src-tauri')
const target = process.env.CARGO_TARGET_DIR
  ? resolve(host, process.env.CARGO_TARGET_DIR)
  : join(host, 'target')
const profile = process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release'
const executable = `reflexion-desktop${process.platform === 'win32' ? '.exe' : ''}`
const triple =
  process.env.CARGO_BUILD_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE
const candidates = [
  ...(triple ? [join(target, triple, profile, executable)] : []),
  join(target, profile, executable),
]
  .filter(existsSync)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
if (!candidates.length) throw new Error('Compiled desktop executable not found')
const result = spawnSync(candidates[0], ['--verify-frontend-assets'], {
  stdio: 'inherit',
  timeout: 30000,
})
if (result.error || result.status !== 0) {
  throw new Error(
    'Embedded frontend verification failed; installer bundling stopped',
    {
      cause: result.error,
    },
  )
}
console.log(
  'Embedded frontend verified: index.html and entry JS/CSS are present',
)
