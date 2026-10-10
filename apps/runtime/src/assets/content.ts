import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { touchesSensitive } from '../agent/permissions/escalation.js'

/** Bound allocation and IO before decoding any preview or model image. */
export async function readAssetContent(
  dataDir: string,
  path: string,
  limit: number,
): Promise<Buffer | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      return null
    const [root, target] = await Promise.all([
      realpath(dataDir),
      realpath(path),
    ])
    const rel = relative(root, target)
    if (
      rel === '..' ||
      rel.startsWith('../') ||
      rel.startsWith('..\\') ||
      isAbsolute(rel) ||
      touchesSensitive(target)
    )
      return null
    // Windows has no O_NOFOLLOW; lstat/realpath checks still apply there.
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    const file = await open(path, flags)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit) return null
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        )
        if (!bytesRead) break
        length += bytesRead
      }
      return length === stat.size ? buffer.subarray(0, length) : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}
