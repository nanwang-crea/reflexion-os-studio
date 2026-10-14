import { useRef, useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { useModalDialog } from '../../../hooks/ui/useModalDialog'
import { Select } from '../../../components/forms/Select'
import { saveSkill } from '../../../api/skills'

export function SaveCollaborationSkill({
  items,
  projectId,
  onClose,
}: {
  items: Delegation[]
  projectId: string | null
  onClose: () => void
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, cancel)
  const [id, setId] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState(projectId ? 'project' : 'global')
  const [instructions, setInstructions] = useState(() => {
    const roles = [
      ...new Set(
        items.map((item) => item.agentInstance?.templateId).filter(Boolean),
      ),
    ]
    return [
      '# 协作方法',
      '',
      '## 适用条件',
      '填写哪些任务适合使用这套协作方法。',
      '',
      '## 角色选择',
      ...(roles.length
        ? roles.map((id) => `- 可选角色模板：${id}。根据任务需要选用。`)
        : ['- 按任务需要选择可用模板或创建动态角色。']),
      '',
      '## 交接与检查',
      '- 独立任务可以并行；有依赖的任务先完成前序成果。',
      '- 为每个任务提供明确边界、上下文、交付物和检查标准。',
      '- 核验实际成果，必要时独立审阅，修复后重新验证。',
      '',
      '## 完成标准',
      '填写需要交付的成果和可验证条件。',
      '',
      '仅在缺少关键输入或需要授权时询问用户；遵守当前权限与预算。',
    ].join('\n')
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  return (
    <dialog
      ref={dialog}
      className="collaboration-skill-dialog"
      aria-label="保存协作 Skill"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2>保存协作 Skill</h2>
      <p>
        提炼可复用的方法。请补充适用条件与完成标准；执行记录和文件路径不会自动复制。
      </p>
      {saved ? (
        <>
          <p role="status">已保存。可以在对话中使用 ${id}，或在技能页管理。</p>
          <button ref={cancel} type="button" onClick={onClose}>
            关闭
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError(null)
            void saveSkill({
              id,
              description,
              instructions,
              projectId: scope === 'project' ? projectId : null,
            })
              .then(() => setSaved(true))
              .catch((error) => setError(String(error)))
              .finally(() => setBusy(false))
          }}
        >
          <fieldset disabled={busy}>
            <label>
              Skill 标识
              <input
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={64}
                placeholder="feature-development"
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <label>
              适用场景
              <input
                required
                maxLength={1024}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label>
              作用范围
              <Select value={scope} onValueChange={setScope}>
                <option value="global">全局</option>
                <option value="project" disabled={!projectId}>
                  当前项目
                </option>
              </Select>
            </label>
            <label>
              协作方法
              <textarea
                required
                rows={12}
                maxLength={20000}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存 Skill'}
            </button>
            <button
              ref={cancel}
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
          </footer>
        </form>
      )}
    </dialog>
  )
}
