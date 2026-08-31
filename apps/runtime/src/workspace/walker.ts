import { lstat, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** 与 Rust 侧 walk 一致的资源上限，防止超大规模工作区把索引拖死。 */
export const MAX_INDEX_FILES = 20_000
const MAX_INDEX_DEPTH = 32

/** 默认忽略目录：版本控制、依赖、构建产物与缓存。 */
export const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-frontend',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.turbo',
])

export interface ScanStats {
  files: number
  dirs: number
  totalBytes: number
  /** 按扩展名聚合，files 降序；无扩展名记为 "(none)"。 */
  extStats: { ext: string; files: number; bytes: number }[]
  /** 达到文件数/深度上限：结果不完整，调用方如实展示。 */
  truncated: boolean
}

/**
 * 工作区遍历：stat-only，不读文件内容；跳过符号链接（目录防逃逸、文件防
 * 读到工作区外），忽略 IGNORED_DIR_NAMES。按目录分派（不递归 await 嵌套），
 * 不会长时间占用事件循环。AbortSignal 在中途任何节点都立即生效。
 */
export async function scanWorkspace(
  root: string,
  signal: AbortSignal,
  onProgress?: (files: number, dirs: number) => void,
): Promise<ScanStats> {
  let files = 0
  let dirs = 0
  let totalBytes = 0
  let truncated = false
  const extMap = new Map<string, { files: number; bytes: number }>()

  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  const pushProgress = (): void => {
    onProgress?.(files, dirs)
  }

  while (queue.length > 0) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const { dir, depth } = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 无权限/已被删除的目录直接跳过，索引不强求完整。
    }
    for (const entry of entries) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue
        if (depth + 1 > MAX_INDEX_DEPTH) {
          truncated = true
          continue
        }
        dirs += 1
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (files >= MAX_INDEX_FILES) {
        truncated = true
        break
      }
      files += 1
      let size = 0
      try {
        size = (await lstat(join(dir, entry.name))).size
      } catch {
        size = 0
      }
      totalBytes += size
      const ext = extname(entry.name).toLowerCase() || '(none)'
      const bucket = extMap.get(ext) ?? { files: 0, bytes: 0 }
      bucket.files += 1
      bucket.bytes += size
      extMap.set(ext, bucket)
    }
    // 每个目录处理完上报一次进度（调用方决定是否限流）。
    pushProgress()
  }

  const extStats = [...extMap.entries()]
    .map(([ext, stats]) => ({ ext, ...stats }))
    .sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext))
  return { files, dirs, totalBytes, extStats, truncated }
}
