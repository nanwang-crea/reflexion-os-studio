import { useCallback, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import type { Project, ResourceLink } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { FolderIcon } from '../../ui/icons'
import { ContentView } from './ContentView'
import { DiffViewer } from './DiffViewer'
import { FileTabs } from './FileTabs'
import { MarkdownFilePreview } from './preview/MarkdownFilePreview'
import { BinaryFilePreview } from './preview/BinaryFilePreview'
import { getPreviewKind } from './preview/preview'
import type { MonacoSurfaceHandle } from './editor/MonacoSurface'
import type { OpenFileTab } from './types'
import { tabIdOf } from './types'

/** surface 句柄 getter：调用时解引用，规避 useImperativeHandle 重建导致的陈旧闭包。 */
type SurfaceGetter = () => MonacoSurfaceHandle | null

export interface FileViewerPanelHandle {
  /** 保存指定文件；句柄缺失（非文本标签/未挂载）或保存失败返回 false。 */
  saveDirty: (path: string) => Promise<boolean>
  /** 逐个保存所有脏文件，返回成功/失败清单（全部尝试，不提前终止）。 */
  saveAllDirty: () => Promise<{ saved: string[]; failed: string[] }>
}

interface FileViewerPanelProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件读取依赖它。 */
  systemReady: boolean
  /** 已打开的标签（有序，前端保证不重复）。 */
  openTabs: OpenFileTab[]
  /** 当前激活标签的 tabId（content=path / diff=path#diff）；null 表示无激活。 */
  activeTabId: string | null
  /** 已修改未保存的文件路径集合。 */
  dirtyPaths: Set<string>
  /** 以下回调一律携带 tabId（content=path / diff=path#diff），非 path。 */
  onSelectTab: (id: string) => void
  /** 关闭请求：经 App 层守卫（脏文件弹确认）后才真正 closeTab。 */
  onRequestCloseTab: (id: string) => void
  /** 拖拽排序完成后回调：ids 为新的 tabId 打开顺序。 */
  onReorderTabs: (ids: string[]) => void
  /** 编辑内核脏状态上抛（App 存入 dirtyPaths）。 */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** Markdown 源码→预览切换守卫用的应用级确认弹窗。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  /** 面板宽度（由 App 拖拽控制）。 */
  width?: number
  /** Markdown 预览内资源引用（相对路径 / workspace:// / asset://）分发。 */
  onResourceClick?: (link: ResourceLink) => void
  /** React 19 ref-as-prop：保存命令句柄（快捷键/守卫流程用）。 */
  ref?: Ref<FileViewerPanelHandle>
}

/**
 * 对话右侧的文件查看器：多文件标签 + 内容区。文本类标签（Monaco /
 * Markdown 预览）**保活**：全部保持挂载、非激活 display:none 隐藏，
 * 未保存内容跨标签切换存活（修复此前切换即卸载导致修改丢失的缺陷），
 * 后台脏标签也可经句柄保存。diff / binary 标签无脏状态，维持仅渲染
 * 激活项。关闭一律走 onRequestCloseTab（App 层守卫）。
 */
export function FileViewerPanel(
  props: FileViewerPanelProps,
): React.JSX.Element {
  const { project } = props
  const activeTab =
    props.openTabs.find((tab) => tabIdOf(tab) === props.activeTabId) ?? null
  // 仅当激活标签是 diff 时非空：narrow 到 const，规避闭包内 activeTab 收窄丢失。
  const diffTab =
    activeTab !== null && activeTab.mode === 'diff' ? activeTab : null

  const surfaceGettersRef = useRef(new Map<string, SurfaceGetter>())

  const registerSurface = useCallback(
    (path: string, getter: SurfaceGetter | null): void => {
      if (getter === null) surfaceGettersRef.current.delete(path)
      else surfaceGettersRef.current.set(path, getter)
    },
    [],
  )

  const saveDirty = useCallback(async (path: string): Promise<boolean> => {
    const getter = surfaceGettersRef.current.get(path)
    const handle = getter?.() ?? null
    if (handle === null) return false
    return handle.save()
  }, [])

  const saveAllDirty = useCallback(async (): Promise<{
    saved: string[]
    failed: string[]
  }> => {
    const saved: string[] = []
    const failed: string[] = []
    for (const path of props.dirtyPaths) {
      if (await saveDirty(path)) saved.push(path)
      else failed.push(path)
    }
    return { saved, failed }
  }, [props.dirtyPaths, saveDirty])

  useImperativeHandle(props.ref, () => ({ saveDirty, saveAllDirty }), [
    saveDirty,
    saveAllDirty,
  ])

  if (project === null) {
    return (
      <div className="workspace-panel" style={{ width: props.width }}>
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧选择项目后，可在这里浏览工作区文件。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-panel" style={{ width: props.width }}>
      {props.openTabs.length > 0 ? (
        <FileTabs
          openTabs={props.openTabs}
          activeTabId={props.activeTabId}
          dirtyPaths={props.dirtyPaths}
          onSelectTab={props.onSelectTab}
          onCloseTab={props.onRequestCloseTab}
          onReorderTabs={props.onReorderTabs}
        />
      ) : (
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧项目文件工作区中选择文件，可在右侧打开预览。</p>
        </div>
      )}

      {!props.systemReady && activeTab !== null && (
        <div className="workspace-degraded">
          工具 Runtime 不可用：文件预览暂不可用。
        </div>
      )}

      {props.openTabs.map((tab) => {
        if (tab.mode === 'diff') return null
        const kind = getPreviewKind(tab.path)
        if (kind === 'binary') return null
        const active = tabIdOf(tab) === props.activeTabId
        return (
          <div
            key={`${tab.path}#${tab.nonce ?? 0}`}
            className="workspace-tab-page"
            style={{ display: active ? 'flex' : 'none' }}
          >
            {kind === 'markdown' ? (
              <MarkdownFilePreview
                projectId={project.id}
                path={tab.path}
                onResourceClick={props.onResourceClick}
                onDirtyChange={props.onDirtyChange}
                registerSurface={registerSurface}
                confirm={props.confirm}
              />
            ) : (
              <ContentView
                projectId={project.id}
                path={tab.path}
                initialLine={tab.line}
                readOnly={false}
                onClose={() => props.onRequestCloseTab(tabIdOf(tab))}
                onDirtyChange={props.onDirtyChange}
                registerSurface={registerSurface}
              />
            )}
          </div>
        )
      })}

      {diffTab !== null && (
        <DiffViewer
          key={tabIdOf(diffTab)}
          projectId={project.id}
          path={diffTab.path}
          staged={diffTab.staged}
          oldPath={diffTab.oldPath}
          source={diffTab.source}
          before={diffTab.before}
          after={diffTab.after}
          onClose={() => props.onRequestCloseTab(tabIdOf(diffTab))}
        />
      )}

      {activeTab !== null &&
        activeTab.mode !== 'diff' &&
        getPreviewKind(activeTab.path) === 'binary' && (
          <BinaryFilePreview key={activeTab.path} path={activeTab.path} />
        )}
    </div>
  )
}
