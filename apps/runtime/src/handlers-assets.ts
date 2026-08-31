import { requireString, type CommandHandler } from './command-utils.js'

/**
 * Asset 命令（Phase 1B 第二阶段）：导入（工作区相对路径 → Store 复制+落元数据）、
 * 列表、读内容（文本直返 / 图片 base64）、删除。仅预览、定位与复制引用，
 * 导出/下载/系统应用打开属后续阶段。
 */
export const assetCommandHandlers: Record<string, CommandHandler> = {
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
  'asset.delete': async (p, { assets }) => ({
    removed: await assets.delete(requireString(p, 'assetId')),
  }),
}
