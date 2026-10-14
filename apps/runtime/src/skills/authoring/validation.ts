import type { SkillSaveParams } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { containsSecretLike } from '../../agent/instructions/secretGuard.js'

export function validateResourcePath(path: string): string[] {
  const parts = path.split('/')
  if (
    !['scripts', 'references', 'assets'].includes(parts[0]) ||
    parts.length < 2 ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith('.') ||
        /[\\:\x00-\x1f]/.test(part) ||
        /^(credentials\.json|secrets\.json|id_token)$/i.test(part) ||
        /\.(key|pem|token)$/i.test(part),
    )
  )
    throw new Error(
      '资源必须位于 scripts/references/assets，且不能包含越界、隐藏或凭据路径',
    )
  return parts
}

export function validateAuthoredSkill(store: Store, input: SkillSaveParams) {
  if (input.projectId && !store.projects.get(input.projectId))
    throw new Error('项目不存在')
  const current = store.plugins.get(input.id)
  if (input.mode === 'update') {
    if (!current || !current.installPath || current.source === 'builtin')
      throw new Error('Skill 不存在或不可更新')
    if (current.projectId !== input.projectId)
      throw new Error('不能改变 Skill 的作用范围')
    if (!input.expectedVersion || input.expectedVersion !== current.version)
      throw new Error('Skill 版本已变化，请重新加载再修改')
  } else if (current) throw new Error('Skill 标识已存在，请使用新的标识')
  const text = [
    input.instructions,
    ...(input.resources ?? []).map((resource) => resource.content),
  ].join('\n')
  for (const resource of input.resources ?? [])
    validateResourcePath(resource.path)
  if (
    new Set(
      (input.resources ?? []).map((resource) => resource.path.toLowerCase()),
    ).size !== (input.resources ?? []).length
  )
    throw new Error('资源路径不能重复')
  for (const template of store.agents.list()) {
    if (!template.projectId || template.projectId === input.projectId) continue
    const escapedId = template.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reference = new RegExp(
      `(?<![A-Za-z0-9_-])${escapedId}(?![A-Za-z0-9_-])`,
    )
    if (reference.test(text))
      throw new Error('Skill 引用了项目角色，请保存到该角色所属项目')
  }
  // Only canonical generated role IDs are exempted, as complete tokens; never strip substrings from possible credentials.
  const checkedInstructions = text.replace(
    /(?<![A-Za-z0-9_-])template-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi,
    (id) => {
      const template = store.agents.get(id)
      if (!template) return id
      return '[已验证的角色模板引用]'
    },
  )
  if (
    containsSecretLike(checkedInstructions) ||
    containsSecretLike(input.description)
  )
    throw new Error('Skill 内容疑似包含机密，拒绝保存')
  return current
}
