import { SkillManifestSchema } from '@reflexion-os-studio/contracts'
import type { SkillManifest } from '@reflexion-os-studio/contracts'
import type { SkillDefinition } from './types.js'

/**
 * Skill 注册表：Phase 1A 只收内置技能，注册时用 contracts schema 校验 manifest，
 * 不合法直接抛错（启动即失败，不带病运行）。发现/安装/启停属 Phase 2。
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>()

  /** 注册并校验一个 Skill；id 冲突视为编程错误。 */
  register(skill: SkillDefinition): void {
    const manifest = SkillManifestSchema.parse(skill.manifest)
    if (skill.instructions.trim() === '') {
      throw new Error(`skill ${manifest.id}: instructions must not be empty`)
    }
    if (this.skills.has(manifest.id)) {
      throw new Error(`duplicate skill id: ${manifest.id}`)
    }
    this.skills.set(manifest.id, { manifest, instructions: skill.instructions })
  }

  list(): SkillManifest[] {
    return [...this.skills.values()]
      .map((skill) => skill.manifest)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): SkillDefinition | null {
    return this.skills.get(id) ?? null
  }

  has(id: string): boolean {
    return this.skills.has(id)
  }
}
