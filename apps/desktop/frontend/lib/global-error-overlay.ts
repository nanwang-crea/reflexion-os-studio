/**
 * 非渲染期错误兜底（事件回调、异步任务）：渲染层错误由 ErrorBoundary
 * 捕获；这里避免未捕获异常让 WebView 留下纯白页面，并把错误显示出来。
 */
export function installGlobalErrorOverlay(): void {
  if (typeof window === 'undefined') return
  let shown = false
  const show = (detail: string): void => {
    console.error('[app] uncaught error:', detail)
    if (shown) return
    shown = true
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'alert')
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'gap:12px',
      'padding:32px',
      'background:#fff',
      'color:#1f2328',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:13px',
      'overflow:auto',
    ].join(';')
    const title = document.createElement('h1')
    title.textContent = '应用遇到未处理的错误'
    title.style.cssText = 'margin:0;font-size:18px'
    const body = document.createElement('pre')
    body.textContent = detail
    body.style.cssText =
      'margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f6f8fa;padding:12px;border-radius:8px;max-height:50vh;overflow:auto'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = '重新加载'
    reload.onclick = () => location.reload()
    reload.style.cssText =
      'align-self:flex-start;padding:6px 14px;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer'
    overlay.append(title, body, reload)
    document.body.append(overlay)
  }
  window.addEventListener('error', (event) => {
    show(
      event.error instanceof Error
        ? `${event.error.message}\n\n${event.error.stack ?? ''}`
        : event.message,
    )
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    show(
      reason instanceof Error
        ? `${reason.message}\n\n${reason.stack ?? ''}`
        : String(reason),
    )
  })
}
