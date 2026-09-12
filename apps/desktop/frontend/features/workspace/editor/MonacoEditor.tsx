/**
 * Monaco 单文件编辑器完整视图：头部（文件名+脏圆点居左，操作按钮组
 * 右对齐含关闭×）+ 无头内核 MonacoSurface。加载/编辑/脏跟踪/保存逻辑
 * 都在 Surface；脏状态与句柄经 props 上抛给标签层。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MonacoSurface,
  type MonacoSurfaceHandle,
  type MonacoSurfaceState,
} from './MonacoSurface'
import { getFileName } from './language'
import type { MonacoEditorProps } from './types'
import { IS_MAC } from '../../../lib/platform'

export function MonacoEditor({
  onDirtyChange,
  registerSurface,
  ...props
}: MonacoEditorProps): React.JSX.Element {
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
    (state: MonacoSurfaceState): void => {
      setSurface(state)
      onDirtyChange?.(props.path, state.dirty)
    },
    [onDirtyChange, props.path],
  )

  // 注册句柄 getter：标签层经它在任意时刻拿到最新 handle（useImperativeHandle
  // 随内容变化重建 handle，getter 延迟解引用规避陈旧闭包）。
  useEffect(() => {
    registerSurface?.(props.path, () => surfaceRef.current)
    return () => registerSurface?.(props.path, null)
  }, [props.path, registerSurface])

  return (
    <div className="content-view monaco-editor-container">
      <header className="content-head">
        <div className="content-head-main">
          <span className="content-name" title={props.path}>
            {fileName}
          </span>
          {surface.dirty && (
            <span className="content-dirty-dot" aria-label="未保存" />
          )}
        </div>
        <div className="content-head-actions">
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
                onClick={() =>
                  surfaceRef.current?.setEditMode(!surface.editMode)
                }
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
              <button
                className="ghost"
                onClick={() => void surfaceRef.current?.save()}
                disabled={!surface.dirty || surface.saving}
                title={IS_MAC ? '保存（⌘S）' : '保存（Ctrl+S）'}
              >
                {surface.saving ? '保存中…' : '保存'}
              </button>
            </>
          )}
          <button
            className="ghost content-close"
            onClick={props.onClose}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
        </div>
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
