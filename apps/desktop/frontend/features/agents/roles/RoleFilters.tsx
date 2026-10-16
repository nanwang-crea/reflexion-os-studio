import type { Project } from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'

export function RoleFilters({
  scope,
  setScope,
  domain,
  setDomain,
  query,
  setQuery,
  source,
  setSource,
  status,
  setStatus,
  projects,
  domains,
}: {
  scope: string
  setScope: (value: string) => void
  domain: string
  setDomain: (value: string) => void
  query: string
  setQuery: (value: string) => void
  source: string
  setSource: (value: string) => void
  status: string
  setStatus: (value: string) => void
  projects: Project[]
  domains: string[]
}): React.JSX.Element {
  return (
    <div className="agent-role-filters">
      <label>
        搜索角色
        <input
          type="search"
          placeholder="名称、职责或分类"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label>
        查看范围
        <Select value={scope} onValueChange={setScope}>
          <option value="*">所有角色（通用及项目专属）</option>
          <option value="">仅跨项目通用角色</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}（含通用角色）
            </option>
          ))}
        </Select>
      </label>
      <label>
        领域分类
        <Select value={domain} onValueChange={setDomain}>
          <option value="">全部分类</option>
          {domains.map((domain) => (
            <option key={domain} value={domain}>
              {domain}
            </option>
          ))}
        </Select>
      </label>
      <label>
        启用状态
        <Select value={status} onValueChange={setStatus}>
          <option value="all">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
        </Select>
      </label>
      <label>
        角色来源
        <Select value={source} onValueChange={setSource}>
          <option value="all">全部来源</option>
          <option value="builtin">内置角色</option>
          <option value="custom">自定义角色</option>
        </Select>
      </label>
      <button
        type="button"
        onClick={() => {
          setScope('*')
          setDomain('')
          setQuery('')
          setStatus('all')
          setSource('all')
        }}
      >
        清空筛选
      </button>
    </div>
  )
}
