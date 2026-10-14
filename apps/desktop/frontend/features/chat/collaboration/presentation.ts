/** Display labels shared by the graph and its accessible task/Agent list. */
const STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  created: '准备中',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  skipped: '已跳过',
  awaiting_approval: '待审批',
  awaiting_user_input: '待回答',
}
export function collaborationStatus(status: string): string {
  return STATUS_LABELS[status] ?? status
}
