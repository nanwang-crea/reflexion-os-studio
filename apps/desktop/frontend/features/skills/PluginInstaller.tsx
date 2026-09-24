import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type {
  PluginInstallSource,
  PluginPackageManifest,
  PluginRecord,
} from '@reflexion-os-studio/runtime-client'
import { installPlugin, previewPlugin } from '../../api/skills'

interface PluginInstallerProps {
  busy: boolean
  onInstalled: () => Promise<void>
  onError: (message: string) => void
}

export function PluginInstaller(
  props: PluginInstallerProps,
): React.JSX.Element {
  const { busy, onError, onInstalled } = props
  const [gitUrl, setGitUrl] = useState('')
  const [source, setSource] = useState<PluginInstallSource | null>(null)
  const [manifest, setManifest] = useState<PluginPackageManifest | null>(null)
  const [installed, setInstalled] = useState<PluginRecord | null>(null)
  const [working, setWorking] = useState(false)
  const [dragging, setDragging] = useState(false)

  const inspect = useCallback(
    async (nextSource: PluginInstallSource): Promise<void> => {
      setWorking(true)
      setManifest(null)
      try {
        const result = await previewPlugin(nextSource)
        setSource(nextSource)
        setManifest(result.manifest)
        setInstalled(result.installed)
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
      } finally {
        setWorking(false)
      }
    },
    [onError],
  )

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
      await installPlugin(source)
      setSource(null)
      setManifest(null)
      await onInstalled()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
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
