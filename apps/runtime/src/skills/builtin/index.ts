import { SKILL_CREATOR_SKILL } from './skill-creator.js'
import { AGENT_COLLABORATION_SKILL } from './agent-collaboration.js'
import { TEAM_CREATE_SKILL } from './team-create.js'
import { CODE_REVIEW_SKILL } from './code-review.js'
import { VERIFY_FIX_SKILL } from './verify-fix.js'
import { WEB_RESEARCH_SKILL } from './web-research.js'
import { WORKSPACE_REPORT_SKILL } from './workspace-report.js'

/** One registry source for direct Runtime use and plugin management. */
export const BUILTIN_SKILLS = [
  SKILL_CREATOR_SKILL,
  TEAM_CREATE_SKILL,
  AGENT_COLLABORATION_SKILL,
  CODE_REVIEW_SKILL,
  VERIFY_FIX_SKILL,
  WEB_RESEARCH_SKILL,
  WORKSPACE_REPORT_SKILL,
]
