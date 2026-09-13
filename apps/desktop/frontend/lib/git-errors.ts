/** git 原始报错 → 中文引导文案（spec「错误处理」节）；未命中返回 null 走原文。 */
const GIT_ERROR_HINTS: Array<[RegExp, string]> = [
  [
    /non-fast-forward|fetch first|\[rejected\]/i,
    '远端有新提交，请先同步（↓更新）后再推送',
  ],
  [
    /nothing to commit|no changes added to commit/i,
    '没有已暂存的变更（nothing to commit）',
  ],
  [
    /would be overwritten|local changes/i,
    '本地未提交改动与目标分支冲突，请先提交或暂存',
  ],
  [
    /does not appear to be a git repository|no configured push/i,
    '未配置 origin 远端，可在分支下拉的『远端』区添加',
  ],
]

/** 匹配到已知 git 报错返回中文引导，未识别返回 null（调用方展示原文）。 */
export function classifyGitError(message: string): string | null {
  for (const [pattern, friendly] of GIT_ERROR_HINTS) {
    if (pattern.test(message)) return friendly
  }
  return null
}

/** Git 面板错误态：message 给主行（中文引导或原文），detail 给原文小字（可空）。 */
export interface GitErrorInfo {
  message: string
  detail: string | null
}

/** 任意异常 → GitErrorInfo：已知 git 报错给中文引导 + 原文详情；未识别原样展示。 */
export function errorInfoOf(error: unknown): GitErrorInfo {
  const raw = error instanceof Error ? error.message : String(error)
  const friendly = classifyGitError(raw)
  return friendly === null
    ? { message: raw, detail: null }
    : { message: friendly, detail: raw }
}
