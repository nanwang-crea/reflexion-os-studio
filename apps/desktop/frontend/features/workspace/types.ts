/** 右侧文件查看器中一个已打开的标签。path 为 workspace 相对路径。 */
export interface OpenFileTab {
  path: string
  /** 打开后定位到的行号（ResourceLink 跳转）；缺省不滚动。 */
  line?: number
  /** 同一路径重复定位时强制查看器重新应用 initialLine。 */
  nonce?: number
}

/** 外部资源点击进入面板的定位请求（App 级发起，nonce 使重复点击生效）。 */
export type WorkspaceOpenRequest =
  | { nonce: number; kind: 'file'; path: string; line?: number }
  | { nonce: number; kind: 'asset'; assetId: string }
