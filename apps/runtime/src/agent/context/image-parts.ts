import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_DOCUMENT_CHARS,
  DocumentExtractionSchema,
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
  if (
    ids.length > MAX_MESSAGE_ATTACHMENTS ||
    new Set(ids).size !== ids.length
  ) {
    throw new CommandError(
      'invalid_request',
      '每条消息最多 4 个文件（含图片），且不能重复',
    )
  }
  const parts: ContentPart[] = content ? [{ type: 'text', text: content }] : []
  let documentChars = 0
  for (const assetId of ids) {
    const asset = store.assetStore.get(assetId)
    if (
      asset?.sessionId === sessionId &&
      asset.preview === 'ready' &&
      asset.metadata.type === 'message-document'
    ) {
      const extraction = DocumentExtractionSchema.safeParse(
        asset.metadata.extraction,
      )
      if (!extraction.success)
        throw new CommandError('invalid_request', '附件解析结果不可用')
      documentChars += extraction.data.text.length
      if (documentChars > MAX_MESSAGE_DOCUMENT_CHARS)
        throw new CommandError(
          'invalid_request',
          '附件提取文字合计超过 120000 字符，请分批发送',
        )
      parts.push({
        type: 'file',
        assetId,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
        extraction: extraction.data,
      })
      continue
    }
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

/** Merge legacy image-only clients without allowing a second attachment budget. */
export function messageAttachmentIds(params: {
  attachmentAssetIds?: string[]
  imageAssetIds?: string[]
}): string[] | undefined {
  if (
    params.attachmentAssetIds === undefined &&
    params.imageAssetIds === undefined
  )
    return undefined
  return [...(params.attachmentAssetIds ?? []), ...(params.imageAssetIds ?? [])]
}
