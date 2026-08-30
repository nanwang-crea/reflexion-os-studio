import type { SkillManifest } from '@reflexion-os-studio/runtime-client'
import { requestList } from './client'

/** 内置 Skill 清单：斜杠命令浮层的数据源（Phase 1A 列表即全部可用项）。 */
export function listSkills(): Promise<{ skills: SkillManifest[] }> {
  return requestList<{ skills: SkillManifest[] }>('skill.list')
}
