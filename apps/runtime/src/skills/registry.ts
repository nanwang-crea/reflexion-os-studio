import { SkillManifestSchema } from '@reflexion-os-studio/contracts'
import type { SkillManifest } from '@reflexion-os-studio/contracts'
import type { SkillDefinition } from './types.js'

/**
 * Skill 注册表：Phase 1A 只收内置技能，注册时用 contracts schema 校验 manifest，
 * 不合法直接抛错（启动即失败，不带病运行）。发现/安装/启停属 Phase 2。
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>()
  private readonly externalIds = new Set<string>()
  private readonly visibility = new Map<
    string,
    { scope: 'global' | 'project'; projectId: string | null }
  >()

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

  registerExternal(
    skill: SkillDefinition,
    visibility: { scope: 'global' | 'project'; projectId: string | null },
  ): void {
    this.register(skill)
    this.externalIds.add(skill.manifest.id)
    this.visibility.set(skill.manifest.id, visibility)
  }

  clearExternal(): void {
    for (const id of this.externalIds) {
      this.skills.delete(id)
      this.visibility.delete(id)
    }
    this.externalIds.clear()
  }

  list(projectId: string | null = null): SkillManifest[] {
    return [...this.skills.values()]
      .filter((skill) => this.isVisible(skill.manifest.id, projectId))
      .map((skill) => skill.manifest)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string, projectId: string | null = null): SkillDefinition | null {
    if (!this.isVisible(id, projectId)) return null
    return this.skills.get(id) ?? null
  }

  has(id: string): boolean {
    return this.skills.has(id)
  }

  private isVisible(id: string, projectId: string | null): boolean {
    const visibility = this.visibility.get(id)
    return (
      visibility === undefined ||
      visibility.scope === 'global' ||
      visibility.projectId === projectId
    )
  }
}
