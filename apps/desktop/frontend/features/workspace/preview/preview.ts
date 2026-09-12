/**
 * 文件预览路由：按扩展名决定激活标签使用哪种渲染器。
 * markdown → 富预览（MarkdownCore 内核）；binary → 占位提示（防乱码）；
 * 其余按纯文本处理（回落 ContentView / Monaco）。
 */

export type PreviewKind = 'markdown' | 'binary' | 'text'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

/**
 * 以占位提示替代乱码展示的类型。图片预览属后续迭代（需 read_file 提供
 * base64 编码契约），当前仅阻止把二进制内容当文本渲染。
 */
const BINARY_EXTENSIONS = new Set([
  // 图片
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'avif',
  'svg',
  'heic',
  // 音视频
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'aac',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  // 文档 / 压缩包 / 字体 / 可执行与数据文件
  'pdf',
  'zip',
  'tar',
  'gz',
  'tgz',
  'rar',
  '7z',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'wasm',
  'class',
  'pyc',
  'db',
  'sqlite',
  'sqlite3',
])

export function getPreviewKind(path: string): PreviewKind {
  const fileName = path.split('/').pop() ?? path
  const dot = fileName.lastIndexOf('.')
  // 无扩展名（或 .gitignore 这类点开头的隐藏文件）按文本处理。
  if (dot <= 0) return 'text'
  const ext = fileName.slice(dot + 1).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (BINARY_EXTENSIONS.has(ext)) return 'binary'
  return 'text'
}

const KB = 1024
const MB = 1024 * KB

/** 富预览首批渲染行数（首屏预算；后续按批触底增量加载）。 */
export const MD_PREVIEW_FIRST_BATCH_LINES = 2000

/** 富预览触底追加批行数（Rust 侧 MAX_READ_LIMIT=10000 会再钳制，留余量）。 */
export const MD_PREVIEW_BATCH_LINES = 2000

/** 富预览总行数硬上限：超出停止增量加载并提示（源码视图不受此限）。 */
export const MD_PREVIEW_MAX_LINES = 100_000

/** 富预览文件大小上限（与 Rust file.read 整读上限一致）：超过则读取直接
 *  失败，预览给出引导提示；源码视图同样受限（后端不支持字节分段）。 */
export const MD_PREVIEW_MAX_BYTES = 2 * MB

/** 文件大小的人类可读展示（B/KB/MB）。 */
export function formatBytes(size: number): string {
  if (size < KB) return `${size} B`
  if (size < MB) {
    const kb = size / KB
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`
  }
  const mb = size / MB
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/**
 * 读取失败的引导文案：2MB 整读上限（富预览与源码视图同受此限，
 * 后端不支持字节分段）与非 UTF-8 文件。
 */
export function friendlyReadError(message: string): string {
  if (message.includes('file too large')) {
    return `文件超过读取上限（${formatBytes(MD_PREVIEW_MAX_BYTES)}），无法预览。`
  }
  if (message.includes('not valid UTF-8')) {
    return '文件不是有效的 UTF-8 文本，无法预览。'
  }
  return message
}
