import { createHash } from 'node:crypto'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import { AssetService } from '../../assets/service.js'
import { detectImageMime } from '../../assets/images/upload.js'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'

/** Resolve only images retained by compaction; bytes never enter checkpoints. */
export async function resolveModelImages(
  store: Store,
  sessionId: string,
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<ModelMessage[]> {
  const assets = new AssetService(store, store.dataDir)
  const result: ModelMessage[] = []
  let totalBytes = 0
  for (const message of messages) {
    signal.throwIfAborted()
    if (message.role !== 'user' || !message.images?.length) {
      result.push(message)
      continue
    }
    const images = []
    for (const image of message.images) {
      const meta = store.assetStore.get(image.assetId)
      if (
        !meta ||
        meta.sessionId !== sessionId ||
        meta.mimeType !== image.mimeType
      ) {
        throw new CommandError(
          'invalid_request',
          '历史图片不属于当前会话或格式不符',
        )
      }
      const { base64 } = await assets.read(image.assetId)
      signal.throwIfAborted()
      if (
        !base64 ||
        createHash('sha256')
          .update(Buffer.from(base64, 'base64'))
          .digest('hex') !== meta.hash ||
        detectImageMime(Buffer.from(base64, 'base64')) !== image.mimeType
      ) {
        throw new CommandError(
          'invalid_request',
          '历史图片已丢失或损坏，请重新上传',
        )
      }
      totalBytes += base64.length
      if (totalBytes > 24 * 1024 * 1024) {
        throw new CommandError(
          'invalid_request',
          '上下文图片总量过大，请新建会话',
        )
      }
      images.push({ ...image, base64 })
    }
    result.push({ ...message, images })
  }
  return result
}
