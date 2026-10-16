import { useEffect, useState } from 'react'
import type { SkillManifest } from '@reflexion-os-studio/contracts'
import { listSkills } from '../../../api/skills'
import { Select } from '../../../components/forms/Select'
import type { RoleDraft } from './RoleEditor'

export function RoleSkillsField({
  value,
  onChange,
}: {
  value: RoleDraft
  onChange: (draft: RoleDraft) => void
}) {
  const [skills, setSkills] = useState<SkillManifest[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void listSkills(value.projectId ?? null)
      .then((result) => {
        if (!cancelled) setSkills(result.skills)
      })
      .catch(() => {
        if (!cancelled) setError('技能加载失败，请关闭编辑器后重试。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [value.projectId])
  const bindings = value.skills ?? []
  return (
    <section className="role-editor-section" aria-label="角色技能">
      <h3>角色技能</h3>
      <p>
        按需优先：任务匹配时加载。启动加载：执行前自动加载全文。技能不会扩大工具权限。
      </p>
      {loading && <small role="status">正在加载技能…</small>}
      {error && <p role="alert">{error}</p>}
      {bindings.map((binding) => {
        const skill = skills.find((item) => item.id === binding.skillId)
        return (
          <div key={binding.skillId} className="role-skill-row">
            <span>
              {skill?.name ?? binding.skillId}
              {!loading && !skill ? '（不可用，请移除或恢复技能）' : ''}
            </span>
            <Select
              aria-label={`${binding.skillId} 加载方式`}
              value={binding.mode}
              onValueChange={(mode) =>
                onChange({
                  ...value,
                  skills: bindings.map((item) =>
                    item.skillId === binding.skillId
                      ? { ...item, mode: mode as typeof binding.mode }
                      : item,
                  ),
                })
              }
            >
              <option value="preferred">按需优先</option>
              <option value="startup">启动加载</option>
            </Select>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  skills: bindings.filter(
                    (item) => item.skillId !== binding.skillId,
                  ),
                })
              }
            >
              移除
            </button>
          </div>
        )
      })}
      <Select
        aria-label="添加角色技能"
        value=""
        disabled={loading || !!error || bindings.length >= 20}
        onValueChange={(skillId) => {
          if (!skillId) return
          onChange({
            ...value,
            skills: [...bindings, { skillId, mode: 'preferred' }],
            allowedTools: [...new Set([...value.allowedTools, 'skill.use'])],
          })
        }}
      >
        <option value="">选择技能（最多 20 项）</option>
        {skills
          .filter(
            (skill) => !bindings.some((item) => item.skillId === skill.id),
          )
          .map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name} · {skill.description}
            </option>
          ))}
      </Select>
      <small>
        添加技能会勾选 skill.use；文件、脚本与浏览器操作仍遵循执行时权限和审批。
      </small>
    </section>
  )
}
