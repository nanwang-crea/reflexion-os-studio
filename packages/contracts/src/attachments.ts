import { z } from 'zod'

export const MAX_MESSAGE_ATTACHMENTS = 4
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_CHARS = 60_000
export const MAX_MESSAGE_DOCUMENT_CHARS = 120_000
export const TEXT_FILE_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'html',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'sh',
  'bash',
  'zsh',
  'sql',
  'vue',
  'svelte',
  'r',
  'tex',
] as const
export const ATTACHMENT_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  '.pdf',
  '.docx',
  ...TEXT_FILE_EXTENSIONS.map((extension) => `.${extension}`),
].join(',')
export const DocumentUploadSchema = z.object({
  sessionId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  base64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4)
    .refine(
      (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
      '文件编码无效',
    ),
})
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>
export const DocumentExtractionSchema = z.object({
  text: z.string().min(1).max(MAX_DOCUMENT_CHARS),
  format: z.enum(['text', 'pdf', 'docx']),
  pages: z.number().int().positive().optional(),
})
export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>
export const FilePartSchema = z.object({
  type: z.literal('file'),
  assetId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  extraction: DocumentExtractionSchema,
})
export type FilePart = z.infer<typeof FilePartSchema>
