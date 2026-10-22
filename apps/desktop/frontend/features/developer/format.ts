export const number = (value: number | null | undefined) =>
  value == null ? '未知' : value.toLocaleString('zh-CN')
export const duration = (ms: number | null | undefined) =>
  ms == null
    ? '未知'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(2)} 秒`
export const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '未知'
export const statuses: Record<string, string> = {
  created: '已创建',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  pending: '排队中',
  awaiting_approval: '等待审批',
  awaiting_user_input: '等待回答',
}
export const purposes = {
  chat: '对话',
  title: '标题生成',
  summary: '上下文摘要',
}
