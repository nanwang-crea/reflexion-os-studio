import { unzipSync, zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { containsSecretLike } from '../../instructions/secretGuard.js'

export const MAX_ROLE_PACKAGE_BYTES = 32 * 1024 * 1024
const MAX_FILES = 4000

export function safeEntry(name: string): void {
  if (
    name.length > 512 ||
    name.includes('\\') ||
    name.includes(':') ||
    name.startsWith('/') ||
    name.includes('\0')
  )
    throw new Error('角色包含非法路径')
  for (const part of name.split('/')) {
    if (
      !part ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      part.startsWith('.') ||
      /^(?:credentials\.json|secrets\.json|id_token|node_modules)$/i.test(
        part,
      ) ||
      /\.(?:key|pem|token)$/i.test(part)
    )
      throw new Error('角色包含禁止的文件路径')
  }
}

export function packageFiles(
  directory: string,
  prefix = '',
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null)
  let bytes = 0
  const walk = (folder: string, base: string) => {
    for (const entry of readdirSync(folder)) {
      const name = base ? `${base}/${entry}` : entry
      safeEntry(name)
      const path = join(folder, entry)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('角色包禁止符号链接')
      if (info.isDirectory()) walk(path, name)
      else if (info.isFile()) {
        bytes += info.size
        if (
          bytes > MAX_ROLE_PACKAGE_BYTES ||
          Object.keys(files).length >= MAX_FILES
        )
          throw new Error('角色包超过大小或文件数量限制')
        const content = readFileSync(path)
        if (
          !content.includes(0) &&
          containsSecretLike(content.toString('utf8'))
        )
          throw new Error('技能资源疑似包含机密，拒绝导出')
        files[name] = content
      } else throw new Error('角色包仅支持普通文件')
    }
  }
  walk(directory, prefix)
  return files
}

/** Reject Unix symlinks and duplicate names before fflate decompresses any entry. */
function checkCentralDirectory(data: Buffer): void {
  let end = data.length - 22
  const lower = Math.max(0, end - 65535)
  while (end >= lower && data.readUInt32LE(end) !== 0x06054b50) end--
  if (end < lower) throw new Error('无效 ZIP 文件')
  const count = data.readUInt16LE(end + 10)
  let offset = data.readUInt32LE(end + 16)
  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    count > MAX_FILES ||
    count === 65535
  )
    throw new Error('不支持分卷、ZIP64 或超大角色包')
  const names = new Set<string>()
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('无效 ZIP 目录')
    const length = data.readUInt16LE(offset + 28)
    const next =
      offset +
      46 +
      length +
      data.readUInt16LE(offset + 30) +
      data.readUInt16LE(offset + 32)
    if (next > end) throw new Error('无效 ZIP 路径')
    const name = data
      .subarray(offset + 46, offset + 46 + length)
      .toString('utf8')
    safeEntry(name.endsWith('/') ? name.slice(0, -1) : name)
    const mode = data.readUInt32LE(offset + 38) >>> 16
    if (
      ![0, 0x8000, 0x4000].includes(mode & 0xf000) ||
      data.readUInt16LE(offset + 8) & 1
    )
      throw new Error('禁止链接或加密 ZIP')
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error('角色包文件名重复')
    names.add(key)
    total += data.readUInt32LE(offset + 24)
    if (total > MAX_ROLE_PACKAGE_BYTES) throw new Error('角色包解压后超过 32MB')
    offset = next
  }
}

export function decodeArchive(base64: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('无效角色包编码')
  const data = Buffer.from(base64, 'base64')
  if (data.length < 22 || data.length > MAX_ROLE_PACKAGE_BYTES)
    throw new Error('角色 ZIP 应小于 32MB')
  checkCentralDirectory(data)
  let bytes = 0
  let count = 0
  const files = unzipSync(data, {
    filter: (file) => {
      const name = file.name.endsWith('/') ? file.name.slice(0, -1) : file.name
      safeEntry(name)
      bytes += file.originalSize
      count++
      if (bytes > MAX_ROLE_PACKAGE_BYTES || count > MAX_FILES)
        throw new Error('角色包超过限制')
      return !file.name.endsWith('/')
    },
  })
  for (const [name, content] of Object.entries(files)) {
    safeEntry(name)
    if (
      !content.includes(0) &&
      containsSecretLike(Buffer.from(content).toString('utf8'))
    )
      throw new Error('角色包疑似包含机密')
  }
  return { files, digest: createHash('sha256').update(data).digest('hex') }
}

export function encodeArchive(files: Record<string, Uint8Array>) {
  const bytes = Object.values(files).reduce((sum, file) => sum + file.length, 0)
  if (bytes > MAX_ROLE_PACKAGE_BYTES || Object.keys(files).length > MAX_FILES)
    throw new Error('角色包超过限制')
  const archive = zipSync(files)
  if (archive.length > MAX_ROLE_PACKAGE_BYTES)
    throw new Error('角色 ZIP 超过 32MB')
  return archive
}

export function contentDigest(files: Record<string, Uint8Array>): string {
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    hash.update(JSON.stringify([name, files[name].length]))
    hash.update(files[name])
  }
  return hash.digest('hex')
}
