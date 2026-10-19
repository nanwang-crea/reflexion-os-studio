import { DocumentUploadSchema, MAX_DOCUMENT_BYTES } from '../attachments.js'
import { z } from 'zod'
import { ImageUploadSchema } from '../images.js'
import { AssetRefSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const assetCommands = {
  'asset.upload_document': {
    params: DocumentUploadSchema.extend({ requestId: RequestIdSchema }),
    result: z.object({ asset: AssetRefSchema }),
  },
  'asset.upload_image': {
    params: ImageUploadSchema.extend({ requestId: RequestIdSchema }),
    result: z.object({ asset: AssetRefSchema }),
  },
  'asset.import': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      // 工作区相对路径（与 file.read 同一安全边界：相对、无 ..）。
      path: z.string().min(1),
    }),
    result: z.object({ asset: AssetRefSchema }),
  },
  // 系统文件管理器拖入窗口的专用入口：把用户拖入的绝对路径读成 base64 字节，
  // 交给输入框当「待上传附件」（与选择器/粘贴同一条 add → upload 链路，不落
  // Asset Store）。路径来自用户手势而非模型，但 Runtime 侧仍强制 no-read 清单、
  // realpath 落盘校验、普通文件与按类型大小上限，见
  // apps/runtime/src/assets/drop/local-file.ts。
  'asset.read_dropped_file': {
    params: z.object({
      requestId: RequestIdSchema,
      path: z.string().min(1).max(4096),
    }),
    result: z.object({
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1),
      base64: z
        .string()
        .min(4)
        .max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4),
      size: z.number().int().nonnegative(),
    }),
  },
  'asset.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ assets: z.array(AssetRefSchema) }),
  },
  'asset.read': {
    params: z.object({
      requestId: RequestIdSchema,
      assetId: z.string().min(1),
    }),
    // 文本类直返文本；图片返回 base64；不支持预览的 kind 两者皆 null。
    result: z.object({
      asset: AssetRefSchema,
      text: z.string().nullable(),
      base64: z.string().nullable(),
    }),
  },
  'asset.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      assetId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  // 集成终端：用户本机 shell，不经 Agent 通道。单输入批次 ≤8 KiB（spec §6）
  // 已在 runtime 服务层（terminal_input_batch_too_large 快拒）与 Rust 入队前
  // （invalid_request）双层强制（终审 #3），契约保持宽松（write.data 不在
  // schema 层限长）。
}
