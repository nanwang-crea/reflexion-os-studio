/**
 * Monaco 单文件编辑器完整视图：头部工具栏（关闭/复制/编辑切换/保存）
 * + 无头内核 MonacoSurface。加载/编辑/脏跟踪/保存逻辑都在 Surface。
 */
import { useCallback, useRef, useState } from 'react'
import {
  MonacoSurface,
  type MonacoSurfaceHandle,
  type MonacoSurfaceState,
} from './MonacoSurface'
import { getFileName } from './language'
import type { MonacoEditorProps } from './types'

export function MonacoEditor(props: MonacoEditorProps): React.JSX.Element {
  const [surface, setSurface] = useState<MonacoSurfaceState>({
    loading: true,
    error: null,
    dirty: false,
    saving: false,
    canEdit: false,
    editMode: false,
  })
  const surfaceRef = useRef<MonacoSurfaceHandle>(null)
  const fileName = getFileName(props.path)
  const editable = props.readOnly !== true

  const handleStateChange = useCallback(
    (state: MonacoSurfaceState): void => setSurface(state),
    [],
  )

  return (
    <div className="content-view monaco-editor-container">
      <header className="content-head">
        <button
          className="ghost content-close"
          onClick={props.onClose}
          aria-label="关闭"
          title="关闭"
        >
          ×
        </button>
        <span className="content-name" title={props.path}>
          {fileName}
        </span>
        <button
          className="ghost"
          onClick={() => void surfaceRef.current?.copyText()}
          title="复制全文"
        >
          复制
        </button>
        {editable && (
          <>
            <button
              className={`ghost${surface.editMode ? ' active' : ''}`}
              onClick={() => surfaceRef.current?.setEditMode(!surface.editMode)}
              disabled={!surface.canEdit}
              title={
                surface.canEdit
                  ? surface.editMode
                    ? '切换为只读'
                    : '切换为编辑'
                  : '文件过大或读取被截断，仅支持只读'
              }
            >
              {surface.editMode ? '编辑中' : '只读'}
            </button>
            {surface.dirty && (
              <button
                className="ghost"
                onClick={() => void surfaceRef.current?.save()}
                disabled={surface.saving}
                title="保存"
              >
                {surface.saving ? '保存中…' : '保存'}
              </button>
            )}
          </>
        )}
        {surface.error !== null && (
          <span className="content-error-inline">{surface.error}</span>
        )}
      </header>
      <MonacoSurface
        projectId={props.projectId}
        path={props.path}
        initialLine={props.initialLine}
        readOnly={props.readOnly}
        ref={surfaceRef}
        onStateChange={handleStateChange}
        onContentChange={props.onContentChange}
      />
    </div>
  )
}
