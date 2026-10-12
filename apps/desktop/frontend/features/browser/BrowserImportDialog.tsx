import { useRef, useState } from 'react'
import { browserSurface } from '../../api/browser'
import { Select } from '../../components/forms/Select'
import { useModalDialog } from '../../hooks/ui/useModalDialog'

export function BrowserImportDialog({ onClose }: { onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, cancel)
  const [source, setSource] = useState<'chrome' | 'edge'>('chrome')
  const [profile, setProfile] = useState('Default')
  const [cookies, setCookies] = useState(true)
  const [passwords, setPasswords] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [entries, setEntries] = useState<
    Awaited<ReturnType<typeof browserSurface.credentials>>
  >([])
  async function run(operation: () => Promise<string>) {
    setBusy(true)
    setNotice(null)
    try {
      setNotice(await operation())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="dialog-overlay confirm-dialog-modal"
      aria-label="浏览器数据"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div
        className="dialog browser-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="浏览器数据"
      >
        <h3 className="dialog-title">从系统浏览器迁移</h3>
        <p className="dialog-message">
          当前支持 macOS 实验构建的 Chrome /
          Edge。请先关闭来源浏览器；系统可能要求钥匙串授权。
        </p>
        <label>
          来源浏览器
          <Select
            value={source}
            onValueChange={(value) => setSource(value as 'chrome' | 'edge')}
            disabled={busy}
            aria-label="来源浏览器"
          >
            <option value="chrome">Chrome</option>
            <option value="edge">Microsoft Edge</option>
          </Select>
        </label>
        <label>
          配置目录
          <input
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
            disabled={busy}
            placeholder="Default 或 Profile 1"
          />
        </label>
        <p className="browser-start-hint">
          默认配置为 Default；其他配置使用 Profile 1、Profile 2 等目录名。
        </p>
        <label>
          <input
            type="checkbox"
            checked={cookies}
            onChange={(event) => setCookies(event.target.checked)}
            disabled={busy}
          />{' '}
          Cookie（保存方式跟随当前会话设置）
        </label>
        <label>
          <input
            type="checkbox"
            checked={passwords}
            onChange={(event) => setPasswords(event.target.checked)}
            disabled={busy}
          />{' '}
          密码（保存在本应用系统钥匙串条目）
        </label>
        <p className="browser-start-hint">
          Agent 无法访问导入数据。分区和过期 Cookie、非 HTTPS
          密码会跳过，结果会显示数量；网站仍可能要求重新登录。
        </p>
        {notice && (
          <p role="status" className="dialog-message">
            {notice}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost"
            ref={cancel}
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (!cookies && !passwords)}
            onClick={() =>
              void run(async () => {
                const report = await browserSurface.importFromBrowser({
                  source,
                  profile,
                  cookies,
                  passwords,
                })
                return report.cancelled
                  ? report.notice
                  : `Cookie ${report.cookies} 条，密码 ${report.passwords} 条，跳过 ${report.skipped} 条。${report.notice}`
              })
            }
          >
            {busy ? '处理中…' : '迁移并请求系统授权'}
          </button>
        </div>
        <hr />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const changed = await browserSurface.managePassword('add')
              setEntries(await browserSurface.credentials())
              return changed ? '密码已保存' : '已取消'
            })
          }
        >
          添加网站密码（系统认证）…
        </button>
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await browserSurface.credentials()
                setEntries(next)
                return `已保存 ${next.length} 条密码`
              })
            }
          >
            查看导入密码的网站
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const cleared = await browserSurface.clearCredentials()
                if (cleared) setEntries([])
                return cleared ? '导入密码已删除' : '已取消删除'
              })
            }
          >
            删除导入密码
          </button>
        </div>
        {entries.length > 0 && (
          <div className="browser-password-list">
            {entries.map((entry) => (
              <div key={entry.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await browserSurface.fillCredential(entry.id)
                      return '已填入当前页面，请自行确认并提交'
                    })
                  }
                >
                  {entry.origin} · {entry.label} · 填入当前页面
                </button>
                {(['reveal', 'edit', 'delete'] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const changed = await browserSurface.managePassword(
                          kind,
                          entry.id,
                          entry.origin,
                        )
                        setEntries(await browserSurface.credentials())
                        return changed ? '操作已完成' : '已取消'
                      })
                    }
                  >
                    {{ reveal: '查看', edit: '编辑', delete: '删除' }[kind]}
                    （系统认证）…
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  )
}
