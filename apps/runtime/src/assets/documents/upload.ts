import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DocumentUploadSchema,
  MAX_DOCUMENT_BYTES,
  type DocumentUpload,
  type AssetRef,
} from '@reflexion-os-studio/contracts'
import { hasSensitivePathSegments } from '../../agent/permissions/escalation.js'
import { CommandError } from '../../agent/errors.js'
import type { Store } from '../../store/index.js'
import { nowIso } from '../../store/shared.js'
import { extractDocument } from './extract.js'

export async function uploadDocumentAsset(
  store: Store,
  dataDir: string,
  raw: DocumentUpload,
): Promise<AssetRef> {
  const parsed = DocumentUploadSchema.safeParse(raw)
  if (!parsed.success)
    throw new CommandError('invalid_request', '文件格式或大小无效')
  const input = parsed.data
  if (
    /[\\/\x00-\x1f]/.test(input.fileName) ||
    hasSensitivePathSegments(input.fileName)
  )
    throw new CommandError('invalid_request', '禁止上传敏感文件或无效文件名')
  const session = store.sessions.get(input.sessionId)
  if (!session) throw new CommandError('not_found', '会话不存在')
  const bytes = Buffer.from(input.base64, 'base64')
  if (
    !bytes.length ||
    bytes.length > MAX_DOCUMENT_BYTES ||
    bytes.toString('base64') !== input.base64
  )
    throw new CommandError('invalid_request', '文件为空、编码无效或超过 10MB')
  const extraction = await extractDocument(input.fileName, bytes)
  const mimeType =
    extraction.format === 'pdf'
      ? 'application/pdf'
      : extraction.format === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : extraction.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/plain'
  const asset: AssetRef = {
    assetId: randomUUID(),
    projectId: session.projectId,
    sessionId: session.id,
    uri: '',
    kind: 'file',
    mimeType,
    size: bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex'),
    fileName: input.fileName,
    runId: null,
    nodeRunId: null,
    createdBy: 'user',
    createdAt: nowIso(),
    metadata: { type: 'message-document', extraction },
    preview: 'ready',
  }
  asset.uri = `asset://${asset.assetId}`
  const dir = join(dataDir, 'assets', 'sessions', session.id)
  const dest = join(dir, asset.assetId)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(dest, bytes, { flag: 'wx' })
    if (!store.sessions.get(session.id))
      throw new CommandError('not_found', '会话已删除')
    return store.assetStore.create(asset)
  } catch (error) {
    await rm(dest, { force: true }).catch(() => {})
    throw error
  }
}
