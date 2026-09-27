import { useCallback, useEffect, useState } from 'react'
import type { AgentTemplate } from '@reflexion-os-studio/runtime-client'
import {
  listAgentTemplates,
  removeAgentTemplate,
  saveAgentTemplate,
  setAgentEnabled,
} from '../../api/agents'

const DEFAULT_TOOLS = [
  'get_current_time',
  'web.fetch',
  'skill.use',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'file.write',
  'file.write_stream',
  'file.edit',
  'file.delete',
  'file.move',
  'file.mkdir',
  'shell.execute',
  'task',
]

interface Draft {
  id?: string
  name: string
  description: string
  systemPrompt: string
  allowedTools: string
  canDelegate: boolean
}

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  systemPrompt: '',
  allowedTools: DEFAULT_TOOLS.join(', '),
  canDelegate: true,
}

export function AgentDefinitionsPanel(): React.JSX.Element {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setTemplates(await listAgentTemplates())
  }, [])

  useEffect(() => {
    void reload().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    )
  }, [reload])

  const edit = (template: AgentTemplate): void => {
    setDraft({
      id: template.id,
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      allowedTools: template.policy.allowedTools.join(', '),
      canDelegate: template.policy.canDelegate,
    })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusyId(draft.id ?? 'new')
    setError(null)
    try {
      await saveAgentTemplate({
        ...draft,
        enabled: true,
        allowedTools: draft.allowedTools
          .split(',')
          .map((tool) => tool.trim())
          .filter(Boolean),
      })
      setDraft(null)
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (template: AgentTemplate): Promise<void> => {
    setBusyId(template.id)
    try {
      await setAgentEnabled(template.id, !template.enabled)
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (template: AgentTemplate): Promise<void> => {
    setBusyId(template.id)
    try {
      await removeAgentTemplate(template.id)
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="runtime-group">
      <div className="runtime-group-heading">
        <div>
          <h4 className="runtime-group-title">Agent 模板</h4>
          <small>模板可选；每次委派仍创建独立动态 Agent。</small>
        </div>
        <button type="button" onClick={() => setDraft(EMPTY_DRAFT)}>
          新建模板
        </button>
      </div>
      {draft && (
        <div className="agent-template-editor">
          <input
            placeholder="模板名称"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.currentTarget.value })
            }
          />
          <input
            placeholder="适用场景"
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.currentTarget.value })
            }
          />
          <textarea
            placeholder="模板指令"
            value={draft.systemPrompt}
            onChange={(event) =>
              setDraft({ ...draft, systemPrompt: event.currentTarget.value })
            }
          />
          <input
            aria-label="允许工具"
            value={draft.allowedTools}
            onChange={(event) =>
              setDraft({ ...draft, allowedTools: event.currentTarget.value })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={draft.canDelegate}
              onChange={(event) =>
                setDraft({ ...draft, canDelegate: event.currentTarget.checked })
              }
            />
            允许继续委派
          </label>
          <div>
            <button
              type="button"
              disabled={!draft.name || !draft.systemPrompt || busyId !== null}
              onClick={() => void save()}
            >
              保存
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      <div className="agent-definition-list">
        {templates.map((template) => (
          <div className="agent-definition-row" key={template.id}>
            <span>
              <strong>{template.name}</strong>
              <small>
                {template.builtin ? '内置' : '用户'} · {template.description}
              </small>
              <small>
                {template.policy.canDelegate ? '可继续委派' : '不可继续委派'} ·
                工具 {template.policy.allowedTools.length}
              </small>
            </span>
            {!template.builtin && (
              <button type="button" onClick={() => edit(template)}>
                编辑
              </button>
            )}
            {!template.builtin && (
              <button
                type="button"
                disabled={busyId === template.id}
                onClick={() => void remove(template)}
              >
                删除
              </button>
            )}
            <input
              type="checkbox"
              aria-label={`启用 ${template.name}`}
              checked={template.enabled}
              disabled={busyId === template.id}
              onChange={() => void toggle(template)}
            />
          </div>
        ))}
      </div>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </section>
  )
}
