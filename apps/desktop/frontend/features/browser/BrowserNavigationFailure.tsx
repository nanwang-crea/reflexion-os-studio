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
      <p>
        {blocked
          ? '目标域名解析到了私有或保留地址，网页尚未加载。'
          : failure.navigation.message}
      </p>
      {blocked && (
        <p>
          代理的 Fake-IP 可能导致公网检查不通过。请检查代理 DNS
          配置，让此域名返回真实公网地址后，再让 Agent 重新导航。
        </p>
      )}
      <details>
        <summary>详细原因</summary>
        <code>{failure.errorCode}</code>
        {blocked && <p>{failure.navigation.message}</p>}
      </details>
      <button type="button" onClick={onDismiss}>
        返回浏览器
      </button>
    </div>
  )
}
