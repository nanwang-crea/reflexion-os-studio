import { useCallback, useEffect, useState } from 'react'
import type { AgentBrowserRuntime } from '@reflexion-os-studio/contracts'
import {
  getAgentBrowserRuntime,
  installAgentBrowserRuntime,
  cancelAgentBrowserRuntime,
} from '../../../api/agent-browser-settings'

export function BrowserRuntimePanel(): React.JSX.Element {
  const [runtime, setRuntime] = useState<AgentBrowserRuntime | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void getAgentBrowserRuntime()
      .then((result) => {
        if (active) setRuntime(result)
      })
      .catch(() => {
        if (active) setError('无法读取浏览器组件状态，请重新检查。')
      })
    return () => {
      active = false
    }
  }, [])
  const downloading = runtime?.state === 'downloading'
  useEffect(() => {
    if (!downloading) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await getAgentBrowserRuntime()
        if (active) {
          setRuntime(result)
          setError(null)
        }
      } catch {
        if (active) setError('暂时无法读取下载进度。')
      }
      if (active) timer = setTimeout(() => void refresh(), 1000)
    }
    timer = setTimeout(() => void refresh(), 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [downloading])
  const act = useCallback(async (action: 'install' | 'cancel' | 'refresh') => {
    setBusy(true)
    setError(null)
    try {
      setRuntime(
        await (action === 'install'
          ? installAgentBrowserRuntime()
          : action === 'cancel'
            ? cancelAgentBrowserRuntime()
            : getAgentBrowserRuntime()),
      )
    } catch {
      setError('操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }, [])
  const installed = runtime?.state === 'installed'
  return (
    <section className="browser-settings-card" aria-label="浏览器组件">
      <h4>受管 Chromium（可选）</h4>
      <p className="hint">
        按需下载 Chromium，只有使用 Agent
        浏览网页才需要。普通内嵌浏览器无需下载。组件下载后保存在本机，关闭工具开关不会删除组件。
      </p>
      {runtime && (
        <p className="hint">
          {runtime.systemChromeAvailable
            ? '已检测到本机 Chrome，自动模式下无需下载。'
            : '未在常见安装位置检测到本机 Chrome，可点击下载受管 Chromium。'}
        </p>
      )}
      <p role="status" aria-live="polite">
        {!runtime
          ? '正在检查组件状态…'
          : installed
            ? '已安装'
            : downloading
              ? runtime.phase === 'verify'
                ? '正在验证浏览器组件…'
                : '正在下载浏览器组件…'
              : runtime.state === 'failed'
                ? runtime.error === 'download-cancelled'
                  ? '下载已取消'
                  : '下载失败，请检查网络后重试。'
                : '未安装'}
      </p>
      {downloading && (
        <>
          <progress
            aria-label="当前组件下载进度"
            max={100}
            value={runtime?.progress ?? undefined}
          />
          {runtime?.progress != null && (
            <span>当前组件 {runtime.progress}%</span>
          )}
        </>
      )}
      <div className="form-actions">
        {!installed && !downloading && (
          <button
            className="primary"
            disabled={busy || !runtime}
            onClick={() => void act('install')}
          >
            {runtime?.state === 'failed' ? '重新下载' : '下载浏览器组件'}
          </button>
        )}
        {downloading && (
          <button
            className="ghost"
            disabled={busy}
            onClick={() => void act('cancel')}
          >
            取消下载
          </button>
        )}
        <button
          className="ghost"
          disabled={busy}
          onClick={() => void act('refresh')}
        >
          重新检查
        </button>
      </div>
      <p className="hint">
        下载需要联网及较多磁盘空间；不使用此能力时无需安装。Linux
        可能还需要系统浏览器依赖库。
      </p>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </section>
  )
}
