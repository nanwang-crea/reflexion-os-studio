import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { listProjects } from '../../api/projects'
import { getInstruction, saveInstruction } from '../../api/instructions'

type Scope = 'global' | 'project'
type Kind = 'agents' | 'memory'

interface PaneStatus {
  text: string
  failed: boolean
}

const FILES: { kind: Kind; title: string; hint: string }[] = [
  {
    kind: 'agents',
    title: 'AGENTS.md · 纪律与规范',
    hint: '写给所有工具的长期指令。项目级会写入项目文件夹根目录。',
  },
  {
    kind: 'memory',
    title: 'MEMORY.md · 沉淀的记忆',
    hint: '模型经 memory.remember 追加的条目与本区的手写内容，全部自动注入对话。',
  },
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function InstructionPane(props: {
  scope: Scope
  projectId: string | null
  kind: Kind
  title: string
  hint: string
  refreshToken: number
  /** 脏状态上抛给页面级守卫（同 FileViewerPanel 的 onDirtyChange 模式）。 */
  onDirtyChange: (kind: Kind, dirty: boolean) => void
  /** 保存中上抛：禁用"重新读取"，防 get 与在途 save 写盘竞态。 */
  onSavingChange: (kind: Kind, saving: boolean) => void
}): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<PaneStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    setLoading(true)
    void getInstruction({
      scope: props.scope,
      projectId: props.projectId ?? undefined,
      kind: props.kind,
    })
      .then((file) => {
        if (!alive) return
        setPath(file.path)
        setContent(file.content)
        setDraft(null)
        setStatus(null)
      })
      .catch((error: unknown) => {
        // 读取失败（磁盘错误等）必须可见：清空内容并禁用编辑，错误上状态行。
        if (!alive) return
        setPath(null)
        setContent('')
        setDraft(null)
        setStatus({ text: messageOf(error), failed: true })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.scope, props.projectId, props.kind, props.refreshToken])
  const dirty = draft !== null && draft !== content
  const { kind, onDirtyChange, onSavingChange } = props
  useEffect(() => {
    onDirtyChange(kind, dirty)
    // 卸载（切 scope/项目后 key 重挂）必须归零，防止父级残留脏计数。
    return () => {
      onDirtyChange(kind, false)
    }
  }, [kind, dirty, onDirtyChange])
  useEffect(() => {
    onSavingChange(kind, saving)
    // 卸载同样归零：保存中途切走不能让「重新读取」永久禁用。
    return () => {
      onSavingChange(kind, false)
    }
  }, [kind, saving, onSavingChange])
  const save = (): void => {
    if (draft === null || saving) return
    setSaving(true)
    void saveInstruction({
      scope: props.scope,
      projectId: props.projectId ?? undefined,
      kind: props.kind,
      content: draft,
    })
      .then((result) => {
        setStatus({ text: result.message, failed: !result.ok })
        if (result.ok) {
          setContent(draft)
          setDraft(null)
        }
      })
      .catch((error: unknown) => {
        // 保存被守卫拒绝或写盘失败：保留草稿，错误上状态行，绝不静默。
        setStatus({ text: messageOf(error), failed: true })
      })
      .finally(() => {
        setSaving(false)
      })
  }
  return (
    <section className="instruction-pane">
      <h3>{props.title}</h3>
      <p className="instruction-path">
        {loading
          ? '读取中…'
          : (path ?? '当前不可用（未关联项目或文件夹未设置）')}
      </p>
      <p className="instruction-hint">{props.hint}</p>
      <textarea
        value={draft ?? content}
        onChange={(event) => setDraft(event.target.value)}
        rows={12}
        spellCheck={false}
        aria-label={props.title}
        disabled={loading || path === null}
      />
      <div className="instruction-actions">
        <button
          type="button"
          className="primary"
          disabled={!dirty || path === null || saving || loading}
          onClick={save}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {dirty && <span className="instruction-dirty">未保存的修改</span>}
        {status && (
          <span
            className={
              status.failed ? 'instruction-status error' : 'instruction-status'
            }
          >
            {status.text}
          </span>
        )}
      </div>
    </section>
  )
}

interface InstructionsViewProps {
  /** 应用内确认弹窗（脏草稿守卫用），与 SettingsView/FileViewerPanel 同源。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}

export function InstructionsView(
  props: InstructionsViewProps,
): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<Scope>('global')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [dirtyKinds, setDirtyKinds] = useState<Record<Kind, boolean>>({
    agents: false,
    memory: false,
  })
  const [savingKinds, setSavingKinds] = useState<Record<Kind, boolean>>({
    agents: false,
    memory: false,
  })
  const selectRef = useRef<HTMLSelectElement | null>(null)
  useEffect(() => {
    let alive = true
    void listProjects()
      .then((result) => {
        if (!alive) return
        setProjects(result.projects)
        setProjectsError(null)
        const first = result.projects.find((item) => item.folderPath !== '')
        if (first) setProjectId(first.id)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setProjectsError(messageOf(error))
      })
    return () => {
      alive = false
    }
  }, [])
  const handleDirtyChange = useCallback((kind: Kind, dirty: boolean): void => {
    setDirtyKinds((current) =>
      current[kind] === dirty ? current : { ...current, [kind]: dirty },
    )
  }, [])
  const handleSavingChange = useCallback(
    (kind: Kind, saving: boolean): void => {
      setSavingKinds((current) =>
        current[kind] === saving ? current : { ...current, [kind]: saving },
      )
    },
    [],
  )
  const anyDirty = dirtyKinds.agents || dirtyKinds.memory
  const anySaving = savingKinds.agents || savingKinds.memory
  /** 会丢弃未保存草稿的动作统一过守卫：脏则弹确认，确认后才执行，取消走 onCancel。 */
  const guarded = (action: () => void, onCancel?: () => void): void => {
    if (!anyDirty) {
      action()
      return
    }
    void (async () => {
      const ok = await props.confirm({
        title: '有未保存的修改',
        message:
          '继续将重新读取文件并丢弃未保存的修改，建议先点「保存」。确定丢弃并继续？',
        confirmLabel: '丢弃并继续',
      })
      if (ok) action()
      else onCancel?.()
    })()
  }
  const activeProjectId = useMemo(
    () => (scope === 'project' ? projectId : null),
    [scope, projectId],
  )
  const reload = useCallback(() => setRefreshToken((token) => token + 1), [])
  return (
    <div className="instructions-view">
      <header>
        <h2>指令</h2>
        <p>
          全局 + 项目的 AGENTS.md（纪律）与
          MEMORY.md（记忆），每次对话自动注入。
        </p>
      </header>
      {projectsError !== null && (
        <p className="instruction-status error">{projectsError}</p>
      )}
      <div className="instructions-toolbar">
        <button
          type="button"
          className={scope === 'global' ? 'primary' : 'ghost'}
          aria-pressed={scope === 'global'}
          onClick={() => {
            if (scope === 'global') return
            guarded(() => setScope('global'))
          }}
        >
          全局
        </button>
        <button
          type="button"
          className={scope === 'project' ? 'primary' : 'ghost'}
          aria-pressed={scope === 'project'}
          onClick={() => {
            if (scope === 'project') return
            guarded(() => setScope('project'))
          }}
        >
          项目
        </button>
        <select
          ref={selectRef}
          aria-label="选择项目"
          value={projectId ?? ''}
          onChange={(event) => {
            const next = event.target.value || null
            if (next === projectId) return
            // 取消时 React 不会把同值写回 DOM，手动回弹选择框。
            guarded(
              () => setProjectId(next),
              () => {
                if (selectRef.current) selectRef.current.value = projectId ?? ''
              },
            )
          }}
          disabled={scope !== 'project'}
        >
          <option value="">选择项目…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost"
          disabled={anySaving}
          onClick={() => guarded(reload)}
        >
          重新读取
        </button>
      </div>
      {scope === 'project' && activeProjectId === null && (
        <p className="notice">请先选择一个项目。</p>
      )}
      <div
        className={
          scope === 'project' && activeProjectId === null
            ? 'instructions-disabled'
            : undefined
        }
      >
        {FILES.map((file) => (
          <InstructionPane
            key={`${scope}-${activeProjectId ?? 'none'}-${file.kind}`}
            scope={scope}
            projectId={activeProjectId}
            kind={file.kind}
            title={file.title}
            hint={file.hint}
            refreshToken={refreshToken}
            onDirtyChange={handleDirtyChange}
            onSavingChange={handleSavingChange}
          />
        ))}
      </div>
    </div>
  )
}
