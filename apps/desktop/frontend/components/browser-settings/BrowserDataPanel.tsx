import { useEffect, useState } from 'react'
import type { BrowserVisit } from '@reflexion-os-studio/contracts'
import { listBrowserHistory, clearBrowserHistory } from '../../api/browser-data'
import { browserSession } from '../../api/browser'

export function BrowserDataPanel({ supported }: { supported: boolean }) {
  const [visits, setVisits] = useState<BrowserVisit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [website, setWebsite] = useState(false)
  const [cache, setCache] = useState(false)
  const [history, setHistory] = useState(false)
  useEffect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      void listBrowserHistory(query)
        .then((result) => {
          if (!disposed) {
            setVisits(result.visits)
            setHasMore(result.visits.length === 100)
          }
        })
        .catch((error) => {
          if (!disposed) setNotice(String(error))
        })
    }, 200)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [query])
  async function clear() {
    setBusy(true)
    setNotice('')
    try {
      if (website || cache) await browserSession.clearData(website, cache)
      if (history) await clearBrowserHistory()
      setVisits((await listBrowserHistory(query)).visits)
      setNotice('所选数据已清理')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="browser-settings-card" disabled={busy}>
      <legend>浏览数据与历史</legend>
      <p className="hint">
        清理网站数据会关闭普通浏览标签并创建全新存储，同时重置这些标签的缓存和登录状态；旧存储在下次启动时删除。Agent
        标签不受影响。密码需在密码管理中单独删除。
      </p>
      <label>
        <input
          type="checkbox"
          disabled={!supported}
          checked={website}
          onChange={(e) => setWebsite(e.target.checked)}
        />
        Cookie 与网站存储
      </label>
      <label>
        <input
          type="checkbox"
          disabled={!supported}
          checked={cache}
          onChange={(e) => setCache(e.target.checked)}
        />
        缓存
      </label>
      <label>
        <input
          type="checkbox"
          checked={history}
          onChange={(e) => setHistory(e.target.checked)}
        />
        本地历史
      </label>
      <button
        type="button"
        disabled={busy || !(website || cache || history)}
        onClick={() => void clear()}
      >
        清理所选数据
      </button>
      <label>
        搜索历史
        <input
          value={query}
          maxLength={500}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {visits.map((visit) => (
        <div key={visit.id}>
          <span>{visit.title || visit.url}</span> <span>{visit.origin}</span>
          <button
            type="button"
            onClick={() => {
              setBusy(true)
              void clearBrowserHistory(visit.origin)
                .then(() => listBrowserHistory(query))
                .then((result) => setVisits(result.visits))
                .catch((error) => setNotice(String(error)))
                .finally(() => setBusy(false))
            }}
          >
            删除此网站历史
          </button>
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={() => {
            setBusy(true)
            void listBrowserHistory(query, Number(visits.at(-1)?.id))
              .then((result) => {
                setVisits((previous) => [...previous, ...result.visits])
                setHasMore(result.visits.length === 100)
              })
              .catch((error) => setNotice(String(error)))
              .finally(() => setBusy(false))
          }}
        >
          加载更早记录
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  )
}
