import type { AssetRef } from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/** 从工作区导入文件为 Asset（相对路径，受 workspace 边界约束）。 */
export function importAsset(
  projectId: string,
  path: string,
): Promise<{ asset: AssetRef }> {
  return request<{ asset: AssetRef }>('asset.import', { projectId, path })
}

/** 项目下全部 Asset（按创建时间倒序）。 */
export function listAssets(projectId: string): Promise<{ assets: AssetRef[] }> {
  return request<{ assets: AssetRef[] }>('asset.list', { projectId })
}

/** 读取 Asset 内容：文本直返 / 图片返回 base64；其余 kind 两者皆 null。 */
export function readAsset(
  assetId: string,
): Promise<{ asset: AssetRef; text: string | null; base64: string | null }> {
  return request<{
    asset: AssetRef
    text: string | null
    base64: string | null
  }>('asset.read', { assetId })
}

export function deleteAsset(assetId: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('asset.delete', { assetId })
}
