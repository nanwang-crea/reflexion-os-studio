// 输入框拖拽接入：双通道。
// 1) Tauri 原生通道（dragDropEnabled 默认 true）：拖入的是真实绝对路径，
//    经 Runtime `asset.read_dropped_file` 做凭据 no-read 与大小校验后读回字节；
// 2) 浏览器 DOM 通道：WebView 之外的 dev/预览环境，或同页内拖动的 File 对象，
//    直接拿 dataTransfer.files（本来就带字节），不需要经过 Runtime。
// 两条通道按运行环境互斥启用，避免同一次手势被重复添加。
import { MAX_MESSAGE_ATTACHMENTS } from '@reflexion-os-studio/runtime-client'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { readDroppedFile } from '../../api/assets'

/** 命中判定允许的越界容差（CSS px）：差几个像素松手也算丢进输入框。 */
const HIT_TOLERANCE = 12

/** 是否运行在 Tauri WebView 内（决定启用原生通道还是 DOM 通道）。 */
const IN_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface UseComposerFileDropOptions {
  /** 拖放命中范围：输入框容器。 */
  zoneRef: RefObject<HTMLElement | null>
  /** 禁用态（如正在发送）不接收拖入。 */
  disabled: boolean
  /** 当前还能再加几个附件，用于读取前的上限拦截。 */
  remainingSlots: number
  /** 读好的文件交给 attachments.add 做最终校验与入列。 */
  onFiles: (files: File[]) => void
}

export interface ComposerFileDropState {
  /** 拖拽正悬停在输入框范围内。 */
  dragging: boolean
  /** 正在从磁盘读取拖入文件。 */
  reading: boolean
  /** 最近一次拖入失败的原因（凭据拦截、类型不支持、读取失败等）。 */
  error: string | null
  clearError: () => void
}

/** base64 → File：与 <input type=file> 拿到的一致，后续链路无需分支。 */
function base64ToFile(
  base64: string,
  fileName: string,
  mimeType: string,
): File {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], fileName, { type: mimeType })
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function useComposerFileDrop(
  options: UseComposerFileDropOptions,
): ComposerFileDropState {
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dragover/原生 over 是高频事件，同值不重复 setState（React 会 bail out，
  // 但先挡住更省一次调度）。
  const draggingRef = useRef(false)

  // 订阅只接线一次，回调统一经 latest-ref 读当轮闭包（见性能纪律）。
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const clearError = useCallback(() => setError(null), [])

  useEffect(() => {
    const zone = options.zoneRef.current
    if (zone === null) return
    let disposed = false
    let unlisten: (() => void) | undefined
    let domCleanup: (() => void) | undefined

    const highlight = (next: boolean): void => {
      if (draggingRef.current === next) return
      draggingRef.current = next
      setDragging(next)
    }

    const insideZone = (position?: { x: number; y: number }): boolean => {
      const element = options.zoneRef.current
      if (element === null) return false
      if (position === undefined) return true
      const rect = element.getBoundingClientRect()
      // 原生事件坐标是物理像素，bounding box 是 CSS 像素。
      const ratio = window.devicePixelRatio || 1
      const x = position.x / ratio
      const y = position.y / ratio
      return (
        x >= rect.left - HIT_TOLERANCE &&
        x <= rect.right + HIT_TOLERANCE &&
        y >= rect.top - HIT_TOLERANCE &&
        y <= rect.bottom + HIT_TOLERANCE
      )
    }

    /** 原生通道：路径 → Runtime 读字节 → File。 */
    const readPaths = async (paths: string[]): Promise<void> => {
      highlight(false)
      if (disposed || paths.length === 0) return
      if (latest.current.disabled) return
      const remaining = latest.current.remainingSlots
      if (remaining <= 0) {
        setError(`每条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个文件（含图片）`)
        return
      }
      const accepted = paths.slice(0, remaining)
      const overflowed = paths.length > remaining
      setReading(true)
      setError(null)
      const files: File[] = []
      let failure: string | null = null
      for (const path of accepted) {
        try {
          const dropped = await readDroppedFile(path)
          if (disposed) return
          files.push(
            base64ToFile(dropped.base64, dropped.fileName, dropped.mimeType),
          )
        } catch (cause) {
          if (disposed) return
          failure ??= messageOf(cause, '拖入的文件读取失败')
        }
      }
      setReading(false)
      if (files.length > 0) latest.current.onFiles(files)
      if (failure !== null) setError(failure)
      else if (overflowed) {
        setError(`每条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个文件，多出的未添加`)
      }
    }

    if (IN_TAURI) {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (disposed) return
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') {
            highlight(!latest.current.disabled && insideZone(payload.position))
            return
          }
          if (payload.type === 'leave') {
            highlight(false)
            return
          }
          if (payload.type !== 'drop') return
          if (!insideZone(payload.position)) {
            highlight(false)
            return
          }
          void readPaths(payload.paths)
        })
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        })
        .catch(() => {
          // 原生通道不可用时降级到 DOM 通道；effect 已卸载则不接线，避免监听泄漏。
          if (!disposed && domCleanup === undefined) attachDomChannel(zone)
        })
    } else {
      attachDomChannel(zone)
    }

    /** DOM 通道：File 对象已带字节，直接入列。 */
    function attachDomChannel(target: HTMLElement): void {
      const hasFiles = (event: DragEvent): boolean =>
        event.dataTransfer?.types.includes('Files') ?? false

      const onDragOver = (event: DragEvent): void => {
        if (!hasFiles(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        if (!latest.current.disabled) highlight(true)
      }
      const onDragLeave = (event: DragEvent): void => {
        // 仍在子元素间移动时不熄灭高亮。
        const next = event.relatedTarget
        if (next instanceof Node && target.contains(next)) return
        highlight(false)
      }
      const onDrop = (event: DragEvent): void => {
        if (!hasFiles(event)) return
        event.preventDefault()
        highlight(false)
        if (disposed || latest.current.disabled) return
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length > 0) latest.current.onFiles(files)
      }
      // 手势在窗口外结束时清掉残留高亮。
      const resetHighlight = (): void => {
        if (!disposed) highlight(false)
      }

      target.addEventListener('dragenter', onDragOver)
      target.addEventListener('dragover', onDragOver)
      target.addEventListener('dragleave', onDragLeave)
      target.addEventListener('drop', onDrop)
      window.addEventListener('dragend', resetHighlight)
      window.addEventListener('blur', resetHighlight)
      domCleanup = () => {
        target.removeEventListener('dragenter', onDragOver)
        target.removeEventListener('dragover', onDragOver)
        target.removeEventListener('dragleave', onDragLeave)
        target.removeEventListener('drop', onDrop)
        window.removeEventListener('dragend', resetHighlight)
        window.removeEventListener('blur', resetHighlight)
      }
    }

    return () => {
      disposed = true
      domCleanup?.()
      unlisten?.()
    }
  }, [options.zoneRef])

  return { dragging, reading, error, clearError }
}
