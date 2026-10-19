import type { DocumentUpload } from '@reflexion-os-studio/runtime-client'
import type { AssetRef } from '@reflexion-os-studio/runtime-client'
import type { ImageUpload } from '@reflexion-os-studio/runtime-client'
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

export function uploadImage(input: ImageUpload): Promise<{ asset: AssetRef }> {
  return request('asset.upload_image', input)
}

export function uploadDocument(
  input: DocumentUpload,
): Promise<{ asset: AssetRef }> {
  return request('asset.upload_document', input)
}

/** 拖入文件的字节、MIME 与文件名（base64 与输入框 File 构造同格式）。 */
export interface DroppedLocalFilePayload {
  fileName: string
  mimeType: string
  base64: string
  size: number
}

/**
 * 读取用户从系统文件管理器拖入窗口的本地文件（绝对路径）。
 * 路径校验、凭据 no-read 与大小限制在 Runtime 侧执行，前端不做旁路判断。
 */
export function readDroppedFile(
  path: string,
): Promise<DroppedLocalFilePayload> {
  return request<DroppedLocalFilePayload>('asset.read_dropped_file', { path })
}
