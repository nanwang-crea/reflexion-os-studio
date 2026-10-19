import { spawnSync } from 'node:child_process'
import { cp, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { desktopBuildPaths } from '../desktop-build-paths.mjs'

/** Rebuild the bootstrap DLL with the same embedded-asset mode as tauri build. */
export async function stageWindowsBundle(
  root,
  env = process.env,
  run = spawnSync,
) {
  const paths = desktopBuildPaths(root, env, 'win32')
  const directory = dirname(paths.executable)
  const cache = join(root, '.cache', 'cef-native', 'windows')
  const result = run(
    'cargo',
    [
      'build',
      '--manifest-path',
      join(paths.host, 'Cargo.toml'),
      '--lib',
      // --release alone does not embed frontend assets. Tauri's own build enables
      // this dependency feature; the separate DLL build must do the same, even
      // when packaging with --debug.
      '--features',
      'tauri/custom-protocol',
      ...(paths.profile === 'debug' ? [] : ['--release']),
      ...(paths.triple ? ['--target', paths.triple] : []),
    ],
    {
      cwd: paths.host,
      env: { ...env, CARGO_TARGET_DIR: paths.target },
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `Windows CEF DLL build failed (exit ${result.status}, signal ${result.signal ?? 'none'})`,
    )
  const library = join(directory, 'reflexion_desktop_lib.dll')
  // Check the current DLL before changing the launcher. Never stage a stale cache DLL.
  await readFile(library)
  await cp(cache, directory, { recursive: true })
  await cp(library, join(cache, 'reflexion-desktop.dll'))
  await cp(library, join(directory, 'reflexion-desktop.dll'))
  await cp(join(cache, 'bootstrap.exe'), paths.executable)
}
