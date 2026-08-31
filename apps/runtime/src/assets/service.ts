import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { AssetKind, AssetRef } from '@reflexion-os-studio/contracts'
import { CommandError } from '../agent/errors.js'
import { nowIso } from '../store/shared.js'
import type { Store } from '../store/index.js'

/** 文本类内容直返上限：防一次性吃满协议与上下文。 */
const MAX_TEXT_BYTES = 1024 * 1024
/** 图片 base64 预览上限(≈8MB 原文件)。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 导入源文件上限:大于该值拒绝导入,避免大文件复制拖垮 Runtime。 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** 扩展名 → mime 的保守映射;未知归 application/octet-stream(file)。 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.css': 'text/plain',
  '.html': 'text/plain',
  '.xml': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.csv': 'text/plain',
  '.py': 'text/plain',
  '.rs': 'text/plain',
  '.go': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.sh': 'text/plain',
  '.sql': 'text/plain',
  '.log': 'text/plain',
}

function detectMime(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function kindOf(mimeType: string): AssetKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('text/')) return 'text'
  // JSON/XML 等 application 文本也按文本预览。
  if (
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/yaml'
  ) {
    return 'text'
  }
  return 'file'
}

/**
 * Asset 存储服务：内容文件与元数据的读写入口（Phase 1B 只读预览闭环）。
 * 内容按项目隔离存数据目录 assets/<projectId>/<assetId>，导入仅接受工作区
 * 相对路径（与 file.read 同一安全边界）；导出/下载/系统应用打开属后续阶段。
 */
export class AssetService {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  private dirFor(projectId: string): string {
    return join(this.dataDir, 'assets', projectId)
  }

  private pathFor(projectId: string, assetId: string): string {
    return join(this.dirFor(projectId), assetId)
  }

  /** 从工作区导入文件为 Asset：复制进 Store、计算 hash、落元数据。 */
  async importWorkspace(projectId: string, path: string): Promise<AssetRef> {
    const project = this.store.projects.get(projectId)
    if (!project || project.folderPath === '') {
      throw new CommandError(
        'invalid_request',
        '项目未关联本地文件夹，无法导入',
      )
    }
    assertWorkspacePath(path)
    const source = resolve(project.folderPath, path)
    if (!source.startsWith(resolve(project.folderPath))) {
      throw new CommandError('invalid_request', '导入路径超出工作区范围')
    }
    const info = await stat(source).catch(() => null)
    if (info === null || !info.isFile()) {
      throw new CommandError('invalid_request', `文件不存在：${path}`)
    }
    if (info.size > MAX_IMPORT_BYTES) {
      throw new CommandError(
        'invalid_request',
        `文件过大（${info.size} B），导入上限 64MB`,
      )
    }
    const content = await readFile(source)
    const assetId = randomUUID()
    const asset: AssetRef = {
      assetId,
      projectId,
      uri: `asset://${assetId}`,
      kind: kindOf(detectMime(basename(path))),
      mimeType: detectMime(basename(path)),
      size: info.size,
      hash: createHash('sha256').update(content).digest('hex'),
      fileName: basename(path),
      runId: null,
      nodeRunId: null,
      createdBy: 'user',
      createdAt: nowIso(),
      metadata: { sourcePath: path },
      preview: 'ready',
    }
    await mkdir(this.dirFor(projectId), { recursive: true })
    await copyFile(source, this.pathFor(projectId, asset.assetId))
    return this.store.assetStore.create(asset)
  }

  list(projectId: string): AssetRef[] {
    return this.store.assetStore.list(projectId)
  }

  /** 读取内容:文本直返,图片返回 base64,其余 kind 不返回内容。 */
  async read(
    assetId: string,
  ): Promise<{ asset: AssetRef; text: string | null; base64: string | null }> {
    const asset = this.store.assetStore.get(assetId)
    if (asset === null) {
      throw new CommandError('not_found', `asset not found: ${assetId}`)
    }
    if (asset.preview !== 'ready' || asset.kind === 'file') {
      return { asset, text: null, base64: null }
    }
    const content = await readFile(
      this.pathFor(asset.projectId, asset.assetId),
    ).catch(() => null)
    if (content === null) {
      return {
        asset: { ...asset, preview: 'failed' },
        text: null,
        base64: null,
      }
    }
    if (asset.kind === 'image') {
      if (content.byteLength > MAX_IMAGE_BYTES) {
        return { asset, text: null, base64: null }
      }
      return { asset, text: null, base64: content.toString('base64') }
    }
    if (asset.kind === 'text' && content.byteLength <= MAX_TEXT_BYTES) {
      return { asset, text: content.toString('utf8'), base64: null }
    }
    return { asset, text: null, base64: null }
  }

  /** 删除 Asset:先清行再删内容文件;内容缺失视同成功。 */
  async delete(assetId: string): Promise<boolean> {
    const asset = this.store.assetStore.get(assetId)
    if (asset === null) return false
    this.store.assetStore.delete(assetId)
    await rm(this.pathFor(asset.projectId, asset.assetId), { force: true })
    return true
  }
}

function assertWorkspacePath(path: string): void {
  if (path.trim() === '') {
    throw new CommandError('invalid_request', '路径不能为空')
  }
  if (path.includes('..')) {
    throw new CommandError('invalid_request', '路径不允许包含 ..')
  }
  if (/^[\\/]/.test(path)) {
    throw new CommandError('invalid_request', '路径必须是工作区相对路径')
  }
}
