import {
  MAX_MESSAGE_IMAGES,
  ImageMimeTypeSchema,
  type ContentPart,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { CommandError } from '../errors.js'

export function userContentParts(
  store: Store,
  sessionId: string,
  content: string,
  ids: string[] = [],
): ContentPart[] {
  if (ids.length > MAX_MESSAGE_IMAGES || new Set(ids).size !== ids.length) {
    throw new CommandError(
      'invalid_request',
      '每条消息最多 4 张图片，且不能重复',
    )
  }
  const parts: ContentPart[] = content ? [{ type: 'text', text: content }] : []
  for (const assetId of ids) {
    const asset = store.assetStore.get(assetId)
    if (
      !asset ||
      asset.sessionId !== sessionId ||
      asset.preview !== 'ready' ||
      !ImageMimeTypeSchema.safeParse(asset.mimeType).success
    ) {
      throw new CommandError(
        'invalid_request',
        '图片不存在、不可用或不属于当前会话',
      )
    }
    parts.push({ type: 'image', assetId, mimeType: asset.mimeType })
  }
  return parts
}
