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
  /** chat 通道（内容快照直传）的二进制提示：true 时 diff 呈现二进制占位。 */
  binary?: boolean
  /** chat 通道的截断提示：true 时呈现"内容过长已截断"标记。 */
  truncated?: boolean
  /** diff 头部徽标文案覆盖（如历史对比），优先于按 source 推导的默认文案。 */
  label?: string
}

/** openDiff 选项：GitChanges / GitHistory / Chat 卡片共用的 diff 打开参数。 */
export interface DiffOpenOptions {
  staged?: boolean
  oldPath?: string
  source?: 'git' | 'chat'
  before?: string
  after?: string
  binary?: boolean
  truncated?: boolean
  label?: string
}

/** 打开右侧 diff 的回调签名（App → Sidebar → ProjectFiles → Git* 透传链统一）。 */
export type OpenDiffHandler = (path: string, options: DiffOpenOptions) => void

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
