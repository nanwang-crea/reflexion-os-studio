/** 右侧文件查看器中一个已打开的标签。 */
export interface OpenFileTab {
  path: string
  line?: number
  nonce?: number
  mode?: 'content' | 'diff'
  staged?: boolean
  oldPath?: string
  source?: 'git' | 'chat'
}

export type WorkspaceOpenRequest =
  | { nonce: number; kind: 'file'; path: string; line?: number }
  | { nonce: number; kind: 'asset'; assetId: string }
