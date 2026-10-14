import { useCallback, useEffect, useState } from 'react'
import type {
  AgentTemplate,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import {
  listAgentTemplates,
  saveAgentTemplate,
  removeAgentTemplate,
  setAgentEnabled,
} from '../../api/agents'
import { listProjects } from '../../api/projects'
import { Select } from '../../components/forms/Select'
import { RoleEditor, emptyRole, type RoleDraft } from './roles/RoleEditor'
import './agents.css'

function roleModelLabel(
  template: AgentTemplate,
  profiles: ProviderProfile[],
): string {
  const binding = template.modelBinding
  return binding.mode === 'inherit'
    ? '继承上级 Agent 模型'
    : `${profiles.find((profile) => profile.id === binding.providerId)?.name ?? binding.providerId} / ${binding.model}`
}

export function AgentRolesView({
  profiles,
  initialProjectId,
  confirm,
}: {
  profiles: ProviderProfile[]
  initialProjectId: string | null
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}): React.JSX.Element {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [draft, setDraft] = useState<RoleDraft | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [scope, setScope] = useState(initialProjectId ?? '')
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const [templates, projects] = await Promise.all([
      listAgentTemplates(),
      listProjects(),
    ])
    setTemplates(templates)
    setProjects(projects.projects)
  }, [])
  useEffect(() => {
    void reload().catch((error) => setError(String(error)))
  }, [reload])
  const action = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const edit = async (value: RoleDraft) => {
    if (
      draft &&
      !(await confirm({
        title: '切换角色',
        message: '放弃当前尚未保存的角色编辑？',
        confirmLabel: '放弃并切换',
      }))
    )
      return
    setEditorKey((key) => key + 1)
    setDraft(value)
  }
  const visible = templates.filter(
    (template) =>
      (scope === '*' ||
        template.projectId === null ||
        template.projectId === scope) &&
      (!domain || template.domains.includes(domain)),
  )
  const domains = [
    ...new Set(templates.flatMap((template) => template.domains)),
  ]
  return (
    <div className="agent-roles-view">
      <header className="agent-roles-heading">
        <div>
          <h1>Agent 角色</h1>
          <p>
            预设职责、模型与工具。在主对话提出目标，Agent 按需选择角色协作。
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void edit({ ...emptyRole, projectId: initialProjectId })
          }
        >
          新建角色
        </button>
      </header>
      <div className="agent-role-filters">
        <label>
          作用范围
          <Select value={scope} onValueChange={setScope}>
            <option value="">全局角色</option>
            <option value="*">全部角色</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}与全局角色
              </option>
            ))}
          </Select>
        </label>
        <label>
          领域
          <Select value={domain} onValueChange={setDomain}>
            <option value="">所有领域</option>
            {domains.map((domain) => (
              <option key={domain} value={domain}>
                {domain}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="agent-role-layout">
        <div className="agent-role-list">
          {visible.map((template) => (
            <article className="agent-role-card" key={template.id}>
              <header>
                <strong>{template.name}</strong>
                <span>
                  {template.builtin
                    ? '内置'
                    : template.projectId
                      ? '项目'
                      : '全局'}
                </span>
              </header>
              <p>{template.description}</p>
              <small>
                {template.domains.join(' · ') || '通用'} ·{' '}
                {roleModelLabel(template, profiles)}
              </small>
              <small>
                {template.policy.allowedTools.length} 个工具 ·{' '}
                {template.policy.canDelegate ? '允许继续委派' : '独立执行'}
              </small>
              <footer>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void edit({
                      id: template.builtin ? undefined : template.id,
                      name: template.builtin
                        ? `${template.name}（自定义）`
                        : template.name,
                      description: template.description,
                      systemPrompt: template.systemPrompt,
                      projectId: template.projectId,
                      domains: template.domains,
                      modelBinding: template.modelBinding,
                      enabled: template.enabled,
                      permissionCeiling: template.policy.permissionCeiling,
                      canDelegate: template.policy.canDelegate,
                      allowedTools: template.policy.allowedTools,
                    })
                  }
                >
                  {template.builtin ? '复制并配置' : '编辑'}
                </button>
                {!template.builtin && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        if (
                          await confirm({
                            title: '删除角色',
                            message: `删除“${template.name}”？已有执行记录会保留。`,
                            danger: true,
                            confirmLabel: '删除',
                          })
                        )
                          await removeAgentTemplate(template.id)
                      })
                    }
                  >
                    删除
                  </button>
                )}
                <label className="agent-checkbox">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${template.name}`}
                    checked={template.enabled}
                    disabled={busy}
                    onChange={() =>
                      void action(async () => {
                        await setAgentEnabled(template.id, !template.enabled)
                      })
                    }
                  />
                  启用
                </label>
              </footer>
            </article>
          ))}
          {!visible.length && <p>当前范围没有角色。可以新建或复制内置角色。</p>}
        </div>
        {draft && (
          <RoleEditor
            key={editorKey}
            value={draft}
            onChange={setDraft}
            profiles={profiles}
            projects={projects}
            busy={busy}
            onSave={() =>
              void action(async () => {
                await saveAgentTemplate(draft)
                setDraft(null)
              })
            }
            onCancel={() => setDraft(null)}
          />
        )}
      </div>
    </div>
  )
}
