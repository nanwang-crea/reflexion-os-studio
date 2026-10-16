import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentTemplate,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import {
  bulkUpdateAgentTemplates,
  listAgentTemplates,
  saveAgentTemplate,
  removeAgentTemplate,
  setAgentEnabled,
} from '../../api/agents'
import { listProjects } from '../../api/projects'
import { RoleCatalog } from './roles/RoleCatalog'
import { RoleFilters } from './roles/RoleFilters'
import { emptyRole, type RoleDraft } from './roles/RoleEditor'
import { RoleEditorPanel } from './roles/RoleEditorPanel'
import { RoleBulkPanel } from './roles/bulk/RoleBulkPanel'
import './agents.css'
import './roles/catalog.css'
import './roles/side-panel.css'

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
  const [bulkTargets, setBulkTargets] = useState<AgentTemplate[] | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [bulkDirty, setBulkDirty] = useState(false)
  const originalDraft = useRef('')
  const [scope, setScope] = useState(initialProjectId ?? '*')
  const [domain, setDomain] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [source, setSource] = useState('all')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
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
    void reload()
      .catch((error) => setError(String(error)))
      .finally(() => setLoading(false))
  }, [reload])
  const action = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await reload()
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      await reload().catch(() => undefined)
      return false
    } finally {
      setBusy(false)
    }
  }
  const allowSwitch = async () => {
    const dirty = draft
      ? JSON.stringify(draft) !== originalDraft.current
      : bulkDirty
    return (
      !dirty ||
      (await confirm({
        title: '切换配置',
        message: '放弃当前尚未保存的配置？',
        confirmLabel: '放弃并切换',
      }))
    )
  }
  const edit = async (value: RoleDraft) => {
    if (!(await allowSwitch())) return
    setError(null)
    setEditorKey((key) => key + 1)
    setBulkTargets(null)
    setBulkDirty(false)
    originalDraft.current = JSON.stringify(value)
    setDraft(value)
  }
  const visible = templates.filter(
    (template) =>
      (scope === '*' ||
        template.projectId === null ||
        template.projectId === scope) &&
      (!domain || template.domains.includes(domain)) &&
      (status === 'all' || template.enabled === (status === 'enabled')) &&
      (source === 'all' || template.builtin === (source === 'builtin')) &&
      `${template.name} ${template.description} ${template.domains.join(' ')}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  )
  const domains = [
    ...new Set(templates.flatMap((template) => template.domains)),
  ]
  return (
    <div className="agent-roles-view">
      <div className="agent-roles-library">
        <header className="agent-roles-heading">
          <div>
            <h1>角色库</h1>
            <p>配置职责与执行能力，供主对话按需调用。</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void edit({
                ...emptyRole,
                projectId: scope === '*' ? initialProjectId : scope || null,
              })
            }
          >
            新建角色
          </button>
        </header>
        <RoleFilters
          scope={scope}
          setScope={setScope}
          domain={domain}
          setDomain={setDomain}
          query={query}
          setQuery={setQuery}
          source={source}
          setSource={setSource}
          status={status}
          setStatus={setStatus}
          projects={projects}
          domains={domains}
        />
        <p className="agent-role-summary" role="status">
          {loading
            ? '正在加载角色…'
            : `显示 ${visible.length} / ${templates.length} 个角色`}
          {scope === '*' && ' · 跨项目通用角色及各项目专属角色'}
          {scope === '' && ' · 可在所有项目及独立会话中使用'}
          {scope !== '*' && scope !== '' && ' · 此项目专属角色及跨项目通用角色'}
        </p>
        {notice && <p role="status">{notice}</p>}
        {error && !draft && !bulkTargets && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="agent-role-layout">
          <RoleCatalog
            key={JSON.stringify([
              scope,
              domain,
              query,
              status,
              source,
              catalogRevision,
            ])}
            items={visible}
            onBulkEdit={(roles) => {
              void (async () => {
                if (!(await allowSwitch())) return
                setBulkDirty(false)
                setEditorKey((key) => key + 1)
                setDraft(null)
                setError(null)
                setBulkTargets(roles)
              })()
            }}
            itemProps={{
              profiles,
              projects,
              busy,
              scope,
              initialProjectId,
              onEdit: (value) => void edit(value),
              onDelete: (template) =>
                void action(async () => {
                  if (
                    await confirm({
                      title: '删除角色',
                      message: `删除“${template.name}”？已有执行记录会保留。`,
                      danger: true,
                      confirmLabel: '删除',
                    })
                  ) {
                    await removeAgentTemplate(template.id)
                    if (draft?.id === template.id) setDraft(null)
                    if (bulkTargets?.some((role) => role.id === template.id)) {
                      setBulkTargets(null)
                      setBulkDirty(false)
                    }
                  }
                }),
              onToggle: (template) =>
                void action(async () => {
                  await setAgentEnabled(template.id, !template.enabled)
                  setDraft((current) =>
                    current?.id === template.id
                      ? { ...current, enabled: !template.enabled }
                      : current,
                  )
                }),
            }}
          />
          {!loading && !visible.length && (
            <p>
              没有符合筛选条件的角色。请调整搜索或清空筛选，也可以新建角色。
            </p>
          )}
        </div>
      </div>
      {draft && (
        <RoleEditorPanel
          error={error}
          key={editorKey}
          value={draft}
          onChange={setDraft}
          profiles={profiles}
          projects={projects}
          domains={domains}
          busy={busy}
          onSave={() =>
            void action(async () => {
              await saveAgentTemplate(draft)
              setDraft(null)
              setNotice(`已保存“${draft.name}”。列表保留当前筛选条件。`)
            })
          }
          onCancel={() => setDraft(null)}
        />
      )}
      {bulkTargets && (
        <RoleBulkPanel
          key={`bulk-${editorKey}`}
          roles={bulkTargets}
          projects={projects}
          busy={busy}
          error={error}
          onDirtyChange={setBulkDirty}
          onClose={() => {
            setBulkTargets(null)
            setBulkDirty(false)
          }}
          onSave={(input) =>
            action(async () => {
              await bulkUpdateAgentTemplates(input)
              setBulkTargets(null)
              setBulkDirty(false)
              setCatalogRevision((value) => value + 1)
              setNotice(
                `已批量更新 ${input.targets.length} 个角色。列表保留当前筛选条件。`,
              )
            })
          }
        />
      )}
    </div>
  )
}
