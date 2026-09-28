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
  confirm,
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

  const handleDiscard = useCallback((): void => {
    if (!surface.dirty) return
    void (async () => {
      const confirmed =
        confirm === undefined ||
        (await confirm({
          title: '还原未保存的修改？',
          message: `${fileName} 将恢复为上次保存的内容。`,
          confirmLabel: '还原修改',
          danger: true,
        }))
      if (confirmed) surfaceRef.current?.discardChanges()
    })()
  }, [confirm, fileName, surface.dirty])

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
          {surface.dirty && <span className="content-edit-status">未保存</span>}
        </div>
        <div className="content-head-actions">
          <button
            className="ghost"
            onClick={() => void surfaceRef.current?.copyText()}
            title="复制全文"
          >
            复制
          </button>
          {editable && surface.canEdit && (
            <div
              className="file-mode-switch"
              role="group"
              aria-label="文件模式"
            >
              <button
                type="button"
                className={!surface.editMode ? 'active' : ''}
                onClick={() => surfaceRef.current?.setEditMode(false)}
              >
                预览
              </button>
              <button
                type="button"
                className={surface.editMode ? 'active' : ''}
                onClick={() => surfaceRef.current?.setEditMode(true)}
              >
                编辑
              </button>
            </div>
          )}
          {surface.dirty && (
            <>
              <button className="ghost file-action" onClick={handleDiscard}>
                还原
              </button>
              <button
                className="file-save-action"
                onClick={() => void surfaceRef.current?.save()}
                disabled={surface.saving}
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
