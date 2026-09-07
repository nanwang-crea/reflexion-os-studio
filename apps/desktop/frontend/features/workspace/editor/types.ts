/** 单文件 Monaco 编辑器 Props。 */
export interface MonacoEditorProps {
  projectId: string
  path: string
  initialLine?: number
  readOnly?: boolean
  onClose: () => void
  onContentChange?: (content: string) => void
}

/** Monaco DiffEditor Props。 */
export interface MonacoDiffEditorProps {
  projectId: string
  path: string
  oldPath?: string
  staged?: boolean
  source?: 'git' | 'chat'
  before?: string
  after?: string
  onClose: () => void
}

/** 编辑器配置常量。 */
export const EDITOR_CONFIG = {
  /** 超过此大小进入只读模式（字节）。 */
  EDIT_READ_ONLY_THRESHOLD: 500 * 1024, // 500KB — matches Rust file.read limit
} as const
