import {
  accessSync,
  closeSync,
  fstatSync,
  openSync,
  constants,
  lstatSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { AgentBrowserInstallationSchema } from '@reflexion-os-studio/contracts'

/** Inspect only a bounded regular marker; never follow a marker/cache symlink. */
export function isBrowserInstallation(
  directory: string,
  version: string,
): boolean {
  try {
    if (!lstatSync(directory).isDirectory()) return false
    const marker = join(directory, 'installed.json')
    const info = lstatSync(marker)
    if (!info.isFile() || info.size > 4096) return false
    const descriptor = openSync(
      marker,
      constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    )
    let raw: string
    try {
      const opened = fstatSync(descriptor)
      if (
        !opened.isFile() ||
        opened.size > 4096 ||
        opened.nlink !== 1 ||
        opened.ino !== info.ino ||
        opened.dev !== info.dev
      )
        return false
      const buffer = Buffer.alloc(4097)
      const count = readSync(descriptor, buffer, 0, buffer.length, 0)
      if (count > 4096) return false
      raw = buffer.toString('utf8', 0, count)
    } finally {
      closeSync(descriptor)
    }
    const record = AgentBrowserInstallationSchema.parse(JSON.parse(raw))
    if (record.version !== version || isAbsolute(record.executable))
      return false
    const root = realpathSync(directory)
    const executable = realpathSync(resolve(root, record.executable))
    if (!executable.startsWith(root + sep) || !statSync(executable).isFile())
      return false
    accessSync(
      executable,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    )
    return true
  } catch {
    return false
  }
}
