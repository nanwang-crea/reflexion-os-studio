import {
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  ImageUploadSchema,
} from '@reflexion-os-studio/runtime-client'
import { deleteAsset, uploadImage } from '../../../api/assets'

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export function validateImageFile(file: File): void {
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
  ) {
    throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片')
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES)
    throw new Error('每张图片需小于 4MB，且不能为空')
}

export async function uploadMessageImages(
  sessionId: string,
  files: File[],
): Promise<string[]> {
  if (files.length > MAX_MESSAGE_IMAGES)
    throw new Error('每条消息最多 4 张图片')
  const ids: string[] = []
  try {
    for (const file of files) {
      validateImageFile(file)
      const input = ImageUploadSchema.parse({
        sessionId,
        fileName: file.name,
        mimeType: file.type,
        base64: await readImageFile(file),
      })
      const { asset } = await uploadImage(input)
      ids.push(asset.assetId)
    }
    return ids
  } catch (error) {
    await Promise.allSettled(ids.map(deleteAsset))
    throw error
  }
}
