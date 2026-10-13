import { useBrowserRuntime } from './useBrowserRuntime'
export function BrowserRuntimePanel(): React.JSX.Element {
  const { runtime, busy, error, act, downloading } = useBrowserRuntime()
  const installed = runtime?.state === 'installed'
  return (
    <section className="browser-settings-card" aria-label="浏览器组件">
      <h4>受管 Chromium（可选）</h4>
      <p className="hint">
        可复用本机 Chrome，或按需下载受管
        Chromium。普通内嵌浏览器无需下载。组件下载后保存在本机，关闭工具开关不会删除组件。
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
          : runtime.error === 'runtime-unavailable'
            ? '浏览器组件管理程序不可用，请重新安装应用。'
            : installed
              ? '已安装'
              : downloading
                ? runtime.phase === 'verify'
                  ? '正在验证浏览器组件…'
                  : '正在下载浏览器组件…'
                : runtime.state === 'failed'
                  ? runtime.error === 'download-cancelled'
                    ? '下载已取消'
                    : '下载失败，请检查网络和磁盘空间后重试。'
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
            disabled={
              busy || !runtime || runtime.error === 'runtime-unavailable'
            }
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
