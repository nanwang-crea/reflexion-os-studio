import { memo, useCallback, useRef, useState } from 'react'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import { MarkdownCore } from '../../../components/markdown/md-core'
import {
  MonacoSurface,
  type MonacoSurfaceHandle,
  type MonacoSurfaceState,
} from '../editor/MonacoSurface'
import { normalizeRelativePath } from './links'
import { friendlyReadError, MD_PREVIEW_MAX_LINES } from './preview'
import { useMdIncrementalFeed } from './useMdIncrementalFeed'

/** 预览视图形态：默认富预览，可一键切换源码（源码即编辑）。 */
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
}

/**
 * Markdown 文件富预览：默认渲染富文本（与聊天消息同一套 react-markdown
 * 内核 MarkdownCore，支持 GFM 表格/任务列表/自动链接），头部可一键切换
 * 源码视图。富预览按块增量加载（useMdIncrementalFeed：首批 + 触底追加，
 * fence-aware 分块保证围栏/列表跨批不切散），达行数硬上限后停止并提示。
 * 源码视图为可编辑 Monaco（小文件默认可编辑，超限/截断自动只读），
 * 保存经 workspace.write_file 落盘，切回预览自动重读。
 * 预览内的资源引用：workspace:// 与指向工作区文件的相对路径链接
 * （含 ../ 目录跳跃）统一换算后经 onResourceClick 分发；图片预览
 * 与 MD 文内锚点属后续迭代，锚点当前点击吞掉、图片渲染为占位芯片。
 */
export function MarkdownFilePreview(
  props: MarkdownFilePreviewProps,
): React.JSX.Element {
  const { projectId, path, onResourceClick } = props
  const [mode, setMode] = useState<MarkdownPreviewViewMode>('preview')
  // 显式重载计数：进入预览（初始/从源码切回/保存后）都会重新读文件。
  const [reloadTick, setReloadTick] = useState(0)
  const [surfaceState, setSurfaceState] = useState<MonacoSurfaceState | null>(
    null,
  )
  const surfaceRef = useRef<MonacoSurfaceHandle>(null)
  const { feed, loading, error, loadingMore, sentinelRef } =
    useMdIncrementalFeed(projectId, path, reloadTick)

  const handleViewModeChange = useCallback(
    (next: MarkdownPreviewViewMode): void => {
      setMode(next)
      // 每次回到预览都重读文件，保证展示最新落盘内容；进入源码时清掉
      // 上一次挂载残留的 Surface 状态，避免脏标记闪现旧值。
      if (next === 'preview') {
        setReloadTick((tick) => tick + 1)
      } else {
        setSurfaceState(null)
      }
    },
    [],
  )

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
    (state: MonacoSurfaceState): void => setSurfaceState(state),
    [],
  )

  const fileName = path.split('/').pop() ?? path
  const previewBody =
    loading || feed === null ? (
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
        <span className="content-name" title={path}>
          {fileName}
        </span>
        <div className="md-view-toggle" role="tablist" aria-label="预览视图">
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
            源码
          </button>
        </div>
        {mode === 'preview' ? (
          <button
            className="ghost"
            onClick={() => setReloadTick((tick) => tick + 1)}
            disabled={loading}
            title="重新加载"
          >
            刷新
          </button>
        ) : (
          <>
            <button
              className={`ghost${surfaceState?.editMode ? ' active' : ''}`}
              onClick={() =>
                surfaceRef.current?.setEditMode(!surfaceState?.editMode)
              }
              disabled={surfaceState === null || !surfaceState.canEdit}
              title={
                surfaceState?.canEdit
                  ? surfaceState.editMode
                    ? '切换为只读'
                    : '切换为编辑'
                  : '文件过大或读取被截断，仅支持只读'
              }
            >
              {surfaceState?.editMode ? '编辑中' : '只读'}
            </button>
            {surfaceState?.dirty && (
              <button
                className="ghost"
                onClick={() => void surfaceRef.current?.save()}
                disabled={surfaceState.saving}
                title="保存"
              >
                {surfaceState.saving ? '保存中…' : '保存'}
              </button>
            )}
          </>
        )}
        {mode === 'preview' && error !== null && (
          <span className="content-error-inline">{error}</span>
        )}
      </header>
      {mode === 'source' ? (
        <div className="content-body md-source-body">
          <MonacoSurface
            projectId={projectId}
            path={path}
            ref={surfaceRef}
            onStateChange={handleSurfaceState}
          />
        </div>
      ) : (
        <div className="content-body md-preview-body">{previewBody}</div>
      )}
    </div>
  )
}
