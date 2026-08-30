import type { SkillManifest } from '@reflexion-os-studio/contracts'

/**
 * Skill 完整定义：manifest 元数据 + instructions 正文。
 * instructions 是给模型看的行为说明（Markdown），加载后注入上下文或工具结果。
 */
export interface SkillDefinition {
  manifest: SkillManifest
  instructions: string
}
