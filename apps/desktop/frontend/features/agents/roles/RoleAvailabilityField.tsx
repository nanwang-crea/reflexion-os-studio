import { useState } from 'react'
import type { Project } from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import type { RoleDraft } from './RoleEditor'

const suggestions = ['开发', '写作', '研究', '审校', '数据分析']
export function RoleAvailabilityField({
  value,
  projects,
  domains,
  onChange,
}: {
  value: RoleDraft
  projects: Project[]
  domains: string[]
  onChange: (value: RoleDraft) => void
}): React.JSX.Element {
  const [text, setText] = useState((value.domains ?? []).join(', '))
  const selected = value.domains ?? []
  const invalidDomains =
    selected.length > 12 || selected.some((domain) => domain.length > 40)
  const options = [...new Set([...suggestions, ...domains, ...selected])]
  return (
    <section className="role-editor-section" aria-label="可用位置与分类">
      <h3>可用位置与分类</h3>
      <label>
        角色可用位置
        <Select
          value={value.projectId ?? ''}
          onValueChange={(id) => onChange({ ...value, projectId: id || null })}
        >
          <option value="">跨项目通用 · 所有会话可选</option>
          {value.projectId &&
            !projects.some((project) => project.id === value.projectId) && (
              <option value={value.projectId} disabled>
                原项目不可用
              </option>
            )}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              仅项目 · {project.name}
            </option>
          ))}
        </Select>
      </label>
      <small>
        通用角色可在所有项目及独立会话中选择；项目专属角色仅在所属项目中可选。执行目录始终使用当前任务的工作区。
      </small>
      <label>
        领域分类
        <input
          aria-invalid={invalidDomains || undefined}
          value={text}
          placeholder="开发, 写作；可输入自定义分类"
          onChange={(event) => {
            setText(event.target.value)
            onChange({
              ...value,
              domains: [
                ...new Set(
                  event.target.value
                    .split(/[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                ),
              ],
            })
          }}
        />
      </label>
      {invalidDomains && (
        <p role="alert" className="error">
          分类最多 12 个，每个不超过 40 字，请调整后保存。
        </p>
      )}
      <div className="role-domain-tags" aria-label="快速选择分类">
        {options.map((domain) => (
          <button
            key={domain}
            type="button"
            aria-pressed={selected.includes(domain)}
            disabled={!selected.includes(domain) && selected.length >= 12}
            onClick={() => {
              const next = selected.includes(domain)
                ? selected.filter((item) => item !== domain)
                : [...selected, domain]
              setText(next.join(', '))
              onChange({ ...value, domains: next })
            }}
          >
            {domain}
          </button>
        ))}
      </div>
      <small>
        分类便于查找与选择，不会授予文件或工具权限。最多 12 个，每个不超过 40
        字。
      </small>
    </section>
  )
}
