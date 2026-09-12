import type { MonacoSurfaceHandle } from './MonacoSurface'

/** 编辑内核脏状态上抛（仅脏/净切换时触发）。 */
export interface MonacoEditorProps {
  projectId: string
  path: string
  initialLine?: number
  readOnly?: boolean
  onClose: () => void
  onContentChange?: (content: string) => void
  onDirtyChange?: (path: string, dirty: boolean) => void
  /** 注册 surface 句柄 getter（null 注销）；getter 调用时才解引用，规避闭包陈旧。 */
  registerSurface?: (
    path: string,
    getter: (() => MonacoSurfaceHandle | null) | null,
  ) => void
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
