import { useEffect, useState } from 'react'
import { AlertIcon, CheckIcon, CopyIcon } from '../ui/icons'
import { copyTextToClipboard } from '../lib/clipboard'
import { showToast } from './Toast'

interface CopyButtonProps {
  /** 点击后写入剪贴板的文本。 */
  text: string
  /** 应用到 <button> 的类名；默认复用消息操作钮样式。 */
  className?: string
}

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * 复制按钮：走统一剪贴板通道（Tauri 插件 → Clipboard API → execCommand），
 * 成败均有 toast 反馈；成功短暂显示勾号、失败显示警示号后还原。
 * 用户/助手消息、代码块、表格复制共用（chat 与 workspace 预览两个模块）。
 */
export function CopyButton({
  text,
  className,
}: CopyButtonProps): React.JSX.Element {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(timer)
  }, [state])

  const copy = async (): Promise<void> => {
    const ok = await copyTextToClipboard(text)
    if (ok) {
      setState('copied')
      showToast('已复制到剪贴板')
    } else {
      setState('failed')
      showToast('复制失败，请重试', 'error')
    }
  }

  const label =
    state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'

  return (
    <button
      type="button"
      className={`copy-btn ${className ?? 'msg-action'}${
        state === 'failed' ? ' copy-failed' : ''
      }`}
      title={label}
      aria-label={label}
      onClick={() => void copy()}
    >
      {state === 'copied' ? (
        <CheckIcon size={13} />
      ) : state === 'failed' ? (
        <AlertIcon size={13} />
      ) : (
        <CopyIcon size={13} />
      )}
    </button>
  )
}
