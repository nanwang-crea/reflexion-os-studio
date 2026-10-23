import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'

export interface ResourceFingerprint {
  size: number
  digest: string
}

export const SNAPSHOT_CHANGED =
  'Skill 快照资源已变化，请结束当前 Run 后重新准备'

/** Scan with bounded memory and reject both growth and truncation. */
export function scanResource(
  descriptor: number,
  size: number,
  onChunk?: (chunk: Buffer, offset: number) => void,
): string {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(65536)
  let offset = 0
  while (offset <= size) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - offset + 1),
      offset,
    )
    if (!count) break
    if (offset + count > size) throw new Error(SNAPSHOT_CHANGED)
    const chunk = buffer.subarray(0, count)
    hash.update(chunk)
    onChunk?.(chunk, offset)
    offset += count
  }
  if (offset !== size) throw new Error(SNAPSHOT_CHANGED)
  return hash.digest('hex')
}

/** Called only on the validated private copy, before its path is exposed. */
export function fingerprintResource(path: string): ResourceFingerprint {
  const descriptor = openSync(path, 'r')
  try {
    const size = fstatSync(descriptor).size
    return { size, digest: scanResource(descriptor, size) }
  } finally {
    closeSync(descriptor)
  }
}

/** Never follow a script's replacement into a different resource. */
export function openSnapshotResource(
  directory: string,
  resource: string,
  size: number,
): number {
  if (
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== directory
  )
    throw new Error(SNAPSHOT_CHANGED)
  const parts = resource.split('/')
  let path = directory
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    const info = lstatSync(path)
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    )
      throw new Error('Skill 资源必须为快照内的普通文件，不能使用符号链接')
  }
  const info = lstatSync(path)
  if (info.nlink !== 1 || info.size !== size) throw new Error(SNAPSHOT_CHANGED)
  // Windows has no O_NOFOLLOW; path checks and opened-file identity apply there.
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  )
  try {
    const opened = fstatSync(descriptor)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size !== info.size ||
      realpathSync(path) !== path
    )
      throw new Error(SNAPSHOT_CHANGED)
    return descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}
