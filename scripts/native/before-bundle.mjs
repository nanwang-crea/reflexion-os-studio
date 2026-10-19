import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageWindowsBundle } from './windows-bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.platform === 'win32') await stageWindowsBundle(root)
const verification = spawnSync(
  process.execPath,
  [join(root, 'scripts/verify-desktop-assets.mjs')],
  { stdio: 'inherit' },
)
if (verification.error) throw verification.error
if (verification.status !== 0) process.exit(1)
