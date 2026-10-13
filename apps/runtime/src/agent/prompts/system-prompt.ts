import type { AgentDefinition } from '@reflexion-os-studio/contracts'
import {
  activeSkillPromptSection,
  skillsPromptSection,
  type SkillDefinition,
  type SkillRegistry,
} from '../../skills/index.js'
import {
  PRIMARY_AGENT_SYSTEM_PROMPT,
  availableAgentsPromptSection,
} from './index.js'

/** system prompt = 主 prompt + 可用 Skills 清单 +（可选）本次激活技能的完整说明。 */
export function composeSystemPrompt(
  skills: SkillRegistry,
  skill: SkillDefinition | null,
  agents: readonly AgentDefinition[] = [],
  projectId: string | null = null,
): string {
  const base = `${PRIMARY_AGENT_SYSTEM_PROMPT}${skillsPromptSection(skills.list(projectId))}${availableAgentsPromptSection(agents)}`
  return skill === null ? base : `${base}${activeSkillPromptSection(skill)}`
}
