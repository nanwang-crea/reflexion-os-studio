import { useEffect, useState, type ComponentProps } from 'react'
import type { Project } from '@reflexion-os-studio/contracts'
import { listProjects } from '../../api/projects'
import { Select } from '../../components/forms/Select'
import { WorkflowWorkspace } from './WorkflowWorkspace'
import './workflow.css'

export function AutomationsView({
  visible,
  initialProjectId,
  ...props
}: Omit<ComponentProps<typeof WorkflowWorkspace>, 'projectId'> & {
  visible: boolean
  initialProjectId: string | null
}): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(initialProjectId)
  const [visited, setVisited] = useState<Set<string>>(
    new Set(initialProjectId ? [initialProjectId] : []),
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    void listProjects()
      .then((result) => {
        if (alive) {
          setProjects(result.projects)
          setProjectId((old) =>
            result.projects.some((project) => project.id === old)
              ? old
              : (result.projects[0]?.id ?? null),
          )
        }
      })
      .catch((error) => {
        if (alive) setError(String(error))
      })
    return () => {
      alive = false
    }
  }, [visible])
  useEffect(() => {
    if (projectId)
      setVisited((old) =>
        old.has(projectId) ? old : new Set([...old, projectId]),
      )
  }, [projectId])
  return (
    <div className="automations-view">
      <header className="workflow-page-head">
        <div>
          <h1>工作流</h1>
          <p className="panel-sub">
            连接角色，让想法成为可执行的协作流程。定时任务尚未开放。
          </p>
        </div>
        <label className="workflow-project-picker">
          项目
          <Select
            value={projectId ?? ''}
            onValueChange={(id) => setProjectId(id || null)}
          >
            <option value="">请选择项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </label>
      </header>
      {error && <p role="alert">{error}</p>}
      {projects
        .filter((project) => visited.has(project.id))
        .map((project) => (
          <div
            className="workflow-project-surface"
            key={project.id}
            hidden={project.id !== projectId}
          >
            <WorkflowWorkspace
              projectId={project.id}
              visible={visible && project.id === projectId}
              {...props}
            />
          </div>
        ))}
      {!projects.length && <p>请先创建一个项目，再配置工作流。</p>}
    </div>
  )
}
