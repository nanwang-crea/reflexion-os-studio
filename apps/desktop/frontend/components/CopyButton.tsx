import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from '../ui/icons'

interface CopyButtonProps {
  /** 点击后写入剪贴板的文本。 */
  text: string
  /** 应用到 <button> 的额外类名；默认复用消息操作钮样式。 */
  className?: string
}

/** 复制按钮：点击写剪贴板，成功短暂显示勾号后还原。用户/助手消息共用。 */
export function CopyButton({
  text,
  className = 'msg-action',
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 剪贴板不可用时静默失败，不打断阅读。
    }
  }

  return (
    <button
      type="button"
      className={className}
      title={copied ? '已复制' : '复制'}
      aria-label={copied ? '已复制' : '复制'}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  )
}
