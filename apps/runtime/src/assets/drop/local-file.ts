import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  TEXT_FILE_EXTENSIONS,
} from '@reflexion-os-studio/contracts'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { CommandError } from '../../agent/errors.js'
import { touchesSensitive } from '../../agent/permissions/escalation.js'

/**
 * 系统文件管理器拖入窗口的本地文件读取（asset.read_dropped_file）。
 *
 * 与 file.read / asset.import 的差别：路径来自操作系统拖放，必然是绝对路径，
 * 且不保证落在工作区内——用户拖桌面上的 PDF 是正常操作。因此这里不套工作区
 * containment，而是用「类型白名单 + 大小上限 + no-read 凭据清单 + realpath
 * 复核」四条硬边界把关，把结果只交给输入框当「待上传附件」，再由既有的
 * asset.upload_document / asset.upload_image 落 Asset Store（不产生第二套存储）。
 *
 * 安全要点：
 * - 拒绝相对路径与控制字符，避免半成品路径被当成相对工作区路径解析；
 * - 原始路径与 realpath 后的真实路径都过 touchesSensitive（no-read 清单）：
 *   指向 ~/.ssh/.aws/.gnupg/secrets.json/*.pem 等的软链接同样被拦下；
 * - realpath 之后再 stat，确认是普通文件（目录、设备、FIFO 一律拒绝）；
 * - 类型白名单与输入框选择器同源（ATTACHMENT_ACCEPT），未支持类型不回传字节；
 * - 先按 stat 廉价预检、再以实际读入长度复核，防止预检后文件被替换（TOCTOU）。
 */

/** 扩展名 → mime：仅保留输入框允许作为附件的图片类型。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** 扩展名 → mime：二进制文档（文本/代码统一按 text/plain 交给文档抽取链路）。 */
const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const TEXT_EXTENSIONS = new Set(
  TEXT_FILE_EXTENSIONS.map((extension) => `.${extension}`),
)

/** 拖入文件读出的字节与元信息（base64 与输入框 File 构造同格式）。 */
export type DroppedLocalFile = {
  fileName: string
  mimeType: string
  base64: string
  size: number
}

/** 白名单判定：返回 null 表示该类型不能作为消息附件。 */
function mimeForFileName(fileName: string): string | null {
  const extension = extname(fileName).toLowerCase()
  return (
    IMAGE_MIME_BY_EXT[extension] ??
    DOCUMENT_MIME_BY_EXT[extension] ??
    (TEXT_EXTENSIONS.has(extension) ? 'text/plain' : null)
  )
}

function limitForMime(mimeType: string): number {
  return mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
}

function humanMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return Number.isInteger(megabytes)
    ? `${megabytes}MB`
    : `${megabytes.toFixed(1)}MB`
}

/**
 * 把用户拖入的绝对路径读成 base64。任何不合规输入都以 invalid_request 拒绝，
 * 不在错误信息里回显文件内容。
 */
export async function readDroppedLocalFile(
  rawPath: string,
): Promise<DroppedLocalFile> {
  if (!isAbsolute(rawPath) || /[\x00-\x1f\x7f]/.test(rawPath)) {
    throw new CommandError('invalid_request', '只接受文件管理器拖入的绝对路径')
  }
  const sourcePath = resolve(rawPath)
  const fileName = basename(sourcePath)
  if (fileName === '' || fileName.length > 255) {
    throw new CommandError('invalid_request', '文件名无效或过长')
  }
  // no-read 清单：先按原始路径拦一次，避免 realpath 之前的任何读取动作。
  if (touchesSensitive(sourcePath)) {
    throw new CommandError('invalid_request', '禁止读取凭据或敏感文件')
  }
  // 软链接必须解析后复核：~/notes/secret.pem 这类伪装名同样要拦住。
  const realSource = await realpath(sourcePath).catch(() => null)
  if (realSource === null) {
    throw new CommandError('invalid_request', `文件不存在：${fileName}`)
  }
  if (touchesSensitive(realSource)) {
    throw new CommandError('invalid_request', '禁止读取凭据或敏感文件')
  }
  const info = await stat(realSource).catch(() => null)
  if (info === null || !info.isFile()) {
    throw new CommandError(
      'invalid_request',
      '只支持拖入普通文件，不支持文件夹',
    )
  }
  const mimeType = mimeForFileName(fileName)
  if (mimeType === null) {
    const extension = extname(fileName).toLowerCase() || '（无扩展名）'
    throw new CommandError(
      'invalid_request',
      `不支持的文件类型 ${extension}：仅限图片、文本/代码、PDF、DOCX 与 XLSX`,
    )
  }
  const limit = limitForMime(mimeType)
  if (info.size === 0) {
    throw new CommandError('invalid_request', '文件为空，无法作为附件')
  }
  if (info.size > limit) {
    throw new CommandError(
      'invalid_request',
      `文件过大（${info.size} B），${mimeType.startsWith('image/') ? '图片' : '文档'}上限 ${humanMegabytes(limit)}`,
    )
  }
  // 真实上限以读入缓冲为准：预检之后文件可能被替换，不能只信 stat。
  const content = await readFile(realSource)
  if (content.byteLength === 0 || content.byteLength > limit) {
    throw new CommandError('invalid_request', '文件为空或超出大小上限')
  }
  return {
    fileName,
    mimeType,
    base64: content.toString('base64'),
    size: content.byteLength,
  }
}
