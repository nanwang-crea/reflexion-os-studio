import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type {
  PluginInstallSource,
  PluginPackageManifest,
  PluginRecord,
  PluginTask,
} from '@reflexion-os-studio/runtime-client'
import { installPlugin, previewPlugin } from '../../api/skills'

interface PluginInstallerProps {
  busy: boolean
  onError: (message: string) => void
  tasks: Record<string, PluginTask>
  rememberTask: (task: PluginTask) => void
  cancelTask: (taskId: string) => Promise<void>
}

export function PluginInstaller(
  props: PluginInstallerProps,
): React.JSX.Element {
  const { busy, cancelTask, onError, rememberTask, tasks } = props
  const [gitUrl, setGitUrl] = useState('')
  const [source, setSource] = useState<PluginInstallSource | null>(null)
  const [manifest, setManifest] = useState<PluginPackageManifest | null>(null)
  const [installed, setInstalled] = useState<PluginRecord | null>(null)
  const [working, setWorking] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const inspect = useCallback(
    async (nextSource: PluginInstallSource): Promise<void> => {
      setWorking(true)
      setManifest(null)
      try {
        const result = await previewPlugin(nextSource)
        setSource(nextSource)
        setTaskId(result.task.id)
        rememberTask(result.task)
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
        setWorking(false)
      }
    },
    [onError, rememberTask],
  )

  const task = taskId === null ? null : (tasks[taskId] ?? null)
  useEffect(() => {
    if (task?.status === 'completed' && task.action === 'preview') {
      setManifest(task.manifest)
      setInstalled(task.installed)
      setWorking(false)
    } else if (task?.status === 'completed') {
      setSource(null)
      setManifest(null)
      setInstalled(null)
      setWorking(false)
    } else if (task?.status === 'failed') {
      onError(task.error ?? '插件任务失败')
      setWorking(false)
    } else if (task?.status === 'cancelled') {
      setWorking(false)
    }
  }, [onError, task])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return
        if (event.payload.type === 'enter') setDragging(true)
        if (event.payload.type === 'leave') setDragging(false)
        if (event.payload.type === 'drop') {
          setDragging(false)
          const [path] = event.payload.paths
          if (path) void inspect({ source: 'local', path })
        }
      })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [inspect])

  const chooseLocal = async (directory: boolean): Promise<void> => {
    const selected = await open({
      directory,
      multiple: false,
      title: directory ? '选择插件目录' : '选择 plugin.json 或 SKILL.md',
      filters: directory
        ? undefined
        : [{ name: 'Plugin package', extensions: ['json', 'md'] }],
    })
    if (typeof selected === 'string' && selected !== '') {
      await inspect({ source: 'local', path: selected })
    }
  }

  const confirmInstall = async (): Promise<void> => {
    if (source === null || manifest === null || installed !== null) return
    setWorking(true)
    try {
      const result = await installPlugin(source)
      setTaskId(result.task.id)
      rememberTask(result.task)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
      setWorking(false)
    }
  }

  return (
    <section className={`plugin-installer ${dragging ? 'dragging' : ''}`}>
      <div className="plugin-installer-head">
        <div>
          <h2>安装技能插件</h2>
          <p>
            拖入插件目录、plugin.json 或 SKILL.md，也可以选择本地包或公共 Git
            HTTPS 地址。
          </p>
        </div>
        <div className="plugin-local-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => void chooseLocal(false)}
          >
            选择文件
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void chooseLocal(true)}
          >
            选择目录
          </button>
        </div>
      </div>
      <form
        className="plugin-git-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (gitUrl.trim()) void inspect({ source: 'git', url: gitUrl.trim() })
        }}
      >
        <input
          type="url"
          value={gitUrl}
          placeholder="https://github.com/owner/skill-plugin.git"
          onChange={(event) => setGitUrl(event.target.value)}
        />
        <button
          type="submit"
          className="ghost"
          disabled={!gitUrl.trim() || working}
        >
          检查 Git 包
        </button>
      </form>
      {dragging && <div className="plugin-drop-hint">松开以检查插件包</div>}
      {task !== null &&
        !['completed', 'failed', 'cancelled'].includes(task.status) && (
          <div className="plugin-task-progress">
            <div>
              <span>{phaseLabel(task.phase)}</span>
              <strong>{task.progress}%</strong>
            </div>
            <progress max="100" value={task.progress} />
            <button
              type="button"
              className="ghost"
              onClick={() => void cancelTask(task.id)}
            >
              取消
            </button>
          </div>
        )}
      {manifest !== null && (
        <div className="plugin-preview">
          <div>
            <strong>{manifest.name}</strong> <code>v{manifest.version}</code>
            <p>{manifest.description}</p>
          </div>
          <dl>
            <div>
              <dt>类型</dt>
              <dd>{manifest.type}</dd>
            </div>
            <div>
              <dt>能力</dt>
              <dd>{manifest.capabilities.join('、')}</dd>
            </div>
            <div>
              <dt>文件</dt>
              <dd>{manifest.permissions.filesystem}</dd>
            </div>
            <div>
              <dt>网络</dt>
              <dd>{manifest.permissions.network ? '声明需要' : '不需要'}</dd>
            </div>
            <div>
              <dt>Shell</dt>
              <dd>{manifest.permissions.shell ? '声明需要' : '不需要'}</dd>
            </div>
          </dl>
          {installed === null ? (
            <button
              type="button"
              className="primary"
              disabled={working || busy}
              onClick={() => void confirmInstall()}
            >
              确认权限并安装
            </button>
          ) : (
            <div className="plugin-conflict">
              已安装 v{installed.version}。请从插件卡片执行来源一致的更新。
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function phaseLabel(phase: PluginTask['phase']): string {
  return {
    queued: '等待执行',
    resolving: '解析来源',
    downloading: '下载 Git 包',
    validating: '校验插件',
    staging: '准备安装',
    committing: '原子替换',
    reloading: '重新加载',
    completed: '已完成',
  }[phase]
}
