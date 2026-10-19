import {
  ImageUploadSchema,
  DocumentUploadSchema,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'
import { requireString, type CommandHandler } from '../command-utils.js'
import { readDroppedLocalFile } from './drop/local-file.js'

/**
 * Asset 命令（Phase 1B 第二阶段）：导入（工作区相对路径 → Store 复制+落元数据）、
 * 列表、读内容（文本直返 / 图片 base64）、删除。仅预览、定位与复制引用，
 * 导出/下载/系统应用打开属后续阶段。
 *
 * `asset.read_dropped_file` 是系统文件管理器拖入窗口的专用入口：把用户拖入的
 * 绝对路径读成 base64 交给输入框当待上传附件（安全边界见 drop/local-file.ts），
 * 随后仍走 upload_document / upload_image 落库，不产生第二套存储。
 */
export const assetCommandHandlers: Record<string, CommandHandler> = {
  'asset.upload_document': async (p, { assets }) => ({
    asset: await assets.uploadDocument(DocumentUploadSchema.parse(p)),
  }),
  'asset.upload_image': async (p, { assets }) => ({
    asset: await assets.uploadImage(ImageUploadSchema.parse(p)),
  }),
  'asset.read_dropped_file': async (p) =>
    readDroppedLocalFile(requireString(p, 'path')),
  'asset.import': async (p, { assets }) => ({
    asset: await assets.importWorkspace(
      requireString(p, 'projectId'),
      requireString(p, 'path'),
    ),
  }),
  'asset.list': (p, { assets }) => ({
    assets: assets.list(requireString(p, 'projectId')),
  }),
  'asset.read': async (p, { assets }) =>
    assets.read(requireString(p, 'assetId')),
  'asset.delete': async (p, { assets, store, agent }) => {
    const assetId = requireString(p, 'assetId')
    const asset = store.assetStore.get(assetId)
    if (
      asset?.sessionId &&
      agent
        .listQueue(asset.sessionId)
        .items.some((item) =>
          (item.attachmentAssetIds ?? item.imageAssetIds)?.includes(assetId),
        )
    ) {
      throw new CommandError('invalid_request', '附件正在排队发送，不能删除')
    }
    return { removed: await assets.delete(assetId) }
  },
}
