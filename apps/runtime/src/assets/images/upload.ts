import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ImageUploadSchema,
  MAX_IMAGE_BYTES,
  type ImageUpload,
  type AssetRef,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../../agent/errors.js'
import type { Store } from '../../store/index.js'
import { nowIso } from '../../store/shared.js'

/** Bytes come from the user's browser File, never an arbitrary filesystem path. */
export async function uploadImageAsset(
  store: Store,
  dataDir: string,
  raw: ImageUpload,
): Promise<AssetRef> {
  const parsed = ImageUploadSchema.safeParse(raw)
  if (!parsed.success)
    throw new CommandError('invalid_request', '图片格式或大小无效')
  const input = parsed.data
  const session = store.sessions.get(input.sessionId)
  if (!session) throw new CommandError('not_found', '会话不存在')
  const content = Buffer.from(input.base64, 'base64')
  if (
    content.length > MAX_IMAGE_BYTES ||
    content.toString('base64') !== input.base64
  ) {
    throw new CommandError('invalid_request', '图片过大或编码无效（上限 4MB）')
  }
  const mimeType = detectImageMime(content)
  if (!mimeType || mimeType !== input.mimeType) {
    throw new CommandError('invalid_request', '图片内容与格式不符')
  }
  const asset: AssetRef = {
    assetId: randomUUID(),
    projectId: session.projectId,
    sessionId: session.id,
    uri: '',
    kind: 'image',
    mimeType,
    size: content.length,
    hash: createHash('sha256').update(content).digest('hex'),
    fileName: input.fileName,
    runId: null,
    nodeRunId: null,
    createdBy: 'user',
    createdAt: nowIso(),
    metadata: {},
    preview: 'ready',
  }
  asset.uri = `asset://${asset.assetId}`
  const dir = join(dataDir, 'assets', 'sessions', session.id)
  const dest = join(dir, asset.assetId)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(dest, content, { flag: 'wx' })
    // The session may have been removed while disk IO yielded.
    if (!store.sessions.get(session.id))
      throw new CommandError('not_found', '会话已删除')
    return store.assetStore.create(asset)
  } catch (error) {
    await rm(dest, { force: true }).catch(() => {})
    throw error
  }
}

export function detectImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png'
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (
    bytes.length >= 13 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  )
    return 'image/gif'
  return null
}
