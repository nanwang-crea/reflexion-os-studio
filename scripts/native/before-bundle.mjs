import { spawnSync } from 'node:child_process'
import { cp, readFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.platform === 'win32') {
  const cache = join(root, '.cache/cef-native/windows')
  const manifest = join(root, 'apps/desktop/src-tauri/Cargo.toml')
  const debug = process.env.TAURI_ENV_DEBUG === 'true'
  const build = spawnSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      manifest,
      '--lib',
      ...(debug ? [] : ['--release']),
    ],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) process.exit(1)
  const directory = join(
    resolve(
      process.env.CARGO_TARGET_DIR ??
        join(root, 'apps/desktop/src-tauri/target'),
    ),
    process.env.CARGO_BUILD_TARGET ?? '',
    debug ? 'debug' : 'release',
  )
  await cp(cache, directory, { recursive: true })
  await readFile(join(directory, 'reflexion_desktop_lib.dll'))
  await cp(
    join(directory, 'reflexion_desktop_lib.dll'),
    join(cache, 'reflexion-desktop.dll'),
  )
  await cp(
    join(directory, 'reflexion_desktop_lib.dll'),
    join(directory, 'reflexion-desktop.dll'),
  )
  // Tauri packages its expected executable name; the official bootstrap loads the matching DLL.
  await cp(
    join(cache, 'bootstrap.exe'),
    join(directory, 'reflexion-desktop.exe'),
  )
}
const verification = spawnSync(
  process.execPath,
  [join(root, 'scripts/verify-desktop-assets.mjs')],
  { stdio: 'inherit' },
)
if (verification.status !== 0) process.exit(1)
