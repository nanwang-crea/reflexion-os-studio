import type { BrowserNavigationCompletion } from '../../api/browser-navigation'
import './navigation-failure.css'

export function BrowserNavigationFailure({
  failure,
  onDismiss,
}: {
  failure: BrowserNavigationCompletion
  onDismiss: () => void
}) {
  const blocked = failure.errorCode === 'browser_network_denied'
  return (
    <div className="browser-navigation-failure" role="alert">
      <h3>{blocked ? '导航被拦截' : '导航未完成'}</h3>
      <p className="browser-navigation-target">{failure.navigation.url}</p>
      <p>{failure.navigation.message}</p>
      {blocked && (
        <p>此结果来自旧版网络检查。更新并重启应用后，可重新请求导航。</p>
      )}
      <details>
        <summary>详细原因</summary>
        <code>{failure.errorCode}</code>
      </details>
      <button type="button" onClick={onDismiss}>
        返回浏览器
      </button>
    </div>
  )
}
