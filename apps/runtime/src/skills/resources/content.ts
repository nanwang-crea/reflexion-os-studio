import { closeSync } from 'node:fs'
import {
  MAX_SKILL_RESOURCE_PAGE_BYTES,
  type SkillResourcePage,
  type SkillResourceReadOptions,
} from '@reflexion-os-studio/contracts'
import {
  openSnapshotResource,
  scanResource,
  SNAPSHOT_CHANGED,
  type ResourceFingerprint,
} from './files.js'

/** Validate the whole original resource, retaining only the requested page. */
export function readSnapshotText(
  directory: string,
  resource: string,
  fingerprint: ResourceFingerprint,
  options: SkillResourceReadOptions,
): SkillResourcePage {
  const offset = options.offset ?? 0
  const limit = options.limit ?? MAX_SKILL_RESOURCE_PAGE_BYTES
  const size = fingerprint.size
  if (offset > size)
    throw new Error(
      `offset 超出资源大小（${size} 字节），请使用上一页的 nextOffset`,
    )
  const page = Buffer.alloc(Math.min(limit + 1, size - offset))
  const validator = new TextDecoder('utf-8', { fatal: true })
  const descriptor = openSnapshotResource(directory, resource, size)
  try {
    const digest = scanResource(descriptor, size, (chunk, position) => {
      if (chunk.includes(0))
        throw new Error('资源为二进制，请通过脚本使用快照文件')
      try {
        validator.decode(chunk, { stream: true })
      } catch {
        throw new Error('资源不是有效 UTF-8 文本，请通过脚本使用快照文件')
      }
      const start = Math.max(offset, position)
      const end = Math.min(offset + page.length, position + chunk.length)
      if (end > start)
        chunk.copy(page, start - offset, start - position, end - position)
    })
    if (digest !== fingerprint.digest) throw new Error(SNAPSHOT_CHANGED)
    try {
      validator.decode()
    } catch {
      throw new Error('资源不是有效 UTF-8 文本，请通过脚本使用快照文件')
    }
  } finally {
    closeSync(descriptor)
  }
  const continuation = (byte: number): boolean => (byte & 0xc0) === 0x80
  if (page.length && continuation(page[0]!))
    throw new Error('offset 必须位于 UTF-8 字符边界，请使用上一页的 nextOffset')
  let bytesRead = Math.min(limit, page.length)
  while (bytesRead < page.length && continuation(page[bytesRead]!))
    bytesRead -= 1
  const nextOffset = offset + bytesRead < size ? offset + bytesRead : null
  return {
    path: resource,
    content: new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: offset !== 0,
    }).decode(page.subarray(0, bytesRead)),
    offset,
    bytesRead,
    totalBytes: size,
    hasMore: nextOffset !== null,
    nextOffset,
  }
}
