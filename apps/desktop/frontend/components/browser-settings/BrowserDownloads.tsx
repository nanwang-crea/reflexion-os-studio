import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import type {
  BrowserDownload,
  BrowserSettings,
} from '@reflexion-os-studio/contracts'
import { browserSurface } from '../../api/browser'
export function BrowserDownloads({
  settings,
  supported,
  save,
}: {
  settings: BrowserSettings
  supported: boolean
  save: (settings: BrowserSettings) => Promise<void>
}) {
  const [records, setRecords] = useState<BrowserDownload[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const active = records.some(
    (r) => r.status === 'active' || r.status === 'pending',
  )
  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void browserSurface
      .subscribeDownloads(() => {
        void browserSurface
          .downloads()
          .then((r) => {
            if (!disposed) setRecords(r)
          })
          .catch((error) => {
            if (!disposed) setNotice(String(error))
          })
      })
      .then((cleanup) => {
        if (disposed) cleanup()
        else unlisten = cleanup
      })
      .catch((error) => {
        if (!disposed) setNotice(String(error))
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [supported])
  useEffect(() => {
    if (!supported) return
    let disposed = false
    void browserSurface
      .downloads()
      .then((r) => {
        if (!disposed) setRecords(r)
      })
      .catch((e) => {
        if (!disposed) setNotice(String(e))
      })
    return () => {
      disposed = true
    }
  }, [supported])
  useEffect(() => {
    if (!active) return
    let disposed = false
    const timer = setTimeout(() => {
      void browserSurface
        .downloads()
        .then((r) => {
          if (!disposed) setRecords(r)
        })
        .catch((e) => {
          if (!disposed) setNotice(String(e))
        })
    }, 1000)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [active, records])
  async function action(id: number, kind: 'cancel' | 'remove' | 'reveal') {
    setBusy(true)
    try {
      setRecords(await browserSurface.downloadAction(id, kind))
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="browser-settings-card" disabled={busy || !supported}>
      <legend>下载</legend>
      <p className="hint">
        下载不自动执行；暂存后安全发布到目录。现有文件不会被覆盖，请选择新名称。记录仅保留到应用退出，删除记录不会删除文件。
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings.askDownloadLocation}
          onChange={(event) =>
            void save({
              ...settings,
              askDownloadLocation: event.target.checked,
            })
          }
        />
        每次询问保存位置
      </label>
      <p>{settings.downloadDirectory ?? '系统下载目录'}</p>
      <button
        type="button"
        onClick={() => {
          void open({ directory: true, multiple: false })
            .then((path) => {
              if (typeof path === 'string')
                return save({ ...settings, downloadDirectory: path })
            })
            .catch((error) => setNotice(String(error)))
        }}
      >
        选择目录
      </button>
      <button
        type="button"
        onClick={() => void save({ ...settings, downloadDirectory: null })}
      >
        恢复系统目录
      </button>
      <button
        type="button"
        onClick={() =>
          void browserSurface
            .downloads()
            .then(setRecords)
            .catch((error) => setNotice(String(error)))
        }
      >
        刷新记录
      </button>
      {records.map((record) => (
        <div key={record.id}>
          {record.filename} · {record.status} · {record.receivedBytes}
          {record.totalBytes ? ` / ${record.totalBytes}` : ''} 字节{' '}
          {record.notice}
          {record.status === 'active' || record.status === 'pending' ? (
            <button
              type="button"
              onClick={() => void action(record.id, 'cancel')}
            >
              取消
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void action(record.id, 'remove')}
            >
              删除记录
            </button>
          )}
          {record.status === 'completed' && (
            <button
              type="button"
              onClick={() => void action(record.id, 'reveal')}
            >
              在文件管理器中显示
            </button>
          )}
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  )
}
