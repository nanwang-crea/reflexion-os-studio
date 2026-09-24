import { SkillRegistry } from './registry.js'
import { CODE_REVIEW_SKILL } from './builtin/code-review.js'
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

export function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  for (const skill of [
    CODE_REVIEW_SKILL,
    VERIFY_FIX_SKILL,
    WEB_RESEARCH_SKILL,
    WORKSPACE_REPORT_SKILL,
  ]) {
    registry.register(skill)
  }
  return registry
}
