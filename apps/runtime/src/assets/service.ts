import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
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

  /**
   * 从工作区导入文件为 Asset：复制进 Store、计算 hash、落元数据。
   * 安全边界：先对工作区根与源文件分别 realpath 解析符号链接，再按路径组件
   * 做 containment 校验，拒绝 workspace 内指向外部的符号链接以及前缀碰撞
   * （如 /ws/proj 🆚 /ws/project）。复制或落库任一环节失败时补偿删除已复制的
   * 内容文件，避免留下无元数据的孤儿文件。
   */
  async importWorkspace(projectId: string, path: string): Promise<AssetRef> {
    const project = this.store.projects.get(projectId)
    if (!project || project.folderPath === '') {
      throw new CommandError(
        'invalid_request',
        '项目未关联本地文件夹，无法导入',
      )
    }
    assertWorkspacePath(path)
    const rawRoot = resolve(project.folderPath)
    const rawSource = resolve(rawRoot, path)
    // 组件级 containment：拒绝 .. 逃逸与前缀碰撞（/ws/a 不允许命中 /ws/ab）。
    if (!isWithin(rawRoot, rawSource)) {
      throw new CommandError('invalid_request', '导入路径超出工作区范围')
    }
    // realpath 解析根与目标：workspace 内指向外部的符号链接会被解析到外部而拒绝；
    // 仅指向 workspace 内部的链接解析后仍在根内，被视为合法。
    const realRoot = await realpath(rawRoot).catch(() => rawRoot)
    const realSource = await realpath(rawSource).catch(() => null)
    if (realSource === null) {
      throw new CommandError('invalid_request', `文件不存在：${path}`)
    }
    if (!isWithin(realRoot, realSource)) {
      throw new CommandError(
        'invalid_request',
        '导入路径超出工作区范围（符号链接越界）',
      )
    }
    const info = await lstat(realSource).catch(() => null)
    if (info === null || !info.isFile()) {
      throw new CommandError('invalid_request', `文件不存在：${path}`)
    }
    if (info.size > MAX_IMPORT_BYTES) {
      throw new CommandError(
        'invalid_request',
        `文件过大（${info.size} B），导入上限 64MB`,
      )
    }
    const fileName = basename(realSource)
    const content = await readFile(realSource)
    const assetId = randomUUID()
    const asset: AssetRef = {
      assetId,
      projectId,
      uri: `asset://${assetId}`,
      kind: kindOf(detectMime(fileName)),
      mimeType: detectMime(fileName),
      size: info.size,
      hash: createHash('sha256').update(content).digest('hex'),
      fileName,
      runId: null,
      nodeRunId: null,
      createdBy: 'user',
      createdAt: nowIso(),
      metadata: { sourcePath: path },
      preview: 'ready',
    }
    const destPath = this.pathFor(projectId, asset.assetId)
    await mkdir(this.dirFor(projectId), { recursive: true })
    await copyFile(realSource, destPath).catch(async () => {
      // 复制中途失败：清掉残留半文件，避免孤儿。
      await rm(destPath, { force: true }).catch(() => {})
      throw new CommandError('invalid_request', '导入失败：无法复制文件')
    })
    try {
      return this.store.assetStore.create(asset)
    } catch (error) {
      // 元数据落库失败：补偿删除已复制文件，保持 Store 与库一致。
      await rm(destPath, { force: true }).catch(() => {})
      throw error
    }
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

  /**
   * 删除 Asset：先清内容文件，再删 DB 行。
   * DOS（like）失败时保留 DB 行（内容仍在，状态一致）并以 CommandError 上抛；
   * DB 删行失败/行已失时保留孤立内容文件，交由启动巡检补偿清理。
   */
  async delete(assetId: string): Promise<boolean> {
    const asset = this.store.assetStore.get(assetId)
    if (asset === null) return false
    const destPath = this.pathFor(asset.projectId, asset.assetId)
    try {
      await rm(destPath, { force: true })
    } catch {
      throw new CommandError('delete_failed', `删除内容文件失败：${assetId}`)
    }
    return this.store.assetStore.delete(assetId)
  }

  /**
   * 启动巡检/补偿清理：与 Store 各领域 recover 方法同期调用。
   * 1) 删除「有内容文件但无 DB 行」的孤立文件（此前导入复制成功但落库失败残留）；
   * 2) 把「有 DB 行但内容文件缺失」的 Asset 标记为 failed（此前导出/崩溃/外部删除）。
   */
  async recover(): Promise<void> {
    const root = join(this.dataDir, 'assets')
    await mkdir(root, { recursive: true }).catch(() => {})
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const projectDir = join(root, dir.name)
      const files = await readdir(projectDir).catch(() => [])
      for (const assetId of files) {
        if (this.store.assetStore.get(assetId) === null) {
          await rm(join(projectDir, assetId), { force: true }).catch(() => {})
        }
      }
    }
    for (const asset of this.store.assetStore.all()) {
      const info = await stat(
        this.pathFor(asset.projectId, asset.assetId),
      ).catch(() => null)
      if (info === null || !info.isFile()) {
        if (asset.preview !== 'failed') {
          this.store.assetStore.setPreview(asset.assetId, 'failed')
        }
      }
    }
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

/**
 * 组件级 containment：用 path.relative 判定 target 是否位于 root 之下。
 * 比字符串前缀更严格——`/ws/proj` 不会误命中 `/ws/project`（前缀碰撞），
 * `..` 逃逸与跨盘符（Windows）也会被 relative/isAbsolute 拒绝。
 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel)
}
