import { useState } from 'react'
import type {
  DeveloperFilter,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/runtime-client'
import { DeveloperFilters } from './DeveloperFilters'
import { useDeveloperRefresh } from './data'
import { UsageOverview } from './overview/UsageOverview'
import { RunList } from './runs/RunList'
import { RunDetail } from './runs/RunDetail'
import { ToolList } from './tools/ToolList'
import { ToolDetail } from './tools/ToolDetail'
import './developer.css'

export function DeveloperView(props: {
  projects: Project[]
  profiles: ProviderProfile[]
  onConversation: (sessionId: string, projectId: string | null) => void
}) {
  const [tab, setTab] = useState('overview')
  const [filter, setFilter] = useState<DeveloperFilter>({})
  const [runId, setRunId] = useState<string | null>(null)
  const [toolId, setToolId] = useState<string | null>(null)
  const { revision, refresh } = useDeveloperRefresh()
  const filterKey = JSON.stringify(filter)
  return (
    <div className="developer-view">
      <header className="developer-heading">
        <div>
          <h1>开发者</h1>
          <p className="hint">检查用量、运行过程与工具调用</p>
        </div>
        <button type="button" className="ghost" onClick={refresh}>
          刷新
        </button>
      </header>
      <DeveloperFilters
        projects={props.projects}
        profiles={props.profiles}
        onApply={(value) => {
          setFilter(value)
          setRunId(null)
          setToolId(null)
        }}
      />
      <nav className="developer-tabs" aria-label="开发者页面分类">
        {[
          ['overview', '用量概览'],
          ['runs', '运行记录'],
          ['tools', '工具调用'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'active' : 'ghost'}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              setTab(key)
              setRunId(null)
              setToolId(null)
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div key={filterKey}>
        {/* Preserve each list's page/filter and the selected Run's detail tab. */}
        <div hidden={runId !== null || toolId !== null}>
          {tab === 'overview' ? (
            <UsageOverview
              filter={filter}
              revision={revision}
              enabled={!runId && !toolId}
            />
          ) : tab === 'runs' ? (
            <RunList
              filter={filter}
              revision={revision}
              onSelect={setRunId}
              enabled={!runId && !toolId}
            />
          ) : (
            <ToolList
              filter={filter}
              revision={revision}
              onSelect={setToolId}
              enabled={!runId && !toolId}
            />
          )}
        </div>
        {runId && (
          <div hidden={toolId !== null}>
            <RunDetail
              key={runId}
              id={runId}
              revision={revision}
              onRun={setRunId}
              enabled={!toolId}
              onTool={setToolId}
              onBack={() => setRunId(null)}
              onConversation={props.onConversation}
            />
          </div>
        )}
        {toolId && (
          <ToolDetail
            key={toolId}
            id={toolId}
            revision={revision}
            onRun={(id) => {
              setToolId(null)
              setRunId(id)
            }}
            onBack={() => setToolId(null)}
          />
        )}
      </div>
    </div>
  )
}
