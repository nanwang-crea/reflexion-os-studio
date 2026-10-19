import {
  MAX_DOCUMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  DocumentUploadSchema,
  ImageUploadSchema,
  TEXT_FILE_EXTENSIONS,
} from '@reflexion-os-studio/runtime-client'
import { deleteAsset, uploadDocument, uploadImage } from '../../../api/assets'
import {
  readImageFile,
  validateImageFile,
} from '../images/upload-message-images'

export function validateAttachmentFile(file: File): void {
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (
    /^(\.env|id_rsa|id_ed25519)|^(credentials|secrets)\.json$|\.(pem|key|token)$/i.test(
      file.name,
    )
  )
    throw new Error('禁止上传凭据或敏感文件')
  if (file.type.startsWith('image/')) return validateImageFile(file)
  if (
    !['pdf', 'docx', 'xlsx', ...TEXT_FILE_EXTENSIONS].some(
      (item) => item === extension,
    )
  )
    throw new Error('仅支持图片、文本/代码、PDF、DOCX 与 XLSX；不支持 DOC/XLS')
  if (!file.size || file.size > MAX_DOCUMENT_BYTES)
    throw new Error('每个文档需小于 10MB，且不能为空')
}

export async function uploadMessageFiles(
  sessionId: string,
  files: File[],
): Promise<string[]> {
  if (files.length > MAX_MESSAGE_ATTACHMENTS)
    throw new Error('每条消息最多 4 个文件（含图片）')
  files.forEach(validateAttachmentFile)
  const ids: string[] = []
  try {
    for (const file of files) {
      const base64 = await readImageFile(file)
      const { asset } = file.type.startsWith('image/')
        ? await uploadImage(
            ImageUploadSchema.parse({
              sessionId,
              fileName: file.name,
              mimeType: file.type,
              base64,
            }),
          )
        : await uploadDocument(
            DocumentUploadSchema.parse({
              sessionId,
              fileName: file.name,
              base64,
            }),
          )
      ids.push(asset.assetId)
    }
    return ids
  } catch (error) {
    await Promise.allSettled(ids.map(deleteAsset))
    throw error
  }
}
