import { z } from 'zod'

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_MESSAGE_IMAGES = 4
export const ImageMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
export const ImageUploadSchema = z.object({
  sessionId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: ImageMimeTypeSchema,
  base64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .refine(
      (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
      '图片编码无效',
    ),
})
export type ImageUpload = z.infer<typeof ImageUploadSchema>
