import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * 顶层渲染错误边界：任何组件抛错时展示可读错误与重新加载入口，
 * 而不是整页白屏。错误信息同时写入 console 便于从 WebView 检查器定位。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const message = this.state.error.message || String(this.state.error)
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '40px 32px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#1f2328',
          background: '#fff',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18 }}>界面渲染出错</h1>
        <p style={{ margin: 0, color: '#57606a', fontSize: 13 }}>
          应用在渲染时遇到未处理的错误。可先重新加载；若反复出现，请把下面
          的错误信息反馈给开发者。
        </p>
        <pre
          style={{
            margin: 0,
            maxHeight: 240,
            overflow: 'auto',
            padding: 12,
            borderRadius: 8,
            background: '#f6f8fa',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message}
          {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => location.reload()}>
            重新加载
          </button>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(message)}
          >
            复制错误
          </button>
        </div>
      </div>
    )
  }
}
