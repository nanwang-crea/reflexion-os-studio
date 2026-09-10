// 全局轻提示（toast）：模块级事件总线 + 挂在 App 根部的 ToastHost。
// 用途：复制成功/失败等高频轻操作的可见反馈，非模态、自动消失、不打断输入。
import { useEffect, useRef, useState } from 'react'
import { AlertIcon, CheckIcon } from '../ui/icons'

export type ToastKind = 'success' | 'error'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

type Listener = (toast: ToastItem) => void

let nextId = 1
let seq = 0
const listeners = new Set<Listener>()
/** 同文案去重窗口（ms）：连续多次复制不堆叠同一条提示。 */
const DEDUP_WINDOW_MS = 1000
let lastShown: { message: string; at: number } | null = null

/** 供任意组件调用的全局入口：showToast('已复制到剪贴板')。 */
export function showToast(message: string, kind: ToastKind = 'success'): void {
  const now = Date.now()
  if (
    lastShown !== null &&
    lastShown.message === message &&
    now - lastShown.at < DEDUP_WINDOW_MS
  ) {
    return
  }
  lastShown = { message, at: now }
  const toast: ToastItem = { id: nextId++, kind, message }
  for (const listener of listeners) listener(toast)
}

/** 顶部居中（顶栏下方）浮层；无 toast 时不渲染任何节点。 */
export function ToastHost(): React.JSX.Element | null {
  const [items, setItems] = useState<ToastItem[]>([])
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    const listener: Listener = (toast) => {
      setItems((prev) => [...prev.slice(-2), toast])
      seq += 1
      const current = seq
      const timer = setTimeout(() => {
        timersRef.current.delete(timer)
        // 只移除自己这批之后仍未过期、且 id 匹配的条目，避免误删后到的提示。
        setItems((prev) => prev.filter((item) => item.id !== toast.id || item.id > current))
      }, 2400)
      timersRef.current.add(timer)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      for (const timer of timersRef.current) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.kind === 'error' ? (
            <AlertIcon size={14} />
          ) : (
            <CheckIcon size={14} />
          )}
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  )
}
