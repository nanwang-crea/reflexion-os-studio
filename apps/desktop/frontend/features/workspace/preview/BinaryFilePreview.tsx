import { useEffect, useMemo, useState } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { readBinary, unwatchDir, watchDir } from '../../../api/workspace'
import { transport } from '../../../lib/transport'
import type { PreviewKind } from './preview'
import { formatBytes } from './preview'

interface BinaryFilePreviewProps {
  projectId: string
  path: string
  kind: Exclude<PreviewKind, 'markdown' | 'text'>
}

export function BinaryFilePreview(
  props: BinaryFilePreviewProps,
): React.JSX.Element {
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | {
        status: 'ready'
        dataUrl: string
        mimeType: string
        sizeBytes: number
      }
  >({ status: 'loading' })
  const directory = useMemo(() => parentDirectory(props.path), [props.path])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void readBinary(props.projectId, props.path)
      .then((result) => {
        if (cancelled) return
        setState({
          status: 'ready',
          dataUrl: `data:${result.mimeType};base64,${result.dataBase64}`,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [props.path, props.projectId, reload])

  useEffect(() => {
    let watchId: string | null = null
    let disposed = false
    void watchDir(props.projectId, directory)
      .then((result) => {
        if (disposed) void unwatchDir(result.watchId).catch(() => {})
        else watchId = result.watchId
      })
      .catch(() => {})
    const unlisten = transport.onEvent((event: RuntimeEvent) => {
      if (
        event.type === 'workspace.changed' &&
        event.projectId === props.projectId &&
        event.path === props.path
      ) {
        setReload((value) => value + 1)
      }
    })
    return () => {
      disposed = true
      unlisten()
      if (watchId !== null) void unwatchDir(watchId).catch(() => {})
    }
  }, [directory, props.path, props.projectId])

  const fileName = props.path.split('/').pop() ?? props.path
  if (state.status === 'loading') {
    return <div className="workspace-panel-empty">正在加载 {fileName}…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="workspace-panel-empty">
        <p>
          无法预览「{fileName}」：{state.message}
        </p>
      </div>
    )
  }
  if (props.kind === 'image') {
    return (
      <div className="binary-preview binary-preview-image">
        <img src={state.dataUrl} alt={fileName} />
        <span>{formatBytes(state.sizeBytes)}</span>
      </div>
    )
  }
  if (props.kind === 'pdf') {
    return (
      <object
        className="binary-preview-pdf"
        data={state.dataUrl}
        type={state.mimeType}
        aria-label={fileName}
      >
        <div className="workspace-panel-empty">
          当前 WebView 无法显示此 PDF。
        </div>
      </object>
    )
  }
  if (props.kind === 'audio') {
    return (
      <div className="binary-preview binary-preview-media">
        <audio controls src={state.dataUrl} aria-label={fileName} />
      </div>
    )
  }
  if (props.kind === 'video') {
    return (
      <div className="binary-preview binary-preview-media">
        <video controls src={state.dataUrl} aria-label={fileName} />
      </div>
    )
  }
  return (
    <div className="workspace-panel-empty">
      <p>「{fileName}」是二进制文件，暂不支持预览。</p>
    </div>
  )
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index) || '.'
}
