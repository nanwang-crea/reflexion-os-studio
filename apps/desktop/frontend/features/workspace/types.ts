/** 右侧文件查看器中一个已打开的标签。 */
export interface OpenFileTab {
  path: string
  line?: number
  nonce?: number
  mode?: 'content' | 'diff'
  staged?: boolean
  oldPath?: string
  source?: 'git' | 'chat'
  before?: string
  after?: string
}

/**
 * 标签唯一标识：content 标签用 path，diff 标签用 `${path}#diff`。
 * 同一路径可能同时存在 content 与 diff 两个标签，path 不足以区分。
 */
export function tabIdOf(tab: OpenFileTab): string {
  return tab.mode === 'diff' ? `${tab.path}#diff` : tab.path
}

export type WorkspaceOpenRequest =
  | { nonce: number; kind: 'file'; path: string; line?: number }
  | { nonce: number; kind: 'asset'; assetId: string }
