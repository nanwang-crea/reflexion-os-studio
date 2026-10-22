import { useState } from 'react'
import type {
  DeveloperFilter,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/runtime-client'
import { Select } from '../../components/forms/Select'

export function DeveloperFilters(props: {
  projects: Project[]
  profiles: ProviderProfile[]
  onApply: (filter: DeveloperFilter) => void
}) {
  const [project, setProject] = useState('all')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      className="developer-filters"
      onSubmit={(event) => {
        event.preventDefault()
        const lower = from ? new Date(`${from}T00:00:00`) : undefined
        const upper = to ? new Date(`${to}T00:00:00`) : undefined
        upper?.setDate(upper.getDate() + 1)
        if (lower && upper && lower >= upper) {
          setError('结束日期不能早于开始日期')
          return
        }
        setError('')
        props.onApply({
          projectId:
            project === 'all'
              ? undefined
              : project === 'standalone'
                ? null
                : project,
          providerId: provider || undefined,
          model: model.trim() || undefined,
          from: lower?.toISOString(),
          to: upper?.toISOString(),
        })
      }}
    >
      <label>
        项目
        <Select
          value={project}
          onValueChange={setProject}
          aria-label="筛选项目"
        >
          <option value="all">全部项目</option>
          <option value="standalone">独立会话</option>
          {props.projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </label>
      <label>
        Provider
        <Select
          value={provider}
          onValueChange={setProvider}
          aria-label="筛选 Provider"
        >
          <option value="">全部 Provider</option>
          {props.profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </label>
      <label>
        模型
        <input
          aria-label="筛选模型"
          placeholder="完整模型名称"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label>
        开始日期
        <input
          aria-label="开始日期"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label>
        结束日期
        <input
          aria-label="结束日期"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <button type="submit">应用筛选</button>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          setProject('all')
          setProvider('')
          setModel('')
          setFrom('')
          setTo('')
          setError('')
          props.onApply({})
        }}
      >
        重置
      </button>
      {error && (
        <p className="developer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
