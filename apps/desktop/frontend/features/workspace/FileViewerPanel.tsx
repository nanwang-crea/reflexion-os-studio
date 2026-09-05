import type { Project } from '@reflexion-os-studio/runtime-client'
import { FolderIcon } from '../../ui/icons'
import { ContentView } from './ContentView'
import type { OpenFileTab } from './types'

interface FileViewerPanelProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件读取依赖它。 */
  systemReady: boolean
  /** 已打开的标签（有序，前端保证不重复）。 */
  openTabs: OpenFileTab[]
  /** 当前激活标签的 path；null 表示无激活文件。 */
  activePath: string | null
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  /** 面板宽度（由 App 拖拽控制）。 */
  width?: number
}

/**
 * 对话右侧的文件查看器：多文件顶部标签 + 单个激活文件的只读预览。
 * 文件内容只经 workspace.read_file 获取（Rust 侧 workspace 边界校验）。
 * 打开哪个文件由左侧项目文件工作区决定（App 持有 openTabs 状态）。
 */
export function FileViewerPanel(
  props: FileViewerPanelProps,
): React.JSX.Element {
  const { project } = props
  const activeTab =
    props.openTabs.find((tab) => tab.path === props.activePath) ?? null

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
        <div className="file-tabs" role="tablist" aria-label="已打开文件">
          <div className="file-tabs-scroll">
            {props.openTabs.map((tab) => {
              const active = tab.path === props.activePath
              const fileName = tab.path.split('/').pop() ?? tab.path
              return (
                <div
                  key={tab.path}
                  className={`file-tab${active ? ' active' : ''}`}
                  role="tab"
                  aria-selected={active}
                >
                  <button
                    type="button"
                    className="file-tab-main"
                    title={tab.path}
                    onClick={() => props.onSelectTab(tab.path)}
                  >
                    {fileName}
                  </button>
                  <button
                    type="button"
                    className="file-tab-close"
                    title={`关闭 ${fileName}`}
                    aria-label={`关闭 ${fileName}`}
                    onClick={() => props.onCloseTab(tab.path)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </div>
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

      {activeTab !== null && (
        <div className="workspace-preview">
          <ContentView
            key={`${activeTab.path}#${activeTab.nonce ?? 0}`}
            projectId={project.id}
            path={activeTab.path}
            initialLine={activeTab.line}
            onClose={() => props.onCloseTab(activeTab.path)}
          />
        </div>
      )}
    </div>
  )
}
