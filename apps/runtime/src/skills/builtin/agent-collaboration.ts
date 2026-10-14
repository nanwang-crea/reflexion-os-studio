import type { SkillDefinition } from '../types.js'

export const AGENT_COLLABORATION_SKILL: SkillDefinition = {
  manifest: {
    id: 'agent-collaboration',
    name: 'Agent 协作',
    version: '1.0.0',
    description:
      '根据用户目标规划、选择角色并动态协作，按依赖交接，独立验证并交付；不要求用户手动编排。',
    tools: ['task', 'manage_plan', 'ask_user'],
    argumentHint: '<目标>',
    whenToUse: '复杂任务有适合独立执行的实现、调研或审阅部分时。',
    license: null,
    metadata: {},
  },
  instructions: `
# 对话驱动的协作

1. 从用户目标确定交付物和完成标准。只有缺少会改变结果的关键输入时提问，其余自行判断。
2. 简单任务直接执行；复杂任务用 manage_plan 记录计划，持续更新实际进展。
3. 参考可用角色模板的领域与职责选用 templateId；模板只是指导，模型配置由用户设定。
4. 每次 task 给出明确目标、边界、必要上下文、依赖和交付要求。父任务缺少的资料不会自动出现在子任务中。
5. 无依赖的任务可以并行，有依赖的任务等前序成果后再交接。共享目录写入由 Runtime 协调，不能自行创建越界授权或假装有独立 worktree。
6. 按工具审批和结构化提问等待用户。拒绝后不能委派别人绕过。
7. 验证子 Agent 的结果与证据。重要实现或文稿安排独立审阅；修复后重验。审阅职责可选模板，也可动态创建。
8. 达到完成标准才收尾；如仍有阻塞，交代已完成成果与需要用户解决的具体事项。
9. 用户希望复用方法时，提炼角色选择、交接、检查和完成标准。不要复制整段执行记录、路径、临时任务或机密；保存前让用户审阅。
`.trim(),
}
