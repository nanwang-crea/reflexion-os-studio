import { BUILTIN_SKILLS } from './builtin/index.js'
import { SkillRegistry } from './registry.js'

export { SkillRegistry } from './registry.js'
export type { SkillDefinition } from './types.js'
export {
  activeSkillPromptSection,
  resolveInvocation,
  skillsPromptSection,
} from './invocation.js'

export function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  for (const skill of BUILTIN_SKILLS) {
    registry.register(skill)
  }
  return registry
}
