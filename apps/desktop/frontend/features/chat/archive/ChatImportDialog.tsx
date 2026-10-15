import { useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  ChatArchiveImportParams,
  Project,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import { useModalDialog } from '../../../hooks/ui/useModalDialog'
import './chat-archive.css'

export function ChatImportDialog({
  projects,
  projectId,
  onImport,
  onClose,
}: {
  projects: Project[]
  projectId: string | null
  onImport: (
    input: Omit<ChatArchiveImportParams, 'requestId'>,
  ) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, cancel)
  const lock = useRef(false)
  const [path, setPath] = useState('')
  const [target, setTarget] = useState(projectId ?? '')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choose = async (directory: boolean) => {
    try {
      const selected = await open({
        directory,
        multiple: false,
        title: directory ? '选择目标项目目录' : '选择聊天备份',
        ...(directory
          ? {}
          : {
              filters: [{ name: 'Reflexion 聊天备份', extensions: ['json'] }],
            }),
      })
      if (typeof selected === 'string') {
        if (directory) setFolder(selected)
        else setPath(selected)
        setError(null)
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }
  const close = () => {
    if (!lock.current) onClose()
  }
  return (
    <dialog
      ref={dialog}
      className="dialog-overlay confirm-dialog-modal"
      aria-label="导入聊天记录"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <form
        className="dialog chat-import-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (lock.current || !path || (target === '@folder' && !folder)) return
          lock.current = true
          setBusy(true)
          setError(null)
          void onImport({
            path,
            ...(target === '@folder'
              ? { folderPath: folder }
              : { projectId: target || null }),
          })
            .then((success) => {
              if (success) onClose()
            })
            .catch((error) =>
              setError(error instanceof Error ? error.message : String(error)),
            )
            .finally(() => {
              lock.current = false
              setBusy(false)
            })
        }}
      >
        <h3>导入聊天记录</h3>
        <p>
          从 Reflexion
          聊天备份新建会话，保留消息、思考、工具记录与消息图片。现有会话不会被覆盖。
        </p>
        <fieldset disabled={busy}>
          <div className="chat-archive-file-picker">
            <span>聊天备份文件</span>
            <button type="button" onClick={() => void choose(false)}>
              选择备份文件…
            </button>
          </div>
          {path && <p className="chat-archive-path">{path}</p>}
          <label>
            导入位置
            <Select value={target} onValueChange={setTarget}>
              <option value="">独立新会话</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  项目 · {project.name}
                </option>
              ))}
              <option value="@folder">选择目录对应的项目…</option>
            </Select>
          </label>
          {target === '@folder' && (
            <div>
              <button type="button" onClick={() => void choose(true)}>
                选择项目目录…
              </button>
              {folder && <p className="chat-archive-path">{folder}</p>}
              <small>
                已有关联项目则导入该项目，否则创建项目并添加新会话。
              </small>
            </div>
          )}
        </fieldset>
        <small>
          仅支持 .reflexion-chat.json，最大 16MiB。备份不包含工作区文件或子
          Agent 独立会话，导入后不会自动执行历史工具。
        </small>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" ref={cancel} disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !path || (target === '@folder' && !folder)}
          >
            {busy ? '导入中…' : '导入为新会话'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
