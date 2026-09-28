import { z } from 'zod'
import { AssetRefSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const assetCommands = {
  'asset.import': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      // 工作区相对路径（与 file.read 同一安全边界：相对、无 ..）。
      path: z.string().min(1),
    }),
    result: z.object({ asset: AssetRefSchema }),
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
