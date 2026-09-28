import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../../components/ConfirmDialog'
import { MarkdownCore } from '../../../components/markdown/md-core'
import {
  MonacoSurface,
  type MonacoSurfaceHandle,
  type MonacoSurfaceState,
} from '../editor/MonacoSurface'
import { normalizeRelativePath } from './links'
import { friendlyReadError, MD_PREVIEW_MAX_LINES } from './preview'
import { IS_MAC } from '../../../lib/platform'
import { useMdIncrementalFeed } from './useMdIncrementalFeed'
import { useSaveFeedback } from '../editor/useSaveFeedback'

/** 预览视图形态：默认富预览，可无损切换到编辑器。 */
export type MarkdownPreviewViewMode = 'preview' | 'source'

/** 块级 memo：text 不变的块在追加加载时不重渲染。 */
const MemoMdBlock = memo(function MemoMdBlock(props: {
  text: string
  onResourceClick?: (link: ResourceLink) => void
}): React.JSX.Element {
  return (
    <MarkdownCore
      text={props.text}
      bare
      onResourceClick={props.onResourceClick}
    />
  )
})

interface MarkdownFilePreviewProps {
  projectId: string
  path: string
  /** 资源引用（workspace:// asset:// https://）点击回调；宿主按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
  /** 编辑内核脏状态上抛。 */
  onDirtyChange?: (path: string, dirty: boolean) => void
  /** 注册 surface 句柄 getter（null 注销），供标签层保存/守卫使用。 */
  registerSurface?: (
    path: string,
    getter: (() => MonacoSurfaceHandle | null) | null,
  ) => void
  /** 应用级确认弹窗（promise 风格），还原草稿时使用。 */
  confirm?: (state: ConfirmDialogState) => Promise<boolean>
}

/**
 * Markdown 文件富预览：默认渲染富文本（与聊天消息同一套 react-markdown
 * 内核 MarkdownCore，支持 GFM 表格/任务列表/自动链接），头部可一键切换
 * 编辑视图。富预览按块增量加载（useMdIncrementalFeed：首批 + 触底追加，
 * fence-aware 分块保证围栏/列表跨批不切散），达行数硬上限后停止并提示。
 * 编辑视图为可编辑 Monaco（小文件默认可编辑，超限/截断自动只读），
 * 保存经 workspace.write_file 落盘。编辑器打开后保持挂载，预览未保存
 * 草稿时直接渲染内存内容，模式切换不会丢失修改。
 * 预览内的资源引用：workspace:// 与指向工作区文件的相对路径链接
 * （含 ../ 目录跳跃）统一换算后经 onResourceClick 分发；图片预览
 * 与 MD 文内锚点属后续迭代，锚点当前点击吞掉、图片渲染为占位芯片。
 */
export function MarkdownFilePreview(
  props: MarkdownFilePreviewProps,
): React.JSX.Element {
  const { projectId, path, onResourceClick, confirm, onDirtyChange } = props
  const [mode, setMode] = useState<MarkdownPreviewViewMode>('preview')
  const [editorOpened, setEditorOpened] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  // 显式重载计数：用户刷新或保存后重新读文件。
  const [reloadTick, setReloadTick] = useState(0)
  const [surfaceState, setSurfaceState] = useState<MonacoSurfaceState | null>(
    null,
  )
  const surfaceRef = useRef<MonacoSurfaceHandle>(null)
  const wasDirtyRef = useRef(false)
  const { feed, loading, error, loadingMore, sentinelRef } =
    useMdIncrementalFeed(projectId, path, reloadTick)

  const fileName = path.split('/').pop() ?? path
  const savedRecently = useSaveFeedback(surfaceState?.saveVersion ?? 0)

  const handleViewModeChange = useCallback(
    (next: MarkdownPreviewViewMode): void => {
      if (next === mode) return
      if (next === 'source') setEditorOpened(true)
      setMode(next)
    },
    [mode],
  )

  const handleDiscard = useCallback((): void => {
    if (surfaceState?.dirty !== true) return
    void (async () => {
      const confirmed =
        confirm === undefined ||
        (await confirm({
          title: '还原未保存的修改？',
          message: `${fileName} 将恢复为上次保存的内容。`,
          confirmLabel: '还原修改',
          danger: true,
        }))
      if (!confirmed) return
      surfaceRef.current?.discardChanges()
      setDraft(null)
    })()
  }, [confirm, fileName, surfaceState?.dirty])

  const handleSave = useCallback(async (): Promise<void> => {
    const saved = await surfaceRef.current?.save()
    if (saved) {
      setDraft(null)
      setReloadTick((tick) => tick + 1)
    }
  }, [])

  const handleReload = useCallback((): void => {
    void (async () => {
      const confirmed =
        surfaceState?.dirty !== true ||
        confirm === undefined ||
        (await confirm({
          title: '重新加载磁盘内容？',
          message: `${fileName} 已在外部发生变化。重新加载会放弃当前未保存的修改。`,
          confirmLabel: '重新加载',
          danger: true,
        }))
      if (!confirmed) return
      setDraft(null)
      surfaceRef.current?.reloadFromDisk()
      setReloadTick((tick) => tick + 1)
    })()
  }, [confirm, fileName, surfaceState?.dirty])

  // Cmd/Ctrl+S 由 MonacoSurface 内部处理；观察 dirty 回落，同步刷新富预览。
  useEffect(() => {
    const isDirty = surfaceState?.dirty === true
    if (wasDirtyRef.current && !isDirty && draft !== null) {
      setDraft(null)
      setReloadTick((tick) => tick + 1)
    }
    wasDirtyRef.current = isDirty
  }, [draft, surfaceState?.dirty])

  // 编辑器在干净状态下检测到外部更新时，富预览同步刷新磁盘内容。
  useEffect(() => {
    if ((surfaceState?.externalReloadVersion ?? 0) === 0) return
    setReloadTick((tick) => tick + 1)
  }, [surfaceState?.externalReloadVersion])

  // 资源引用分发：workspace:// 缺省项目 / 指向其他项目时归一到当前
  // 项目再交给宿主路由器（与聊天消息同一条分发链路）。
  const handleResourceClick = useCallback(
    (link: ResourceLink): void => {
      if (link.kind !== 'workspaceFile') {
        onResourceClick?.(link)
        return
      }
      onResourceClick?.(
        link.projectId === '' || link.projectId === projectId
          ? { ...link, projectId }
          : link,
      )
    },
    [onResourceClick, projectId],
  )

  // 容器级捕获拦截（先于锚点默认行为）：
  // - 文内锚点（#…）点击吞掉，锚点定位属后续迭代；
  // - 相对路径链接（./ ../ sub/x.md /root）换算为 workspaceFile 引用
  //   后分发，与聊天消息同一条链路在右侧面板打开目标文件；
  // - 无法解析为工作区文件的外链（http 等）保留浏览器默认行为。
  const handlePreviewClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const anchor = (event.target as HTMLElement | null)?.closest('a')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = anchor.getAttribute('href')
      if (href === null || href === '') return
      if (href.startsWith('#')) {
        event.preventDefault()
        return
      }
      const resolved = normalizeRelativePath(path, href)
      if (resolved === null) return
      event.preventDefault()
      event.stopPropagation()
      handleResourceClick({
        kind: 'workspaceFile',
        uri: workspaceFileUri(projectId, resolved),
        projectId,
        path: resolved,
      })
    },
    [handleResourceClick, path, projectId],
  )

  const handleSurfaceState = useCallback(
    (state: MonacoSurfaceState): void => {
      setSurfaceState(state)
      onDirtyChange?.(path, state.dirty)
    },
    [onDirtyChange, path],
  )

  const { registerSurface } = props
  useEffect(() => {
    registerSurface?.(path, () => surfaceRef.current)
    return () => registerSurface?.(path, null)
  }, [path, registerSurface])

  const previewBody =
    surfaceState?.dirty === true && draft !== null ? (
      <div
        className="md-preview-scroll md-draft-preview"
        onClickCapture={handlePreviewClick}
      >
        <div className="md">
          <MarkdownCore
            text={draft}
            bare
            onResourceClick={handleResourceClick}
          />
        </div>
      </div>
    ) : loading || feed === null ? (
      <div className="content-hint">加载中…</div>
    ) : error !== null && feed.blocks.length === 0 ? (
      <div className="content-hint">{friendlyReadError(error)}</div>
    ) : (
      <div className="md-preview-scroll" onClickCapture={handlePreviewClick}>
        {feed.blocks.length === 0 && feed.exhausted && (
          <div className="content-hint">空文件</div>
        )}
        <div className="md">
          {feed.blocks.map((block, index) => (
            <MemoMdBlock
              key={index}
              text={block}
              onResourceClick={handleResourceClick}
            />
          ))}
        </div>
        {!feed.exhausted && (
          <div className="md-preview-more" ref={sentinelRef}>
            {loadingMore ? '加载中…' : '下滑加载更多'}
          </div>
        )}
        {feed.capReached && (
          <div className="content-hint">
            已达富预览行数上限（{MD_PREVIEW_MAX_LINES.toLocaleString()} 行），
            后续内容未加载。
          </div>
        )}
      </div>
    )

  return (
    <div className="content-view">
      <header className="content-head">
        <div className="content-head-main">
          {surfaceState?.externalChanged ? (
            <span className="content-conflict-status">磁盘内容已变化</span>
          ) : surfaceState?.dirty ? (
            <span className="content-edit-status">未保存</span>
          ) : savedRecently ? (
            <span className="content-save-status">已保存</span>
          ) : null}
        </div>
        <div className="file-mode-switch" role="tablist" aria-label="文件模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => handleViewModeChange('preview')}
          >
            预览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className={mode === 'source' ? 'active' : ''}
            onClick={() => handleViewModeChange('source')}
          >
            编辑
          </button>
        </div>
        {surfaceState?.externalChanged ? (
          <button className="ghost file-action" onClick={handleReload}>
            重新加载
          </button>
        ) : surfaceState?.dirty ? (
          <>
            <button className="ghost file-action" onClick={handleDiscard}>
              还原
            </button>
            <button
              className="file-save-action"
              onClick={() => void handleSave()}
              disabled={surfaceState.saving}
              title={IS_MAC ? '保存（⌘S）' : '保存（Ctrl+S）'}
            >
              {surfaceState.saving ? '保存中…' : '保存'}
            </button>
          </>
        ) : mode === 'preview' ? (
          <button
            className="ghost file-action"
            onClick={() => setReloadTick((tick) => tick + 1)}
            disabled={loading}
            title="重新加载"
          >
            刷新
          </button>
        ) : null}
        {mode === 'preview' && error !== null && (
          <span className="content-error-inline">{error}</span>
        )}
      </header>
      {editorOpened && (
        <div
          className="content-body md-source-body"
          style={{ display: mode === 'source' ? 'flex' : 'none' }}
        >
          <MonacoSurface
            projectId={projectId}
            path={path}
            ref={surfaceRef}
            onStateChange={handleSurfaceState}
            onContentChange={setDraft}
          />
        </div>
      )}
      {mode === 'preview' && (
        <div className="content-body md-preview-body">{previewBody}</div>
      )}
    </div>
  )
}
