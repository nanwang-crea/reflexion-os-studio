import { SkillRegistry } from './registry.js'
import { CODE_REVIEW_SKILL } from './builtin/code-review.js'
import { TASK_PLANNER_SKILL } from './builtin/task-planner.js'
import { VERIFY_FIX_SKILL } from './builtin/verify-fix.js'
import { WEB_RESEARCH_SKILL } from './builtin/web-research.js'
import { WORKSPACE_REPORT_SKILL } from './builtin/workspace-report.js'

export { SkillRegistry } from './registry.js'
export type { SkillDefinition } from './types.js'
export {
  activeSkillPromptSection,
  resolveInvocation,
  skillsPromptSection,
} from './invocation.js'

/** 内置 Skill 注册表单例：Phase 1A 全部可用技能即此清单。 */
export const builtinSkills: SkillRegistry = (() => {
  const registry = new SkillRegistry()
  for (const skill of [
    CODE_REVIEW_SKILL,
    TASK_PLANNER_SKILL,
    VERIFY_FIX_SKILL,
    WEB_RESEARCH_SKILL,
    WORKSPACE_REPORT_SKILL,
  ]) {
    registry.register(skill)
  }
  return registry
})()
